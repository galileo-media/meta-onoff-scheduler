import express from 'express';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import axios from 'axios';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

const CREDS = JSON.parse(process.env.META_CREDENTIALS_JSON || '[]'); // [{business_id, access_token, timezone}]
const DEFAULT_TZ = process.env.ACCOUNT_TIMEZONE_DEFAULT || 'Asia/Jerusalem';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
if (!CREDS.length) console.warn('[WARN] META_CREDENTIALS_JSON not set or empty');

async function slackNotify(text) {
  if (!SLACK_WEBHOOK) return;
  try { await axios.post(SLACK_WEBHOOK, { text: `:warning: *Meta On/Off Scheduler*\n${text}` }); }
  catch (e) { console.error('Slack notify failed', e.response?.data || e.message); }
}

const db = new Database('rules.db');
db.exec(`CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('campaign','adset')),
  target_ids TEXT NOT NULL,
  name_filter TEXT,
  stop_time TEXT NOT NULL,
  start_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enforce_window_minutes INTEGER NOT NULL DEFAULT 30,
  days_of_week TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  next_run TEXT
);`);
try {
  db.exec(`ALTER TABLE rules ADD COLUMN cred_index INTEGER NOT NULL DEFAULT 0;`);
  console.log('[DB] Added cred_index column');
} catch {}

const jobs = new Map();
function scheduleRule(rule) {
  unscheduleRule(rule.id);
  if (!rule.enabled) return;

  const tz = rule.timezone || DEFAULT_TZ;
  const [stopH, stopM] = rule.stop_time.split(':').map(Number);
  const [startH, startM] = rule.start_time.split(':').map(Number);

  const stop = cron.schedule(`${stopM} ${stopH} * * *`, () => enforce(rule, 'PAUSED'), { timezone: tz });
  const start = cron.schedule(`${startM} ${startH} * * *`, () => enforce(rule, 'ACTIVE'), { timezone: tz });

  const everyXMins = Math.max(5, Number(rule.enforce_window_minutes) || 30);
  const enforceTask = cron.schedule(`*/${everyXMins} * * * *`, () => periodicEnforce(rule), { timezone: tz });

  jobs.set(rule.id, { stop, start, enforce: enforceTask });
}
function unscheduleRule(ruleId) {
  const j = jobs.get(ruleId);
  if (!j) return;
  Object.values(j).forEach(t => t.stop());
  jobs.delete(ruleId);
}

function getTokenForRule(rule) {
  const i = Number(rule.cred_index || 0);
  return CREDS[i]?.access_token;
}

async function fetchByNameFilter(rule) {
  const token = getTokenForRule(rule);
  const endpoint = `https://graph.facebook.com/v19.0/act_${rule.account_id}/${rule.level === 'campaign' ? 'campaigns' : 'adsets'}`;
  const res = await axios.get(endpoint, {
    params: { fields: 'id,name,configured_status', limit: 200, access_token: token }
  });
  return res.data.data.filter(x => (x.name || '').includes(rule.name_filter)).map(x => x.id);
}
async function getTargets(rule) {
  const ids = JSON.parse(rule.target_ids || '[]');
  if (ids.length) return ids;
  if (!rule.name_filter) return [];
  return fetchByNameFilter(rule);
}

async function setStatus(id, desired, rule) {
  const token = getTokenForRule(rule);
  const url = `https://graph.facebook.com/v19.0/${id}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(url, { status: desired, access_token: token });
      return;
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const transient = [1,2,4,17,32,613,80004].includes(code);
      if (attempt < 3 && transient) await new Promise(r => setTimeout(r, 500 * attempt));
      else throw e;
    }
  }
}

async function enforce(rule, desired) {
  const dow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: rule.timezone }).format(new Date());
  if (!JSON.parse(rule.days_of_week).includes(dow)) return;

  const targets = await getTargets(rule);
  if (!targets.length) return;

  for (const id of targets) {
    try { await setStatus(id, desired, rule); }
    catch (e) {
      const err = e.response?.data || e.message;
      console.error('Toggle failed', id, err);
      await slackNotify(`Failed to set *${desired}* on ${rule.level} ${id} (rule #${rule.id}).\nError: \`${JSON.stringify(err).slice(0,500)}\``);
    }
  }
  db.prepare('UPDATE rules SET last_run = datetime("now") WHERE id = ?').run(rule.id);
}

async function periodicEnforce(rule) {
  const tz = rule.timezone || DEFAULT_TZ;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  const [hh, mm] = fmt.format(now).split(':').map(Number);
  const cur = hh*60 + mm;
  const [sh, sm] = rule.stop_time.split(':').map(Number);
  const [th, tm] = rule.start_time.split(':').map(Number);
  const stopMin = sh*60 + sm;
  const startMin = th*60 + tm;

  let desired = 'ACTIVE';
  if (stopMin < startMin) {
    if (cur >= stopMin && cur < startMin) desired = 'PAUSED';
  } else {
    if (cur >= stopMin || cur < startMin) desired = 'PAUSED';
  }
  return enforce(rule, desired);
}

app.get('/api/accounts', async (req, res) => {
  try {
    const all = [];
    for (let i = 0; i < CREDS.length; i++) {
      const { business_id, access_token, timezone } = CREDS[i];
      const url = `https://graph.facebook.com/v19.0/${business_id}/owned_ad_accounts`;
      const r = await axios.get(url, {
        params: { fields: 'id,account_id,name,timezone_name,account_status', limit: 200, access_token }
      });
      for (const a of r.data.data) {
        all.push({
          id: a.account_id,
          name: a.name,
          tz: a.timezone_name || timezone || DEFAULT_TZ,
          status: a.account_status,
          act_id: `act_${a.account_id}`,
          cred_index: i,
          business_id
        });
      }
    }
    res.json(all);
  } catch (e) {
    const err = e.response?.data || e.message;
    console.error('List accounts failed', err);
    await slackNotify(`Failed to list ad accounts. Error: \`${JSON.stringify(err).slice(0,500)}\``);
    res.status(500).send('Failed to list accounts');
  }
});

app.get('/api/rules', (req, res) => {
  const { account_id } = req.query;
  const rows = db.prepare('SELECT * FROM rules WHERE account_id = ? ORDER BY id DESC').all(account_id);
  const mapped = rows.map(r => ({ ...r, target_ids: JSON.parse(r.target_ids), days_of_week: JSON.parse(r.days_of_week) }));
  res.json(mapped);
});

app.post('/api/rules', (req, res) => {
  const r = req.body;
  const stmt = db.prepare(`INSERT INTO rules (account_id, level, target_ids, name_filter, stop_time, start_time, timezone, enforce_window_minutes, days_of_week, enabled, cred_index)
    VALUES (@account_id, @level, @target_ids, @name_filter, @stop_time, @start_time, @timezone, @enforce_window_minutes, @days_of_week, @enabled, @cred_index)`);
  const info = stmt.run({
    account_id: r.account_id,
    level: r.level,
    target_ids: JSON.stringify(r.target_ids || []),
    name_filter: r.name_filter || null,
    stop_time: r.stop_time,
    start_time: r.start_time,
    timezone: r.timezone || DEFAULT_TZ,
    enforce_window_minutes: r.enforce_window_minutes || 30,
    days_of_week: JSON.stringify(r.days_of_week || ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]),
    enabled: r.enabled ? 1 : 0,
    cred_index: Number(r.cred_index || 0)
  });
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid);
  scheduleRule(row);
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!row) return res.status(404).send('Not found');
  const merged = { ...row, ...req.body };
  merged.target_ids = JSON.stringify(req.body.target_ids ?? JSON.parse(row.target_ids));
  merged.days_of_week = JSON.stringify(req.body.days_of_week ?? JSON.parse(row.days_of_week));
  db.prepare(`UPDATE rules SET level=@level, target_ids=@target_ids, name_filter=@name_filter, stop_time=@stop_time, start_time=@start_time, timezone=@timezone, enforce_window_minutes=@enforce_window_minutes, days_of_week=@days_of_week, enabled=@enabled, cred_index=@cred_index WHERE id=@id`).run({
    id,
    level: merged.level,
    target_ids: merged.target_ids,
    name_filter: merged.name_filter,
    stop_time: merged.stop_time,
    start_time: merged.start_time,
    timezone: merged.timezone,
    enforce_window_minutes: merged.enforce_window_minutes,
    days_of_week: merged.days_of_week,
    enabled: merged.enabled ? 1 : 0,
    cred_index: Number(merged.cred_index || 0)
  });
  const updated = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  scheduleRule(updated);
  res.json({ ok: true });
});

app.delete('/api/rules/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  unscheduleRule(id);
  res.json({ ok: true });
});

(function init() {
  const rows = db.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  for (const r of rows) scheduleRule(r);
})();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
