import { api } from './api.js';
import { mountRegistrationForm } from './registration-form.js';
import { escapeHtml } from '/shared/form-logic.js';
import { prefersReducedMotion } from './motion.js';

const root = document.getElementById('app');
const CONTACT_EMAIL = 'Hasibuzzaman@pac-d.com';

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
      <div class="confirm-title">
        <h2>You're registered!</h2>
        <p class="confirm-sub muted">Your seat for the Primark Carton Nomination Program is confirmed.</p>
      </div>

      <dl class="confirm-card">
        <div class="confirm-row"><dt>Full Name</dt><dd>${escapeHtml(payload.name)}</dd></div>
        <div class="confirm-row"><dt>Designation</dt><dd>${escapeHtml(payload.designation)}</dd></div>
        <div class="confirm-row"><dt>Email</dt><dd>${escapeHtml(payload.email)}</dd></div>
        <div class="confirm-row"><dt>Phone</dt><dd>${escapeHtml(payload.phone)}</dd></div>
        ${payload.from_type === 'other'
          ? `<div class="confirm-row"><dt>Organisation</dt><dd>${escapeHtml(payload.organisation_name)}</dd></div>`
          : `<div class="confirm-row"><dt>Attending from</dt><dd>${fromLabel}</dd></div>`}
      </dl>

      ${payload.from_type !== 'other' ? `
      <div class="confirm-orgs">
        <section class="confirm-org">
          <h3>Suppliers</h3>
          <ul>${orgNames('supplier') || '<li class="muted">—</li>'}</ul>
        </section>
        <section class="confirm-org">
          <h3>Factories</h3>
          <ul>${orgNames('factory') || '<li class="muted">—</li>'}</ul>
        </section>
      </div>` : ''}

      <div class="confirm-location">
        <svg class="loc-pin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        <span class="loc-text">
          <span class="loc-label">Event Location</span>
          <span class="loc-name">Crowne Plaza Dhaka Airport</span>
          <span class="loc-venue">Celestial Ballroom &ndash; Second Floor</span>
        </span>
      </div>
      <p class="confirm-contact">
        To edit or cancel your registration, please contact
        <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
      </p>
      <div class="confirm-actions">
        <button type="button" class="btn primary" id="register-another">Register another person</button>
      </div>
    </div>`;

  // The "* are required" / seat-limit note is only for the open form, not the confirmation view.
  document.querySelector('.details-note')?.remove();
  const confirmation = root.querySelector('.confirmation');
  confirmation.focus();
  root.querySelector('#register-another').addEventListener('click', () => window.location.reload());

  // ----- entrance animation (GSAP owns all motion here; skipped for reduced motion) -----
  const gsap = window.gsap;
  if (!gsap || prefersReducedMotion()) return;

  const path = confirmation.querySelector('.success-badge path');
  const length = path.getTotalLength();
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
  tl.fromTo(confirmation.querySelector('.success-badge'),
    { scale: 0, autoAlpha: 0 },
    { scale: 1, autoAlpha: 1, duration: 0.5, ease: 'back.out(1.7)' })
    .to(path, { strokeDashoffset: 0, duration: 0.3, ease: 'power2.out' }, '-=0.15')
    .from(confirmation.querySelector('.confirm-title'), { y: 16, autoAlpha: 0, duration: 0.4 }, '-=0.05')
    .from(confirmation.querySelectorAll('.confirm-row'), { y: 14, autoAlpha: 0, duration: 0.35, stagger: 0.06 }, '-=0.15');
  const orgCards = confirmation.querySelectorAll('.confirm-org');
  if (orgCards.length) tl.from(orgCards, { y: 14, autoAlpha: 0, duration: 0.35, stagger: 0.08 }, '-=0.15');
  tl.from(confirmation.querySelectorAll('.confirm-location, .confirm-contact'),
    { y: 10, autoAlpha: 0, duration: 0.3, stagger: 0.08 }, '-=0.1')
    .from(confirmation.querySelector('.confirm-actions'),
      { scale: 0.9, autoAlpha: 0, duration: 0.35, ease: 'back.out(1.6)' }, '-=0.05');
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
