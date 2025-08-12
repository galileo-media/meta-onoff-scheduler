import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import cron from 'node-cron';
import fs from 'fs-extra';
import dayjs from 'dayjs';

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_DIR = new URL('./data/', import.meta.url).pathname;
const RULES_PATH = new URL('./data/rules.json', import.meta.url).pathname;

await fs.ensureDir(DATA_DIR);
if (!(await fs.pathExists(RULES_PATH))) {
  await fs.writeJson(RULES_PATH, { rules: [] });
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_BUSINESS_ID = process.env.META_BUSINESS_ID || '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ACCOUNT_TIMEZONE_DEFAULT = process.env.ACCOUNT_TIMEZONE_DEFAULT || 'UTC';

const schedulers = new Map();

function readRules() {
  return fs.readJson(RULES_PATH);
}

async function writeRules(data) {
  await fs.writeJson(RULES_PATH, data);
}

async function postSlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch {}
}

function cronForTime(t, tz) {
  const [hh, mm] = t.split(':').map(x => parseInt(x, 10));
  const m = isNaN(mm) ? 0 : mm;
  const h = isNaN(hh) ? 0 : hh;
  return { expr: `${m} ${h} * * *`, tz };
}

async function listOwnedAdAccounts() {
  if (!META_ACCESS_TOKEN || !META_BUSINESS_ID) {
    return { error: 'missing_credentials' };
  }
  const url = new URL(`https://graph.facebook.com/v23.0/${META_BUSINESS_ID}/owned_ad_accounts`);
  url.searchParams.set('fields', ['account_id', 'name', 'timezone_name', 'timezone_offset_hours_utc'].join(','));
  url.searchParams.set('access_token', META_ACCESS_TOKEN);
  try {
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) {
      await postSlack(`Meta API error listing accounts: ${JSON.stringify(json)}`);
      return { error: 'meta_error', detail: json };
    }
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map(x => ({
      id: x.account_id || x.id || '',
      name: x.name || '',
      timezone_name: x.timezone_name || ACCOUNT_TIMEZONE_DEFAULT,
      timezone_offset_hours_utc: typeof x.timezone_offset_hours_utc === 'number' ? x.timezone_offset_hours_utc : null
    }));
  } catch (e) {
    await postSlack(`Meta API request failure: ${String(e)}`);
    return { error: 'network_error' };
  }
}

async function setStatusOnObjects(level, ids, status) {
  const results = [];
  for (const id of ids) {
    const url = new URL(`https://graph.facebook.com/v23.0/${id}`);
    url.searchParams.set('access_token', META_ACCESS_TOKEN);
    const body = new URLSearchParams();
    body.set('status', status);
    try {
      const res = await fetch(url.toString(), { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) {
        results.push({ id, ok: false, error: json });
        await postSlack(`Meta API status update failed for ${level} ${id}: ${JSON.stringify(json)}`);
      } else {
        results.push({ id, ok: true, result: json });
      }
    } catch (e) {
      results.push({ id, ok: false, error: String(e) });
      await postSlack(`Meta API request failed for ${level} ${id}: ${String(e)}`);
    }
  }
  return results;
}

async function findTargetsByName(accountId, level, nameContains) {
  const node = level === 'campaign' ? 'campaigns' : 'adsets';
  const base = new URL(`https://graph.facebook.com/v23.0/act_${accountId}/${node}`);
  base.searchParams.set('fields', 'id,name,effective_status,configured_status');
  base.searchParams.set('limit', '500');
  base.searchParams.set('access_token', META_ACCESS_TOKEN);

  const out = [];
  let url = base.toString();
  for (let i = 0; i < 10 && url; i++) {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) {
      await postSlack(`Meta API list ${node} failed: ${JSON.stringify(json)}`);
      break;
    }
    const data = Array.isArray(json.data) ? json.data : [];
    for (const it of data) {
      if (!nameContains || (it.name || '').toLowerCase().includes(nameContains.toLowerCase())) {
        out.push(it.id);
      }
    }
    url = json.paging && json.paging.next ? json.paging.next : null;
  }
  return out;
}

function inActiveWindow(rule, now) {
  const n = dayjs(now);
  const day = n.day();
  if (!rule.days || !Array.isArray(rule.days) || rule.days.length === 0) return true;
  if (!rule.days.includes(day)) return false;
  const t = (s) => {
    const [h, m] = s.split(':').map(v => parseInt(v, 10));
    return h * 60 + m;
  };
  const mins = n.hour() * 60 + n.minute();
  const start = t(rule.start);
  const stop = t(rule.stop);
  if (start === stop) return false;
  if (start < stop) {
    return mins >= start && mins < stop;
  }
  return !(mins >= stop && mins < start);
}

async function enforceRule(rule) {
  const now = dayjs();
  const desiredActive = inActiveWindow(rule, now);
  const status = desiredActive ? 'ACTIVE' : 'PAUSED';
  const ids = rule.ids && rule.ids.length > 0 ? rule.ids : await findTargetsByName(rule.account_id, rule.level, rule.name_contains || '');
  await setStatusOnObjects(rule.level, ids, status);
}

function unschedule(id) {
  const set = schedulers.get(id);
  if (set) {
    for (const job of set) job.stop();
    schedulers.delete(id);
  }
}

function scheduleRule(rule) {
  unschedule(rule.id);
  const tz = rule.tz || ACCOUNT_TIMEZONE_DEFAULT;
  const s1 = cronForTime(rule.stop, tz);
  const s2 = cronForTime(rule.start, tz);
  const job1 = cron.schedule(s1.expr, async () => {
    const ids = rule.ids && rule.ids.length > 0 ? rule.ids : await findTargetsByName(rule.account_id, rule.level, rule.name_contains || '');
    await setStatusOnObjects(rule.level, ids, 'PAUSED');
  }, { timezone: tz });
  const job2 = cron.schedule(s2.expr, async () => {
    const ids = rule.ids && rule.ids.length > 0 ? rule.ids : await findTargetsByName(rule.account_id, rule.level, rule.name_contains || '');
    await setStatusOnObjects(rule.level, ids, 'ACTIVE');
  }, { timezone: tz });
  const every = Math.max(1, Math.min(60, parseInt(rule.enforce_every || '5', 10)));
  const job3 = cron.schedule(`*/${every} * * * *`, async () => {
    await enforceRule(rule);
  }, { timezone: tz });
  schedulers.set(rule.id, [job1, job2, job3]);
}

async function bootstrapSchedules() {
  const { rules } = await readRules();
  for (const r of rules) scheduleRule(r);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/accounts', async (req, res) => {
  const data = await listOwnedAdAccounts();
  res.json(data);
});

app.get('/api/rules', async (req, res) => {
  const data = await readRules();
  res.json(data.rules);
});

app.post('/api/rules', async (req, res) => {
  const b = req.body || {};
  const id = `r_${Date.now()}`;
  const rule = {
    id,
    account_id: String(b.account_id || ''),
    level: b.level === 'adset' ? 'adset' : 'campaign',
    ids: Array.isArray(b.ids) ? b.ids.map(String) : [],
    name_contains: b.name_contains ? String(b.name_contains) : '',
    stop: String(b.stop || '23:00'),
    start: String(b.start || '00:01'),
    tz: String(b.tz || ACCOUNT_TIMEZONE_DEFAULT),
    days: Array.isArray(b.days) ? b.days.map(n => parseInt(n, 10)) : [0,1,2,3,4,5,6],
    enforce_every: parseInt(b.enforce_every || '5', 10)
  };
  const data = await readRules();
  data.rules.push(rule);
  await writeRules(data);
  scheduleRule(rule);
  res.json(rule);
});

app.delete('/api/rules/:id', async (req, res) => {
  const rid = req.params.id;
  const data = await readRules();
  const idx = data.rules.findIndex(r => r.id === rid);
  if (idx >= 0) {
    const [r] = data.rules.splice(idx, 1);
    await writeRules(data);
    unschedule(rid);
    res.json({ ok: true, removed: r });
  } else {
    res.status(404).json({ error: 'not_found' });
  }
});

app.post('/api/test-slack', async (req, res) => {
  const text = (req.body && req.body.text) || 'Test alert';
  await postSlack(text);
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  await bootstrapSchedules();
});
