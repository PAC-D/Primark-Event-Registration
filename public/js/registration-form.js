import { MAX_ORGS_PER_KIND, validateRegistration } from '/shared/validate.js';
import { ORGANISATION_OPTIONS, PHOTO_MAX_BYTES } from '/shared/constants.js';
import { buildPayload, escapeHtml, orderRows, pickerOptions, seatInfo } from '/shared/form-logic.js';
import { openRegistreeModal } from './registree-modal.js';

const KINDS = [
  { kind: 'supplier', label: 'Supplier(s)', search: 'Search suppliers…', errorKey: 'suppliers' },
  { kind: 'factory', label: 'Factory(ies)', search: 'Search factories…', errorKey: 'factories' },
];

const FROM_OPTIONS = [
  { value: 'supplier', label: 'Supplier' },
  { value: 'factory', label: 'Factory' },
  { value: 'other', label: 'Other' },
];

const CUSTOM_ORG = 'Other';
const PHOTO_RULE_MESSAGE = 'Please choose a JPG or PNG image under 1 MB.';

let nextKey = 0;

/**
 * Renders the registration form into `container`. Used by the public page and the admin edit dialog.
 * The photo is uploaded only when the form is submitted (Register / Save), never on selection.
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
    rows: initialLinks.map((o) => ({ key: ++nextKey, kind: o.kind, org_id: o.org_id, name: o.name })),
    photoFile: null,
    keepExistingPhoto: Boolean(initial?.photo_path),
    orgName: '',
    orgCustom: '',
  };
  const ownSeatIds = () => (initial && state.fromType === initial.from_type ? originalSeatIds : new Set());
  // The row added by the latest action slides in; every other re-rendered row stays still.
  let enteringKey = null;

  container.innerHTML = `
    <form class="reg-form" method="post" novalidate>
      <p class="alert" role="alert" hidden></p>
      <fieldset class="field" data-fieldset="from_type">
        <legend>Attending from <span class="req">*</span></legend>
        <div class="radios">
          ${FROM_OPTIONS.map((o) => `<label><input type="radio" name="from_type" value="${o.value}"> ${o.label}</label>`).join('')}
        </div>
        <p class="field-error" data-error="from_type"></p>
      </fieldset>

      <div data-kind-sections>
        ${KINDS.map(({ kind, label, search, errorKey }) => `
          <section class="field org-block">
            <label data-kind-label="${kind}" for="picker-${kind}-${uid}">${label} <span class="req">*</span></label>
            <select id="picker-${kind}-${uid}" data-picker="${kind}" placeholder="${search}"></select>
            <ul class="org-rows" data-rows="${kind}"></ul>
            <p class="field-error" data-error="${errorKey}"></p>
          </section>`).join('')}
      </div>

      <section class="field" data-other-org hidden>
        <label for="orgname-${uid}">Organization Name <span class="req">*</span></label>
        <select id="orgname-${uid}" data-org-name>
          <option value="" disabled selected>Choose your organisation…</option>
          ${ORGANISATION_OPTIONS.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
        </select>
        <input data-field="org_name_custom" maxlength="150" placeholder="Enter your organisation name *" aria-label="Organisation name" hidden>
        <p class="field-error" data-error="organisation_name"></p>
      </section>

      <section class="sub-card">
        <h3>Attendee information</h3>
        <div class="field">
          <label for="name-${uid}">Full Name <span class="req">*</span></label>
          <input id="name-${uid}" name="name" autocomplete="name" maxlength="100">
          <p class="field-error" data-error="name"></p>
        </div>
        <div class="field">
          <label for="designation-${uid}">Designation <span class="req">*</span></label>
          <input id="designation-${uid}" name="designation" autocomplete="organization-title" maxlength="100">
          <p class="field-error" data-error="designation"></p>
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
        <div class="field" data-photo-field>
          <label for="photo-${uid}">Photo <span class="muted">(optional — JPG or PNG, max 1 MB)</span></label>
          <input id="photo-${uid}" type="file" accept="image/jpeg,image/png" data-photo-input>
          <span class="file-chip" data-photo-chip hidden>
            <span class="file-name" data-file-name></span>
            <button type="button" class="icon-btn small" data-file-cancel aria-label="Remove photo">✕</button>
          </span>
          <span class="file-chip" data-existing-chip hidden>
            <a data-existing-link href="#" target="_blank" rel="noopener">Current photo</a>
            <button type="button" class="icon-btn small" data-existing-remove aria-label="Remove photo">✕</button>
          </span>
          <p class="field-error" data-error="photo"></p>
        </div>
      </section>

      <div class="hp" aria-hidden="true">
        <label>Website <input name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <button type="submit" class="btn primary">${escapeHtml(submitLabel)}</button>
    </form>`;

  const form = container.querySelector('form');
  const alertBox = form.querySelector('.alert');
  const submitButton = form.querySelector('button[type="submit"]');
  const field = (name) => form.querySelector(`[name="${name}"]`);

  // ----- invalid-field marking -----

  function markInvalidForKey(key, ordered) {
    let target = null;
    const rowMatch = key.match(/^orgs\.(\d+)/);
    if (rowMatch) {
      target = form.querySelector(`[data-key="${ordered[Number(rowMatch[1])]?.key}"]`);
    } else {
      target = form.querySelector(`[name="${key}"], [data-error="${key}"]`);
    }
    target?.closest('.field, .org-block, fieldset, .org-row')?.classList.add('field-invalid');
  }

  function clearFieldMark(event) {
    const container = event.target.closest('.field, .org-block, fieldset, .org-row');
    if (!container) return;
    container.classList.remove('field-invalid');
    const errorEl = container.querySelector(':scope > .field-error, :scope div > .field-error');
    if (errorEl) errorEl.textContent = '';
  }

  // ----- supplier/factory pickers -----

  const pickers = Object.fromEntries(KINDS.map(({ kind }) => [kind, new window.TomSelect(
    form.querySelector(`[data-picker="${kind}"]`),
    {
      maxOptions: 500,
      searchField: ['text'],
      render: {
        option: (data, escape) => `<div>${escape(data.text)}</div>`,
        item: (data, escape) => `<div>${escape(data.text)}</div>`,
        no_results: () => '<div class="no-results">No match.</div>',
      },
      onChange(value) {
        if (!value) return;
        this.clear(true);
        addListedRow(kind, Number(value));
      },
    },
  )]));

  // ----- "View attendee" note for rows whose organisation is already full -----

  function openRegistreeFor(orgId) {
    const org = orgList.find((o) => o.id === orgId);
    if (org) openRegistreeModal(org);
  }

  // ----- organisation dropdown for "Other" (native select: nothing editable in the box) -----

  const orgSelectEl = form.querySelector('[data-org-name]');
  const customOrgInput = form.querySelector('[data-field="org_name_custom"]');
  orgSelectEl.addEventListener('change', () => {
    state.orgName = orgSelectEl.value || '';
    customOrgInput.hidden = state.orgName !== CUSTOM_ORG;
    if (state.orgName === CUSTOM_ORG) {
      customOrgInput.value = state.orgCustom;
      customOrgInput.focus();
    }
    clearFieldMark({ target: orgSelectEl.closest('.field') });
  });

  function resolvedOrgName() {
    return state.orgName === CUSTOM_ORG ? customOrgInput.value.trim() : state.orgName;
  }

  // ----- photo: choose now, upload at submit -----

  const photoFieldEl = form.querySelector('[data-photo-field]');
  const photoInput = form.querySelector('[data-photo-input]');
  const photoError = form.querySelector('[data-error="photo"]');
  const fileChip = form.querySelector('[data-photo-chip]');
  const fileNameEl = form.querySelector('[data-file-name]');
  const existingChip = form.querySelector('[data-existing-chip]');
  const existingLink = form.querySelector('[data-existing-link]');

  function syncPhotoUI() {
    fileChip.hidden = !state.photoFile;
    existingChip.hidden = state.photoFile !== null || !state.keepExistingPhoto;
    if (state.photoFile) fileNameEl.textContent = state.photoFile.name;
  }

  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    photoError.textContent = '';
    photoFieldEl.classList.remove('field-invalid');
    state.photoFile = null;
    if (file) {
      if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > PHOTO_MAX_BYTES) {
        photoError.textContent = PHOTO_RULE_MESSAGE;
        photoFieldEl.classList.add('field-invalid');
        photoInput.value = '';
      } else {
        state.photoFile = file;
      }
    }
    syncPhotoUI();
  });

  fileChip.querySelector('[data-file-cancel]').addEventListener('click', () => {
    state.photoFile = null;
    photoInput.value = '';
    photoError.textContent = '';
    syncPhotoUI();
  });

  existingChip.querySelector('[data-existing-remove]').addEventListener('click', () => {
    state.keepExistingPhoto = false;
    syncPhotoUI();
  });

  async function uploadSelectedPhoto() {
    const res = await fetch('/api/photos', {
      method: 'POST',
      headers: { 'Content-Type': state.photoFile.type },
      body: state.photoFile,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.fields?.photo || data.message || 'Photo upload failed, please try again.';
      photoError.textContent = message;
      photoFieldEl.classList.add('field-invalid');
      throw new Error(message);
    }
    return data.path;
  }

  // ----- rows -----

  function rowHtml(row, own) {
    const org = orgList.find((o) => o.id === row.org_id);
    const full = org ? seatInfo(org, state.fromType, own.has(row.org_id)).full : false;
    const pendingNote = !org ? ' <em class="muted">(pending approval)</em>' : '';
    const classes = ['org-row'];
    if (full) classes.push('is-full');
    if (row.key === enteringKey) classes.push('is-entering');
    return `
      <li class="${classes.join(' ')}" data-key="${row.key}">
        <span class="org-name">${escapeHtml(row.name)}${pendingNote}</span>
        <button type="button" class="icon-btn" data-remove="${row.key}" aria-label="Remove ${escapeHtml(row.name)}">✕</button>
        ${full ? `
          <p class="full-note">
            Selected ${escapeHtml(org.kind)} attendee slot has already been filled.
            <button type="button" class="view-attendee" data-view-attendee="${org.id}">View attendee</button>
          </p>` : ''}
      </li>`;
  }

  function render() {
    const own = ownSeatIds();
    const isOther = state.fromType === 'other';
    form.querySelector('[data-kind-sections]').hidden = isOther;
    form.querySelector('[data-other-org]').hidden = !isOther;

    for (const { kind, label } of KINDS) {
      // Only the attending-from side is mandatory; the other side is optional (0–10).
      // (TomSelect rewrites the label's `for`, so target it with data-kind-label instead.)
      const labelEl = form.querySelector(`[data-kind-label="${kind}"]`);
      if (labelEl) {
        labelEl.innerHTML = !state.fromType || state.fromType === kind
          ? `${label} <span class="req">*</span>`
          : `${label} <span class="muted">(optional)</span>`;
      }

      const rows = state.rows.filter((r) => r.kind === kind);
      form.querySelector(`[data-rows="${kind}"]`).innerHTML = rows.map((r) => rowHtml(r, own)).join('');

      const picker = pickers[kind];
      picker.clearOptions();
      picker.addOptions(pickerOptions(orgList, {
        kind,
        selectedIds: new Set(rows.map((r) => r.org_id)),
      }));
      picker.refreshOptions(false);
      if (rows.length >= MAX_ORGS_PER_KIND) picker.disable(); else picker.enable();
    }
    enteringKey = null;
  }

  function addListedRow(kind, orgId) {
    const org = orgList.find((o) => o.id === orgId);
    if (!org || state.rows.some((r) => r.org_id === orgId)) return;
    const row = { key: ++nextKey, kind, org_id: org.id, name: org.name };
    state.rows.push(row);
    enteringKey = row.key;
    render();
  }

  // ----- errors/alerts -----

  function clearErrors() {
    alertBox.hidden = true;
    alertBox.textContent = '';
    form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
    form.querySelectorAll('.field-invalid').forEach((el) => classListRemoveInvalid(el));
  }
  function classListRemoveInvalid(el) { el.classList.remove('field-invalid'); }

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
    alertBox.classList.remove('shake');
    void alertBox.offsetWidth;
    alertBox.classList.add('shake');
    alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Field keys come from validateRegistration or the API: "name", "suppliers", "orgs.3", ...
  function showFieldErrors(fields, ordered) {
    for (const [key, message] of Object.entries(fields)) {
      const rowMatch = key.match(/^orgs\.(\d+)/);
      const target = rowMatch
        ? form.querySelector(`[data-row-hint="${ordered[Number(rowMatch[1])]?.key}"]`)
        : form.querySelector(`[data-error="${key}"]`);
      if (target) target.textContent = target.textContent ? `${target.textContent} ${message}` : message;
      markInvalidForKey(key, ordered ?? orderRows(state.rows));
    }
  }

  // ----- events -----

  form.addEventListener('change', (event) => {
    if (event.target.name === 'from_type') {
      state.fromType = event.target.value;
      clearFieldMark({ target: event.target });
      render();
      return;
    }
    clearFieldMark(event);
  });

  form.addEventListener('input', (event) => {
    if (event.target.dataset?.field === 'org_name_custom') state.orgCustom = event.target.value;
    clearFieldMark(event);
  });

  form.addEventListener('click', (event) => {
    const view = event.target.closest('[data-view-attendee]');
    if (view) {
      openRegistreeFor(Number(view.dataset.viewAttendee));
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (!remove) return;
    const key = Number(remove.dataset.remove);
    const item = remove.closest('.org-row');
    let removed = false;
    const finish = () => {
      if (removed) return;
      removed = true;
      state.rows = state.rows.filter((r) => r.key !== key);
      render();
    };
    // Let the row slide out first; the timeout covers browsers that skip animationend.
    item.classList.add('is-leaving');
    item.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 300);
  });

  const originalLabel = submitButton.textContent;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    // Snapshot the row order used for this submission (rows can change while a request is in flight).
    const submittedRows = orderRows(state.rows);
    const payload = buildPayload({
      fromType: state.fromType,
      name: field('name').value,
      email: field('email').value,
      phone: field('phone').value,
      designation: field('designation').value,
      website: field('website').value,
      rows: submittedRows,
      organisationName: state.fromType === 'other' ? resolvedOrgName() : '',
      photoPath: state.photoFile ? null : (state.keepExistingPhoto ? initial?.photo_path : null),
    });
    const result = validateRegistration(payload);
    // Front-end only: a full name is at least two words (the server keeps its own length rule).
    const fields = result.ok ? {} : { ...result.fields };
    if (!fields.name && payload.name.trim().split(/\s+/).filter(Boolean).length < 2) {
      fields.name = 'Enter your full name.';
    }
    if (Object.keys(fields).length) {
      showFieldErrors(fields, submittedRows);
      showAlert('Please check the highlighted fields.');
      return;
    }
    submitButton.disabled = true;
    try {
      if (state.photoFile) {
        submitButton.textContent = 'Uploading photo…';
        payload.photo_path = await uploadSelectedPhoto(); // throws with a field message on failure
      }
      submitButton.textContent = 'Registering…';
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
      submitButton.textContent = originalLabel;
    }
  });

  // ----- initial values (admin edit) -----

  if (initial) {
    field('name').value = initial.name;
    field('designation').value = initial.designation ?? '';
    field('email').value = initial.email;
    field('phone').value = initial.phone;
    const radio = form.querySelector(`input[name="from_type"][value="${initial.from_type}"]`);
    if (radio) radio.checked = true;
    if (initial.from_type === 'other' && initial.organisation_name) {
      const name = initial.organisation_name;
      if (ORGANISATION_OPTIONS.includes(name)) {
        state.orgName = name;
        orgSelectEl.value = name;
      } else {
        state.orgName = CUSTOM_ORG;
        state.orgCustom = name;
        orgSelectEl.value = CUSTOM_ORG;
        customOrgInput.hidden = false;
        customOrgInput.value = name;
      }
    }
    if (initial.photo_path) {
      existingLink.href = `/api/admin/participants/${initial.id}/photo`;
    }
    syncPhotoUI();
  }
  render();

  return {
    destroy: () => Object.values(pickers).forEach((picker) => picker.destroy()),
  };
}
