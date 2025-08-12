const API = location.origin.replace(/:\d+$/, ':8080');

const accountsEl = document.getElementById('accounts');
const accountsStatus = document.getElementById('accountsStatus');
const refreshBtn = document.getElementById('refreshAccounts');
const rulesBody = document.getElementById('rules');
const createBtn = document.getElementById('createRule');
const createStatus = document.getElementById('createStatus');

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function loadAccounts() {
  accountsStatus.textContent = 'Loading...';
  accountsEl.innerHTML = '';
  try {
    const data = await fetchJSON(`${API}/api/accounts`);
    if (Array.isArray(data)) {
      for (const a of data) {
        const li = document.createElement('li');
        li.textContent = `${a.name} (${a.id}) — ${a.timezone_name ?? ''}`;
        accountsEl.appendChild(li);
      }
      accountsStatus.textContent = `Loaded ${data.length}`;
    } else {
      accountsStatus.textContent = 'Error';
    }
  } catch {
    accountsStatus.textContent = 'Error';
  }
}

async function loadRules() {
  rulesBody.innerHTML = '';
  const rows = await fetchJSON(`${API}/api/rules`);
  for (const r of rows) {
    const tr = document.createElement('tr');
    const targets = r.ids && r.ids.length ? r.ids.join(',') : (r.name_contains || '');
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.account_id}</td>
      <td>${r.level}</td>
      <td>${targets}</td>
      <td>${r.stop} → ${r.start}</td>
      <td>${r.tz}</td>
      <td>${(r.days||[]).join(',')}</td>
      <td>${r.enforce_every}m</td>
      <td><button data-id="${r.id}" class="del">Delete</button></td>
    `;
    rulesBody.appendChild(tr);
  }
}

refreshBtn.addEventListener('click', loadAccounts);

createBtn.addEventListener('click', async () => {
  createStatus.textContent = 'Submitting...';
  const b = {
    account_id: document.getElementById('accountId').value.trim(),
    level: document.getElementById('level').value,
    ids: document.getElementById('ids').value.split(',').map(s => s.trim()).filter(Boolean),
    name_contains: document.getElementById('nameContains').value.trim(),
    stop: document.getElementById('stop').value.trim(),
    start: document.getElementById('start').value.trim(),
    tz: document.getElementById('tz').value.trim(),
    days: document.getElementById('days').value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)),
    enforce_every: parseInt(document.getElementById('enforceEvery').value.trim(), 10)
  };
  try {
    const r = await fetch(`${API}/api/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b)
    });
    if (r.ok) {
      createStatus.textContent = 'Created';
      await loadRules();
    } else {
      createStatus.textContent = 'Error';
    }
  } catch {
    createStatus.textContent = 'Error';
  }
});

rulesBody.addEventListener('click', async (e) => {
  const t = e.target;
  if (t && t.matches('button.del')) {
    const id = t.getAttribute('data-id');
    await fetch(`${API}/api/rules/${id}`, { method: 'DELETE' });
    await loadRules();
  }
});

loadAccounts().then(loadRules);
