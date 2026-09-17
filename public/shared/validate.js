// Shared by the browser (/shared/validate.js) and the server. Keep it dependency-free.
export const MAX_ORGS_PER_KIND = 10;

const KINDS = ['supplier', 'factory'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_RE = /^[0-9+\-\s()]+$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObject = (value) => value !== null && typeof value === 'object';

function validateOrg(raw, i, fields) {
  const entry = isObject(raw) ? raw : {};
  const out = { kind: entry.kind };
  if (!KINDS.includes(entry.kind)) fields[`orgs.${i}.kind`] = 'Invalid organisation type.';

  const hasId = entry.org_id !== undefined && entry.org_id !== null;
  const hasOther = entry.other_name !== undefined && entry.other_name !== null;
  if (hasId === hasOther) {
    fields[`orgs.${i}`] = 'Choose an organisation from the list or add a new one.';
  } else if (hasId) {
    if (!Number.isSafeInteger(entry.org_id) || entry.org_id <= 0) fields[`orgs.${i}`] = 'Invalid organisation.';
    out.org_id = entry.org_id;
  } else {
    out.other_name = text(entry.other_name);
    if (out.other_name.length < 2 || out.other_name.length > 150) {
      fields[`orgs.${i}.other_name`] = 'Enter a name of 2–150 characters.';
    }
  }

  out.code = text(entry.code);
  if (out.code.length < 1 || out.code.length > 30) fields[`orgs.${i}.code`] = 'Enter a code of 1–30 characters.';
  return out;
}

export function validateRegistration(input) {
  const src = isObject(input) ? input : {};
  const fields = {};

  const from_type = src.from_type;
  if (!KINDS.includes(from_type)) fields.from_type = 'Choose supplier or factory.';

  const name = text(src.name);
  if (name.length < 2 || name.length > 100) fields.name = 'Enter a name of 2–100 characters.';

  const email = text(src.email);
  if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address.';

  const phone = text(src.phone);
  const digits = phone.replace(/\D/g, '').length;
  if (!PHONE_CHARS_RE.test(phone) || digits < 7 || digits > 15) {
    fields.phone = 'Enter a phone number with 7–15 digits.';
  }

  const orgs = (Array.isArray(src.orgs) ? src.orgs : []).map((raw, i) => validateOrg(raw, i, fields));
  const count = (kind) => orgs.filter((o) => o.kind === kind).length;
  const suppliers = count('supplier');
  const factories = count('factory');
  if (suppliers < 1 || suppliers > MAX_ORGS_PER_KIND) fields.suppliers = `Select 1–${MAX_ORGS_PER_KIND} suppliers.`;
  if (factories < 1 || factories > MAX_ORGS_PER_KIND) fields.factories = `Select 1–${MAX_ORGS_PER_KIND} factories.`;

  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value: { from_type, name, email, phone, orgs } };
}
