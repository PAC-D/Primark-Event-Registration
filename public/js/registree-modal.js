// Small popup listing who already holds the seat(s) of an organisation the visitor selected
// whose attendee slot is already full ("View attendee").
// Animated with GSAP (loaded via CDN on pages that mount the registration form); every
// animation is skipped when GSAP is unavailable or the visitor prefers reduced motion.
import { escapeHtml } from '/shared/form-logic.js';
import { SEAT_LIMITS } from '/shared/constants.js';
import { prefersReducedMotion } from './motion.js';

const CONTACT_EMAIL = 'Hasibuzzaman@pac-d.com';

let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'registree-modal';
  dialog.setAttribute('aria-labelledby', 'registree-title');
  document.body.append(dialog);

  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeRegistreeModal(); });
  dialog.addEventListener('click', (event) => {
    // A click landing on the dialog element itself is a click on the backdrop.
    if (event.target === dialog || event.target.closest('[data-modal-close]')) closeRegistreeModal();
  });
  return dialog;
}

export function openRegistreeModal(org) {
  const el = ensureDialog();
  const registrants = org.registrants ?? [];
  const limit = SEAT_LIMITS[org.kind] ?? 0;
  el.innerHTML = `
    <div class="modal-head">
      <h2 id="registree-title">${escapeHtml(org.name)}</h2>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">✕</button>
    </div>
    <p class="muted registree-count">${registrants.length} of ${limit} ${escapeHtml(org.kind)} seat${limit === 1 ? '' : 's'} taken</p>
    <ul class="registree-list">
      ${registrants.map((r) => `
        <li class="registree-person">
          <strong>${escapeHtml(r.name)}</strong>
          <span class="muted">${escapeHtml(r.designation)}</span>
        </li>`).join('')}
    </ul>
    <p class="contact-note">
      To remove a registered person or edit their details, please contact
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
    </p>`;
  el.showModal();

  const gsap = window.gsap;
  if (!gsap || prefersReducedMotion()) return;
  gsap.killTweensOf(el); // a close tween from a previous open must not close this one
  gsap.fromTo(el,
    { autoAlpha: 0, scale: 0.9, y: 18 },
    { autoAlpha: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.6)' });
  gsap.fromTo(el.querySelectorAll('.registree-person'),
    { autoAlpha: 0, y: 10 },
    { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.06, delay: 0.08 });
}

export function closeRegistreeModal() {
  if (!dialog?.open) return;
  const el = dialog;
  const gsap = window.gsap;
  if (!gsap || prefersReducedMotion()) { el.close(); return; }
  gsap.killTweensOf(el);
  gsap.to(el, { autoAlpha: 0, scale: 0.92, y: 10, duration: 0.18, ease: 'power2.in', onComplete: () => el.close() });
}
