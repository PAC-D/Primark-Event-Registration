import { MAX_ORGS_PER_KIND, validateRegistration } from '/shared/validate.js';
import { buildPayload, escapeHtml, orderRows, pickerOptions, seatInfo } from '/shared/form-logic.js';

const KINDS = [
  { kind: 'supplier', label: 'Supplier(s)', search: 'Search suppliers…', errorKey: 'suppliers' },
  { kind: 'factory', label: 'Factory(ies)', search: 'Search factories…', errorKey: 'factories' },
];

let nextKey = 0;

/**
 * Renders the registration form into `container`. Used by the public page and the admin edit dialog.
 *   orgs        approved organisations [{ id, kind, name, seats_used }]
 *   initial     a dashboard participant to edit (admin only)
 *   submitLabel button text
 *   onSubmit    async (payload) => void; throw an api() error to show it on the form
 *   reloadOrgs  async () => orgs; used to refresh seat hints after SEAT_FULL
 */
export function mountRegistrationForm(container, { orgs, initial = null, submitLabel = 'Register', onSubmit, reloadOrgs = null }) {
  const uid = ++nextKey;
  let orgList = orgs;

  const initialLinks = initial ? [
    ...initial.suppliers.map((o) => ({ ...o, kind: 'supplier' })),
    ...initial.factories.map((o) => ({ ...o, kind: 'factory' })),
  ] : [];
  const originalSeatIds = new Set(initialLinks.filter((o) => o.uses_seat).map((o) => o.org_id));
  const state = {
    fromType: initial?.from_type ?? null,
    rows: initialLinks.map((o) => ({ key: ++nextKey, kind: o.kind, org_id: o.org_id, name: o.name, code: o.code })),
  };
  const ownSeatIds = () => (initial && state.fromType === initial.from_type ? originalSeatIds : new Set());

  container.innerHTML = `
    <form class="reg-form" novalidate>
      <p class="alert" role="alert" hidden></p>
      <fieldset class="field">
        <legend>You are attending from <span class="req">*</span></legend>
        <div class="radios">
          <label><input type="radio" name="from_type" value="supplier"> Supplier</label>
          <label><input type="radio" name="from_type" value="factory"> Factory</label>
        </div>
        <p class="field-error" data-error="from_type"></p>
      </fieldset>
      ${KINDS.map(({ kind, label, search, errorKey }) => `
        <section class="field org-block">
          <label for="picker-${kind}-${uid}">${label} <span class="req">*</span></label>
          <select id="picker-${kind}-${uid}" data-picker="${kind}" placeholder="${search}"></select>
          <ul class="org-rows" data-rows="${kind}"></ul>
          <button type="button" class="link-btn" data-add-other="${kind}">+ Not in the list? Add a new ${kind}</button>
          <p class="field-error" data-error="${errorKey}"></p>
        </section>`).join('')}
      <div class="field">
        <label for="name-${uid}">Attendee name <span class="req">*</span></label>
        <input id="name-${uid}" name="name" autocomplete="name" maxlength="100">
        <p class="field-error" data-error="name"></p>
      </div>
      <div class="field">
        <label for="email-${uid}">Email <span class="req">*</span></label>
        <input id="email-${uid}" name="email" type="email" autocomplete="email" maxlength="254">
        <p class="field-error" data-error="email"></p>
      </div>
      <div class="field">
        <label for="phone-${uid}">Phone <span class="req">*</span></label>
        <input id="phone-${uid}" name="phone" type="tel" autocomplete="tel" maxlength="30">
        <p class="field-error" data-error="phone"></p>
      </div>
      <div class="hp" aria-hidden="true">
        <label>Website <input name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <button type="submit" class="btn primary">${escapeHtml(submitLabel)}</button>
    </form>`;

  const form = container.querySelector('form');
  const alertBox = form.querySelector('.alert');
  const submitButton = form.querySelector('button[type="submit"]');
  const field = (name) => form.querySelector(`[name="${name}"]`);

  const pickers = Object.fromEntries(KINDS.map(({ kind }) => [kind, new window.TomSelect(
    form.querySelector(`[data-picker="${kind}"]`),
    {
      maxOptions: 500,
      searchField: ['text'],
      render: {
        option: (data, escape) => `<div class="picker-option">${escape(data.text)} <small>${escape(data.hint)}</small></div>`,
        item: (data, escape) => `<div>${escape(data.text)}</div>`,
        no_results: () => '<div class="no-results">No match. Use “Not in the list?” below.</div>',
      },
      onChange(value) {
        if (!value) return;
        this.clear(true);
        addListedRow(kind, Number(value));
      },
    },
  )]));

  function rowHtml(row, own) {
    const listed = row.org_id != null;
    const org = listed ? orgList.find((o) => o.id === row.org_id) : null;
    const full = org ? seatInfo(org, state.fromType, own.has(org.id)).full : false;
    const label = escapeHtml(row.name ?? `new ${row.kind}`);
    const nameCell = listed
      ? `<span class="org-name">${escapeHtml(row.name)}${org ? '' : ' <em class="muted">(pending approval)</em>'}${full ? ' <strong class="warn-text">full</strong>' : ''}</span>`
      : `<input data-field="other_name" maxlength="150" placeholder="New ${row.kind} name *" aria-label="New ${row.kind} name" value="${escapeHtml(row.other_name)}">`;
    return `
      <li class="org-row${full ? ' is-full' : ''}" data-key="${row.key}">
        ${nameCell}
        <input data-field="code" maxlength="30" placeholder="Code *" aria-label="Code for ${label}" value="${escapeHtml(row.code)}">
        <button type="button" class="icon-btn" data-remove="${row.key}" aria-label="Remove ${label}">✕</button>
        <p class="field-error" data-row-error="${row.key}"></p>
      </li>`;
  }

  function render() {
    const own = ownSeatIds();
    for (const { kind } of KINDS) {
      const rows = state.rows.filter((r) => r.kind === kind);
      form.querySelector(`[data-rows="${kind}"]`).innerHTML = rows.map((r) => rowHtml(r, own)).join('');

      const picker = pickers[kind];
      picker.clearOptions();
      picker.addOptions(pickerOptions(orgList, {
        kind,
        fromType: state.fromType,
        ownSeatIds: own,
        selectedIds: new Set(rows.filter((r) => r.org_id != null).map((r) => r.org_id)),
      }));
      picker.refreshOptions(false);

      const atLimit = rows.length >= MAX_ORGS_PER_KIND;
      if (atLimit) picker.disable(); else picker.enable();
      form.querySelector(`[data-add-other="${kind}"]`).disabled = atLimit;
    }
  }

  function addListedRow(kind, orgId) {
    const org = orgList.find((o) => o.id === orgId);
    if (!org || state.rows.some((r) => r.org_id === orgId)) return;
    const row = { key: ++nextKey, kind, org_id: org.id, name: org.name, code: '' };
    state.rows.push(row);
    render();
    form.querySelector(`[data-key="${row.key}"] [data-field="code"]`)?.focus();
  }

  function clearErrors() {
    alertBox.hidden = true;
    alertBox.textContent = '';
    form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  }

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
    alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Field keys come from validateRegistration or the API: "name", "suppliers", "orgs.3.code", ...
  // `ordered` must be the row order the server (or validateRegistration) actually indexed against —
  // pass the snapshot taken at submit time, since state.rows can change while a request is in flight.
  function showFieldErrors(fields, ordered = orderRows(state.rows)) {
    for (const [key, message] of Object.entries(fields)) {
      const rowMatch = key.match(/^orgs\.(\d+)/);
      const target = rowMatch
        ? form.querySelector(`[data-row-error="${ordered[Number(rowMatch[1])]?.key}"]`)
        : form.querySelector(`[data-error="${key}"]`);
      if (target) target.textContent = target.textContent ? `${target.textContent} ${message}` : message;
    }
  }

  form.addEventListener('input', (event) => {
    const fieldName = event.target.dataset?.field;
    const item = event.target.closest('[data-key]');
    if (!fieldName || !item) return;
    const row = state.rows.find((r) => r.key === Number(item.dataset.key));
    if (row) row[fieldName] = event.target.value;
  });

  form.addEventListener('change', (event) => {
    if (event.target.name !== 'from_type') return;
    state.fromType = event.target.value;
    render();
  });

  form.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      state.rows = state.rows.filter((r) => r.key !== Number(remove.dataset.remove));
      render();
      return;
    }
    const add = event.target.closest('[data-add-other]');
    if (add) {
      const row = { key: ++nextKey, kind: add.dataset.addOther, other_name: '', code: '' };
      state.rows.push(row);
      render();
      form.querySelector(`[data-key="${row.key}"] [data-field="other_name"]`)?.focus();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    // Snapshot the row order used for this submission: state.rows can change while the request is
    // in flight (pickers, remove and "+ Add new" stay interactive), so later error mapping must use
    // this same order rather than recomputing it from the (possibly since-changed) live rows.
    const submittedRows = orderRows(state.rows);
    const payload = buildPayload({
      fromType: state.fromType,
      name: field('name').value,
      email: field('email').value,
      phone: field('phone').value,
      website: field('website').value,
      rows: submittedRows,
    });
    const result = validateRegistration(payload);
    if (!result.ok) {
      showFieldErrors(result.fields, submittedRows);
      showAlert('Please check the highlighted fields.');
      return;
    }
    submitButton.disabled = true;
    try {
      await onSubmit(payload);
    } catch (err) {
      showAlert(err.message);
      if (err.data?.fields) showFieldErrors(err.data.fields, submittedRows);
      if (err.code === 'SEAT_FULL' && reloadOrgs) {
        orgList = await reloadOrgs().catch(() => orgList);
        render();
      }
    } finally {
      submitButton.disabled = false;
    }
  });

  if (initial) {
    field('name').value = initial.name;
    field('email').value = initial.email;
    field('phone').value = initial.phone;
    form.querySelector(`input[name="from_type"][value="${initial.from_type}"]`).checked = true;
  }
  render();

  return { destroy: () => Object.values(pickers).forEach((picker) => picker.destroy()) };
}
