import { api } from './api.js';
import { mountRegistrationForm } from './registration-form.js';
import { escapeHtml } from '/shared/form-logic.js';
import { filterOrganisations, filterParticipants, filterPending } from '/shared/admin-filters.js';

const $ = (selector) => document.querySelector(selector);
const SIDE = { supplier: 'Supplier', factory: 'Factory' };
const STATUS = { missing: 'Missing', registered: 'Registered', full: 'Full' };

const view = { tab: 'participants', search: '', side: 'all', status: 'all' };
let data = null;
let modalCleanup = null;

const formatTime = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// ---------- screens ----------

function showLogin() {
  closeModal();
  $('#dashboard').hidden = true;
  $('#login').hidden = false;
  $('#password').focus();
}

function showError(message) {
  const box = $('#dashboard').hidden ? $('#login-error') : $('#dash-error');
  box.textContent = message;
  box.hidden = false;
}

async function loadData() {
  data = await api('/api/admin/data');
  $('#login').hidden = true;
  $('#dashboard').hidden = false;
  $('#dash-error').hidden = true;
  $('#updated-at').textContent = `Updated ${formatTime(data.generated_at)}`;
  renderTiles();
  renderTab();
}

// Runs an action; a 401 sends the admin back to the login screen, other errors show a message.
async function guarded(action) {
  try {
    await action();
  } catch (err) {
    if (err.status === 401) showLogin();
    else showError(err.message);
  }
}

const refresh = () => guarded(loadData);

// ---------- rendering ----------

function renderTiles() {
  const s = data.summary;
  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
  $('#tiles').innerHTML = [
    tile('Participants', s.participants.total, `supplier ${s.participants.supplier} · factory ${s.participants.factory}`),
    tile('Suppliers', `${s.suppliers.list_registered}/${s.suppliers.list_total}`, `missing ${s.suppliers.missing} · full ${s.suppliers.full}`),
    tile('Factories', `${s.factories.list_registered}/${s.factories.list_total}`, `missing ${s.factories.missing} · full ${s.factories.full}`),
    tile('Pending approvals', s.pending, 'new organisations'),
  ].join('');
}

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="muted empty">${emptyText}</p>`;
  return `<table>
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

const orgLinks = (links) => links.map((o) =>
  `${escapeHtml(o.name)}${o.status === 'pending' ? ' <span class="badge pending">pending</span>' : ''} <code>${escapeHtml(o.code)}</code>`,
).join('<br>');

const peopleList = (people, withCodes = false) => people.map((p) =>
  `${escapeHtml(p.name)} <span class="muted">(${SIDE[p.from_type]})</span>${withCodes ? ` <code>${escapeHtml(p.code)}</code>` : ''}`,
).join('<br>');

function renderParticipants() {
  const rows = filterParticipants(data.participants, view);
  return table(
    ['Name', 'Email', 'Phone', 'From', 'Suppliers', 'Factories', 'Registered', ''],
    rows.map((p) => [
      escapeHtml(p.name), escapeHtml(p.email), escapeHtml(p.phone), SIDE[p.from_type],
      orgLinks(p.suppliers), orgLinks(p.factories), formatTime(p.created_at),
      `<span class="row-actions"><button type="button" class="btn small" data-edit="${p.id}">Edit</button>
       <button type="button" class="btn small danger" data-delete="${p.id}">Delete</button></span>`,
    ]),
    'No participants match.',
  );
}

function renderOrganisations(kind) {
  const rows = filterOrganisations(data.organisations, { kind, search: view.search, status: view.status });
  return table(
    ['Name', 'Seats used', 'People', 'Status'],
    rows.map((o) => [
      `${escapeHtml(o.name)}${o.source === 'attendee' ? ' <span class="badge new">New</span>' : ''}`,
      o.seats_used > 2 ? `${o.seats_used}/2 <span class="badge over">over limit</span>` : `${o.seats_used}/2`,
      peopleList(o.people),
      `<span class="badge ${o.reg_status}">${STATUS[o.reg_status]}</span>`,
    ]),
    'No organisations match.',
  );
}

function renderPending() {
  const rows = filterPending(data.pending, view);
  return table(
    ['Kind', 'Name', 'People (code typed)', 'Added', ''],
    rows.map((o) => [
      SIDE[o.kind], escapeHtml(o.name), peopleList(o.people, true), formatTime(o.created_at),
      `<span class="row-actions"><button type="button" class="btn small primary" data-approve="${o.id}">Approve</button>
       <button type="button" class="btn small" data-merge="${o.id}">Merge into…</button></span>`,
    ]),
    'Nothing waiting for approval.',
  );
}

function renderChips() {
  const chip = (group, value, label) =>
    `<button type="button" class="chip" data-chip-group="${group}" data-chip-value="${value}" aria-pressed="${view[group] === value}">${label}</button>`;
  let chips = [];
  if (view.tab === 'participants') {
    chips = [['all', 'All'], ['supplier', 'From supplier'], ['factory', 'From factory']].map(([v, l]) => chip('side', v, l));
  } else if (view.tab === 'supplier' || view.tab === 'factory') {
    chips = [['all', 'All'], ['missing', 'Missing'], ['registered', 'Registered'], ['full', 'Full']].map(([v, l]) => chip('status', v, l));
  }
  $('#chips').innerHTML = chips.join('');
}

function renderTab() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.tab === view.tab));
  });
  renderChips();
  $('#table').innerHTML = view.tab === 'participants' ? renderParticipants()
    : view.tab === 'pending' ? renderPending()
      : renderOrganisations(view.tab);
}

// ---------- dialogs ----------

const modal = $('#modal');

function openModal(html) {
  closeModal();
  $('#modal-body').innerHTML = html;
  modal.showModal();
}

function closeModal() {
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
  if (modal.open) modal.close();
  $('#modal-body').innerHTML = '';
}

modal.addEventListener('cancel', (event) => { event.preventDefault(); closeModal(); });

function showModalError(html) {
  const box = $('#modal-error');
  box.innerHTML = html;
  box.hidden = false;
}

async function runModalAction(action) {
  try {
    await action();
    closeModal();
    await refresh();
  } catch (err) {
    if (err.status === 401) showLogin();
    else showModalError(escapeHtml(err.message));
  }
}

function openEdit(id) {
  const person = data.participants.find((p) => p.id === id);
  if (!person) return;
  openModal(`
    <div class="modal-head"><h2>Edit ${escapeHtml(person.name)}</h2><button type="button" class="btn small" data-close>Close</button></div>
    <div id="edit-form"></div>`);
  const form = mountRegistrationForm($('#edit-form'), {
    orgs: data.organisations,
    initial: person,
    submitLabel: 'Save changes',
    onSubmit: async (payload) => {
      try {
        await api(`/api/admin/participants/${id}`, { method: 'PUT', body: payload });
      } catch (err) {
        if (err.status === 401) { showLogin(); return; }
        throw err;
      }
      closeModal();
      await refresh();
    },
    reloadOrgs: async () => (await api('/api/organisations')).organisations,
  });
  modalCleanup = () => form.destroy();
}

function confirmDelete(id) {
  const person = data.participants.find((p) => p.id === id);
  if (!person) return;
  const freed = [...person.suppliers, ...person.factories].filter((o) => o.uses_seat).map((o) => o.name);
  openModal(`
    <h2>Delete ${escapeHtml(person.name)}?</h2>
    <p>${freed.length ? `This frees seats at ${escapeHtml(freed.join('; '))}.` : 'This person does not hold any seats.'}</p>
    <p class="alert" id="modal-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn danger" id="confirm-delete">Delete</button>
    </div>`);
  $('#confirm-delete').addEventListener('click', () =>
    runModalAction(() => api(`/api/admin/participants/${id}`, { method: 'DELETE' })));
}

function openMerge(id) {
  const source = data.pending.find((o) => String(o.id) === id);
  if (!source) return;
  const plural = source.kind === 'supplier' ? 'suppliers' : 'factories';
  openModal(`
    <h2>Merge “${escapeHtml(source.name)}”</h2>
    <p>Moves its ${source.people.length} registration link(s) into an approved ${source.kind} and removes this pending name.</p>
    <div class="field">
      <label for="merge-target">Merge into</label>
      <select id="merge-target" placeholder="Search ${plural}…"></select>
    </div>
    <p class="alert" id="modal-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" id="confirm-merge">Merge</button>
    </div>`);
  const picker = new window.TomSelect('#merge-target', {
    maxOptions: 500,
    options: data.organisations
      .filter((o) => o.kind === source.kind)
      .map((o) => ({ value: String(o.id), text: `${o.name} (${o.seats_used}/2)` })),
    // A warning (e.g. "Merge anyway?") belongs to the previous choice.
    onChange: () => {
      const box = $('#modal-error');
      box.hidden = true;
      box.innerHTML = '';
    },
  });
  modalCleanup = () => picker.destroy();

  // targetIdOverride: "Merge anyway" merges the organisation the warning was about.
  const merge = async (allowOverLimit, targetIdOverride) => {
    const targetId = targetIdOverride ?? Number(picker.getValue());
    if (!targetId) { showModalError('Choose an organisation to merge into.'); return; }
    try {
      await api(`/api/admin/organisations/${source.id}/merge`, {
        method: 'POST',
        body: { target_id: targetId, allow_over_limit: allowOverLimit },
      });
      closeModal();
      await refresh();
    } catch (err) {
      if (err.status === 401) { showLogin(); return; }
      if (err.code === 'MERGE_OVER_LIMIT') {
        showModalError(`${escapeHtml(err.message)} <button type="button" class="btn small danger" id="merge-anyway">Merge anyway</button>`);
        $('#merge-anyway').addEventListener('click', () => merge(true, targetId));
        return;
      }
      showModalError(escapeHtml(err.message));
    }
  };
  $('#confirm-merge').addEventListener('click', () => merge(false));
}

async function exportExcel() {
  const res = await fetch('/api/admin/export', { credentials: 'same-origin' });
  if (res.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || 'Export failed, please try again.');
  }
  const blob = await res.blob();
  const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'registrations.xlsx';
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------- events ----------

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const d = button.dataset;
  if (d.tab) {
    Object.assign(view, { tab: d.tab, side: 'all', status: 'all' });
    renderTab();
  } else if (d.chipGroup) {
    view[d.chipGroup] = d.chipValue;
    renderTab();
  } else if (d.edit) openEdit(d.edit);
  else if (d.delete) confirmDelete(d.delete);
  else if (d.approve) guarded(async () => {
    await api(`/api/admin/organisations/${d.approve}/approve`, { method: 'POST' });
    await loadData();
  });
  else if (d.merge) openMerge(d.merge);
  else if ('close' in d) closeModal();
});

$('#search').addEventListener('input', (event) => {
  view.search = event.target.value;
  renderTab();
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#login-error');
  const button = event.target.querySelector('button');
  errorBox.hidden = true;
  button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await refresh();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('#refresh').addEventListener('click', refresh);
$('#export').addEventListener('click', () => guarded(exportExcel));
$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  data = null;
  showLogin();
});

refresh();
