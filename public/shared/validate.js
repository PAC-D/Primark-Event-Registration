// Shared by the browser (/shared/validate.js) and the server. Keep it dependency-free.
export const MAX_ORGS_PER_KIND = 10;

// Photo paths are produced by POST /api/photos (a random UUID plus the sniffed extension).
export const PHOTO_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

const KINDS = ['supplier', 'factory'];
const FROM_TYPES = [...KINDS, 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_RE = /^[0-9+\-\s()]+$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObject = (value) => value !== null && typeof value === 'object';

// Codes are never submitted: the server resolves each organisation's code. Anything except
// a listed org_id is rejected, so legacy other_name/code fields are simply dropped.
function validateOrg(raw, i, fields) {
  const entry = isObject(raw) ? raw : {};
  const out = { kind: entry.kind };
  if (!KINDS.includes(entry.kind)) fields[`orgs.${i}.kind`] = 'Invalid organisation type.';
  if (!Number.isSafeInteger(entry.org_id) || entry.org_id <= 0) {
    fields[`orgs.${i}`] = 'Choose an organisation from the list.';
  } else {
    out.org_id = entry.org_id;
  }
  return out;
}

export function validateRegistration(input) {
  const src = isObject(input) ? input : {};
  const fields = {};

  const from_type = src.from_type;
  if (!FROM_TYPES.includes(from_type)) fields.from_type = 'Choose supplier, factory or other.';

  const name = text(src.name);
  if (name.length < 2 || name.length > 100) fields.name = 'Enter a name of 2–100 characters.';

  const designation = text(src.designation);
  if (designation.length < 2 || designation.length > 100) fields.designation = 'Enter a designation of 2–100 characters.';

  const email = text(src.email);
  if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address.';

  const phone = text(src.phone);
  const digits = phone.replace(/\D/g, '').length;
  if (!PHONE_CHARS_RE.test(phone) || digits < 7 || digits > 15) {
    fields.phone = 'Enter a phone number with 7–15 digits.';
  }

  const photo_path = text(src.photo_path) || null;
  if (photo_path !== null && !PHOTO_PATH_RE.test(photo_path)) fields.photo = 'Upload the photo again.';

  const organisation_name = text(src.organisation_name);
  let orgs = [];

  if (from_type === 'other') {
    if (organisation_name.length < 2 || organisation_name.length > 150) {
      fields.organisation_name = 'Enter an organisation name of 2–150 characters.';
    }
    if (Array.isArray(src.orgs) && src.orgs.length > 0) {
      fields.orgs = 'Other attendees have no supplier or factory.';
    }
  } else {
    const plural = { supplier: 'suppliers', factory: 'factories' };
    const singular = { supplier: 'a supplier', factory: 'a factory' };
    const ownKind = KINDS.includes(from_type) ? from_type : 'supplier';
    const otherKind = ownKind === 'supplier' ? 'factory' : 'supplier';
    orgs = (Array.isArray(src.orgs) ? src.orgs : []).map((raw, i) => validateOrg(raw, i, fields));
    const count = (kind) => orgs.filter((o) => o.kind === kind).length;
    if (count(ownKind) < 1) {
      fields[plural[ownKind]] = `Select ${singular[ownKind]}.`;
    } else if (count(ownKind) > MAX_ORGS_PER_KIND) {
      fields[plural[ownKind]] = `Select at most ${MAX_ORGS_PER_KIND} ${plural[ownKind]}.`;
    }
    if (count(otherKind) > MAX_ORGS_PER_KIND) {
      fields[plural[otherKind]] = `Select at most ${MAX_ORGS_PER_KIND} ${plural[otherKind]}.`;
    }
  }

  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      from_type,
      name,
      email,
      phone,
      designation,
      photo_path,
      organisation_name: from_type === 'other' ? organisation_name : null,
      orgs,
    },
  };
}
