const API = location.origin.replace(/:\d+$/, ':8080');

const accountsEl = document.getElementById('accounts');
const accountsStatus = document.getElementById('accountsStatus');
const refreshBtn = document.getElementById('refreshAccounts');
const rulesBody = document.getElementById('rules');
const createBtn = document.getElementById('createRule');
const createStatus = document.getElementById('createStatus');
const accountSelect = document.getElementById('accountSelect');

let accounts = [];
let selectedAccount = null;

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

function renderAccountsList(data) {
  accountsEl.innerHTML = '';
  accountSelect.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select account';
  accountSelect.appendChild(defaultOpt);

  for (const a of data) {
    const label = `${a.name} (BM: ${a.business_id}, Cred: ${a.cred_index})`;
    const li = document.createElement('li');
    li.textContent = `${label} — ${a.id}`;
    accountsEl.appendChild(li);

    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = label;
    opt.dataset.credIndex = a.cred_index;
    opt.dataset.businessId = a.business_id;
    accountSelect.appendChild(opt);
  }
}

accountSelect.addEventListener('change', () => {
  const id = accountSelect.value;
  selectedAccount = accounts.find(a => a.id === id) || null;
  if (selectedAccount) {
    document.getElementById('accountId').value = selectedAccount.id;
    document.getElementById('tz').value = selectedAccount.tz || document.getElementById('tz').value;
  }
});

async function loadAccounts() {
  accountsStatus.textContent = 'Loading...';
  try {
    const data = await fetchJSON(`${API}/api/accounts`);
    if (Array.isArray(data)) {
      accounts = data;
      renderAccountsList(data);
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
    target_ids: document.getElementById('ids').value.split(',').map(s => s.trim()).filter(Boolean),
    name_filter: document.getElementById('nameContains').value.trim(),
    stop_time: document.getElementById('stop').value.trim(),
    start_time: document.getElementById('start').value.trim(),
    timezone: document.getElementById('tz').value.trim(),
    days_of_week: document.getElementById('days').value.split(',').map(s => s.trim()).map(n => {
      const map = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
      const idx = parseInt(n,10);
      return Number.isNaN(idx) ? n : map[idx];
    }),
    enforce_window_minutes: parseInt(document.getElementById('enforceEvery').value.trim(), 10) || 5,
    cred_index: selectedAccount ? selectedAccount.cred_index : 0,
    enabled: true
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
