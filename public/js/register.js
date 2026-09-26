import { api } from './api.js';
import { mountRegistrationForm } from './registration-form.js';
import { escapeHtml } from '/shared/form-logic.js';

const root = document.getElementById('app');

function showConfirmation(payload, orgs) {
  const fromLabel = { supplier: 'Supplier', factory: 'Factory', other: 'Other' }[payload.from_type];
  const orgNames = (kind) => payload.orgs
    .filter((entry) => entry.kind === kind)
    .map((entry) => `<li>${escapeHtml(orgs.find((o) => o.id === entry.org_id)?.name ?? '')}</li>`)
    .join('');

  root.innerHTML = `
    <div class="confirmation" tabindex="-1">
      <div class="success-badge" aria-hidden="true">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h2>You're registered!</h2>
      <dl>
        <dt>Full Name</dt><dd>${escapeHtml(payload.name)}</dd>
        <dt>Designation</dt><dd>${escapeHtml(payload.designation)}</dd>
        <dt>Email</dt><dd>${escapeHtml(payload.email)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(payload.phone)}</dd>
        <dt>Attending from</dt><dd>${fromLabel}</dd>
        ${payload.from_type === 'other'
          ? `<dt>Organisation</dt><dd>${escapeHtml(payload.organisation_name)}</dd>`
          : ''}
      </dl>
      ${payload.from_type !== 'other' ? `
        <h3>Suppliers</h3>
        <ul>${orgNames('supplier') || '<li>—</li>'}</ul>
        <h3>Factories</h3>
        <ul>${orgNames('factory') || '<li>—</li>'}</ul>
      ` : ''}
      <p><strong>Event Location:</strong> Crowne Plaza Dhaka Airport (Celestial Ballroom - Second Floor)</p>
      <p class="muted">To change or cancel your registration, contact the event team.</p>
      <button type="button" class="btn" id="register-another">Register another person</button>
    </div>`;
  // The "* are required" / seat-limit note is only for the open form, not the confirmation view.
  document.querySelector('.details-note')?.remove();
  root.querySelector('.confirmation').focus();
  root.querySelector('#register-another').addEventListener('click', () => window.location.reload());
}

async function start() {
  let data;
  try {
    data = await api('/api/organisations');
  } catch (err) {
    root.innerHTML = `<p class="alert" role="alert">${escapeHtml(err.message)}</p>`;
    return;
  }

  document.title = `Primark Carton Nomination Program — ${data.event_title}`;
  document.getElementById('event-subtitle').textContent = data.event_title;

  mountRegistrationForm(root, {
    orgs: data.organisations,
    reloadOrgs: async () => (await api('/api/organisations')).organisations,
    onSubmit: async (payload) => {
      await api('/api/register', { method: 'POST', body: payload });
      showConfirmation(payload, data.organisations);
    },
  });
}

start();
