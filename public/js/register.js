import { api } from './api.js';
import { mountRegistrationForm } from './registration-form.js';
import { escapeHtml } from '/shared/form-logic.js';

const root = document.getElementById('app');

function showConfirmation(payload, orgs) {
  const nameOf = (entry) => entry.other_name ?? orgs.find((o) => o.id === entry.org_id)?.name ?? '';
  const list = (kind) => payload.orgs
    .filter((entry) => entry.kind === kind)
    .map((entry) => `<li>${escapeHtml(nameOf(entry))} — code ${escapeHtml(entry.code)}</li>`)
    .join('');

  root.innerHTML = `
    <div class="confirmation" tabindex="-1">
      <h2>You're registered ✓</h2>
      <dl>
        <dt>Name</dt><dd>${escapeHtml(payload.name)}</dd>
        <dt>Email</dt><dd>${escapeHtml(payload.email)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(payload.phone)}</dd>
        <dt>Attending from</dt><dd>${payload.from_type === 'supplier' ? 'Supplier' : 'Factory'}</dd>
      </dl>
      <h3>Suppliers</h3>
      <ul>${list('supplier')}</ul>
      <h3>Factories</h3>
      <ul>${list('factory')}</ul>
      <p class="muted">New organisations you added will be reviewed by the event team.
        To change or cancel your registration, contact the event team.</p>
      <button type="button" class="btn" id="register-another">Register another person</button>
    </div>`;
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

  document.title = `${data.event_title} – Registration`;
  document.getElementById('event-title').textContent = data.event_title;

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
