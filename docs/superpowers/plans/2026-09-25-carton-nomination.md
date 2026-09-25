# Carton Nomination Program Update: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the registration app for the Primark Carton Nomination Program — per-kind seat limits (supplier 2 / factory 1), data-driven org codes hidden from the form, a new "Other" attendee path with a fixed organisation dropdown, designation + optional photo on each registration, an attendee-information sub-card, and a header with no blue band.

**Spec:** `docs/superpowers/specs/2026-09-25-carton-nomination-design.md` (approved 2026-09-25).

**Architecture:** One new Supabase migration (`005_carton_nomination.sql`) carries the schema change (org codes, attendee designation/organisation_name/photo_path, `from_type 'other'`), the private `attendee-photos` storage bucket, and rewrites of `prepare_registration` / `register_attendee` / `update_attendee` / `merge_org`. Canonical supplier/factory lists live in the repo as pipe-delimited data files loaded by the existing import script. Photos upload through a new public raw-body endpoint that validates type (magic bytes) and size before storing via the service key; admins view photos through an authenticated proxy route. The public form, admin dashboard and Excel export gain the new fields.

**Tech Stack:** Express 5, Supabase Postgres + Storage (`@supabase/supabase-js`), plain HTML/CSS/JS (no build step), Tom Select, ExcelJS, Node `node:test` + supertest.

## Global Constraints

- **No new npm dependencies.** `express.raw`, `crypto.randomUUID` and global `Blob`/`fetch` cover everything new.
- **No git commits by the implementer.** The user runs all git mutations; finish the plan with working-tree changes only.
- Migrations are append-only: put everything new in `supabase/migrations/005_carton_nomination.sql`; never edit `001`–`004`.
- Seat limits are dual-maintained: `SEAT_LIMITS` in `public/shared/constants.js` and the same two literals in migration 005 (`case ... when 'supplier' then 2 else 1`).
- Exact event strings (en dash in the time range, middle-dot separators):
  - Title: `Primark Carton Nomination Program`
  - Subtitle (`EVENT_TITLE`): `Bangladesh Origin`
  - Details line: `Nov 04, 2026 · 9:00 AM – 3:30 PM (GMT+6) · Face-to-Face`
- Photo rules everywhere: JPEG or PNG only (magic bytes `FF D8 FF` / `89 50 4E 47`), max 1,048,576 bytes, bucket `attendee-photos` private; clear client message: `Please choose a JPG or PNG image under 1 MB.`
- Codes are resolved server-side from `organisations.code`; the public API and page never expose codes to attendees.
- `public/shared/*.js` stays dependency-free ES modules (imported by browser and server).
- Run tests: `npm run test:unit` (no DB), `npm test` (needs `.env.test` with the test project migrated; sets `ALLOW_DB_WIPE=yes` via the npm script env — see Task 10).

## File map

| File | Change |
|---|---|
| `public/shared/constants.js` | `SEAT_LIMIT` → `SEAT_LIMITS`; add `ORGANISATION_OPTIONS`, `PHOTO_MAX_BYTES` |
| `public/shared/validate.js` | new payload shape: designation, photo_path, organisation_name, `{kind, org_id}` orgs, `other` rules |
| `public/shared/form-logic.js` | per-kind seat hints; payload builder drops codes/other_name |
| `scripts/data/suppliers.psv`, `scripts/data/factories.psv` | **already created during planning** — 80 / 168 `code\|name` lines, verified clean |
| `src/services/import.js` | read `.psv` lists; upsert name+code; prune stale unlinked list orgs |
| `scripts/import-orgs.js` | path arg optional, defaults to `scripts/data` |
| `supabase/migrations/005_carton_nomination.sql` | **create** — schema, bucket, function rewrites |
| `src/services/photo.js` | **create** — magic-byte sniff, path helper, bucket name |
| `src/routes/public.js` | add `POST /api/photos` (raw body), honeypot untouched |
| `src/routes/admin.js` | PUT/DELETE photo cleanup; add `GET /participants/:id/photo` proxy |
| `src/services/dashboard.js` | new attendee fields, per-kind status, `participants.other` count |
| `src/services/export.js` | new Participants columns + `other` summary/`SIDE` |
| `src/errors.js` | seat messages parameterized by kind limit |
| `public/js/registration-form.js` | rewrite: Other path, sub-card, photo picker, no codes/add-new |
| `public/js/register.js` | confirmation matches new payload |
| `public/js/admin.js`, `public/shared/admin-filters.js` | new columns/chips/search, per-kind limits, photo thumbnails |
| `public/index.html`, `public/admin.html`, `public/styles.css` | header un-banding, event details, sub-card + photo styles |
| `.env.example`, `.env.test.example`, `README.md` | event docs + new import flow + migration list |
| `tests/helpers/fake-db.js` | storage stub |
| `tests/helpers/db.js`, `tests/helpers/dashboard-fixture.js` | helpers for new payload shape |
| `tests/unit/*`, `tests/api/*`, `tests/db/*` | updated + new tests per task |

---


### Task 1: Shared constants, validation and payload logic

**Files:**
- Modify: `public/shared/constants.js`
- Modify: `public/shared/validate.js`
- Modify: `public/shared/form-logic.js`
- Test: `tests/unit/validate.test.js`, `tests/unit/form-logic.test.js`, `tests/unit/import.test.js` (Task 2 only touches import tests)

**Interfaces:**
- Produces (used everywhere later):
  - `SEAT_LIMITS = { supplier: 2, factory: 1 }`, `ORGANISATION_OPTIONS` (10 strings, last is `'Other'`), `PHOTO_MAX_BYTES = 1048576` — from `/shared/constants.js`
  - `PHOTO_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/`, `MAX_ORGS_PER_KIND = 10` — from `/shared/validate.js`
  - `validateRegistration(input)` → `{ ok, fields }` or `{ ok: true, value: { from_type, name, email, phone, designation, photo_path, organisation_name, orgs } }`
  - `buildPayload({ fromType, name, email, phone, designation, website?, rows?, photoPath?, organisationName? })`; `seatInfo(org, fromType, ownSeat)`; `pickerOptions(...)`; `orderRows(rows)`; `escapeHtml(...)` — from `/shared/form-logic.js`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** — replace `tests/unit/validate.test.js` wholesale:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, MAX_ORGS_PER_KIND } from '../../public/shared/validate.js';

const UUID_PATH = '123e4567-e89b-42d3-a456-426614174000.jpg';

const base = () => ({
  from_type: 'factory',
  name: '  Rahim Uddin ',
  designation: ' Merchandiser ',
  email: ' rahim@example.com ',
  phone: '+880 1711-000000',
  website: '',
  orgs: [
    { kind: 'factory', org_id: 2 },
    { kind: 'supplier', org_id: 1 },
  ],
});

const fieldsFor = (overrides) => {
  const result = validateRegistration({ ...base(), ...overrides });
  return result.ok ? {} : result.fields;
};

test('accepts a valid payload, trims strings and drops unknown keys', () => {
  const result = validateRegistration(base());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    from_type: 'factory',
    name: 'Rahim Uddin',
    designation: 'Merchandiser',
    email: 'rahim@example.com',
    phone: '+880 1711-000000',
    photo_path: null,
    organisation_name: null,
    orgs: [
      { kind: 'factory', org_id: 2 },
      { kind: 'supplier', org_id: 1 },
    ],
  });
});

test('from_type accepts supplier, factory or other and rejects anything else', () => {
  assert.ok(fieldsFor({ from_type: 'buyer' }).from_type);
  assert.ok(fieldsFor({ from_type: undefined }).from_type);
  assert.equal(fieldsFor({ from_type: 'supplier' }).from_type, undefined);
  assert.equal(fieldsFor({ from_type: 'other', organisation_name: 'Primark Limited', orgs: [] }).from_type, undefined);
});

test('designation must be 2–100 characters', () => {
  assert.ok(fieldsFor({ designation: 'A' }).designation);
  assert.equal(fieldsFor({ designation: 'QA Lead' }).designation, undefined);
  assert.equal(fieldsFor({ designation: 'a'.repeat(100) }).designation, undefined);
  assert.ok(fieldsFor({ designation: 'a'.repeat(101) }).designation);
});

test('name must be 2–100 characters', () => {
  assert.ok(fieldsFor({ name: 'A' }).name);
  assert.equal(fieldsFor({ name: 'Ab' }).name, undefined);
  assert.equal(fieldsFor({ name: 'a'.repeat(100) }).name, undefined);
  assert.ok(fieldsFor({ name: 'a'.repeat(101) }).name);
});

test('email must look valid and be at most 254 characters', () => {
  assert.ok(fieldsFor({ email: 'not-an-email' }).email);
  assert.ok(fieldsFor({ email: 'a b@example.com' }).email);
  assert.ok(fieldsFor({ email: '' }).email);
  assert.equal(fieldsFor({ email: `${'a'.repeat(242)}@example.com` }).email, undefined);
  assert.ok(fieldsFor({ email: `${'a'.repeat(243)}@example.com` }).email);
});

test('phone allows digits, spaces, + - ( ) and needs 7–15 digits', () => {
  assert.equal(fieldsFor({ phone: '1234567' }).phone, undefined);
  assert.ok(fieldsFor({ phone: '123456' }).phone);
  assert.equal(fieldsFor({ phone: '+1 (234) 567-890-12345' }).phone, undefined);
  assert.ok(fieldsFor({ phone: '1234567890123456' }).phone);
  assert.ok(fieldsFor({ phone: '12345678x' }).phone);
});

test('photo_path is optional but must match the upload-path shape', () => {
  assert.equal(fieldsFor({ photo_path: UUID_PATH }).photo, undefined);
  assert.equal(fieldsFor({ photo_path: null }).photo, undefined);
  assert.equal(fieldsFor({ photo_path: '' }).photo, undefined);
  assert.ok(fieldsFor({ photo_path: 'photos/pic.jpg' }).photo);
  assert.ok(fieldsFor({ photo_path: '123e4567-e89b-42d3-a456-426614174000.gif' }).photo);
});

test('the from-kind needs 1..MAX entries; the other kind is optional up to MAX', () => {
  const factory = (id) => ({ kind: 'factory', org_id: id });
  const supplier = (id) => ({ kind: 'supplier', org_id: id });
  assert.equal(fieldsFor({ orgs: [factory(1)] }).factories, undefined);      // factories only: fine for a factory attendee
  assert.ok(fieldsFor({ orgs: [supplier(1)] }).factories);                    // no factory selected
  assert.ok(fieldsFor({ orgs: [] }).factories);
  assert.ok(fieldsFor({ orgs: Array.from({ length: 11 }, (_, i) => factory(i + 1)) }).factories);
  assert.equal(fieldsFor({ orgs: [factory(1), ...Array.from({ length: 10 }, (_, i) => supplier(i + 1))] }).suppliers, undefined);
  assert.ok(fieldsFor({ orgs: [factory(1), ...Array.from({ length: 11 }, (_, i) => supplier(i + 1))] }).suppliers);
});

test('supplier-side attendees need a supplier, not a factory', () => {
  assert.equal(fieldsFor({ from_type: 'supplier', orgs: [{ kind: 'supplier', org_id: 1 }] }).suppliers, undefined);
  assert.ok(fieldsFor({ from_type: 'supplier', orgs: [{ kind: 'factory', org_id: 1 }] }).suppliers);
});

test('org entries only take a listed org_id — no codes, no other_name', () => {
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory' }] })['orgs.0']);
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory', org_id: 'x' }] })['orgs.0']);
  assert.ok(fieldsFor({ orgs: [{ kind: 'buyer', org_id: 1 }] })['orgs.0.kind']);
  assert.equal(fieldsFor({ orgs: [{ kind: 'factory', org_id: 2, code: 'IGNORED', other_name: 'dropped' }] }).orgs, undefined);
  const result = validateRegistration({ ...base(), orgs: [{ kind: 'factory', org_id: 2, code: 'IGNORED' }] });
  assert.deepEqual(result.value.orgs, [{ kind: 'factory', org_id: 2 }]);
});

test('"other" attendees need an organisation name of 2–150 chars and no orgs', () => {
  const other = (overrides) => fieldsFor({ from_type: 'other', orgs: [], organisation_name: 'Primark Limited', ...overrides });
  assert.equal(other({}).organisation_name, undefined);
  assert.ok(other({ organisation_name: 'x' }).organisation_name);
  assert.ok(other({ organisation_name: 'a'.repeat(151) }).organisation_name);
  assert.ok(other({ orgs: [{ kind: 'factory', org_id: 1 }] }).orgs);
  const result = validateRegistration({ ...base(), from_type: 'other', orgs: [], organisation_name: ' WAC - Bangladesh ' });
  assert.equal(result.value.organisation_name, 'WAC - Bangladesh');
  assert.deepEqual(result.value.orgs, []);
});
```

In `tests/unit/form-logic.test.js`, rewrite around the new helpers — keep the existing `escapeHtml`/`orderRows` tests; replace seat/payload tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, pickerOptions, seatInfo } from '../../public/shared/form-logic.js';

const supplierOrg = (seats_used) => ({ id: 1, kind: 'supplier', name: 'A Supplier', seats_used });
const factoryOrg = (seats_used) => ({ id: 2, kind: 'factory', name: 'A Factory', seats_used });

test('suppliers allow 2 seats, factories 1', () => {
  assert.deepEqual(seatInfo(supplierOrg(0), 'supplier'), { left: 2, full: false, label: '· 2 seats left' });
  assert.deepEqual(seatInfo(supplierOrg(2), 'supplier'), { left: 0, full: true, label: '(full)' });
  assert.deepEqual(seatInfo(factoryOrg(0), 'factory'), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(factoryOrg(1), 'factory'), { left: 0, full: true, label: '(full)' });
});

test('no hints for the other side, other attendees, or a null from-type', () => {
  assert.deepEqual(seatInfo(supplierOrg(0), 'factory'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(supplierOrg(0), 'other'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(supplierOrg(0), null), { left: null, full: false, label: '' });
});

test('an own seat never counts as full even when at the limit', () => {
  assert.deepEqual(seatInfo(factoryOrg(1), 'factory', true), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(supplierOrg(2), 'supplier', true), { left: 1, full: false, label: '· 1 seat left' });
});

test('pickerOptions disables full orgs on the from side only', () => {
  const options = pickerOptions([supplierOrg(2), factoryOrg(1)], { kind: 'factory', fromType: 'factory' });
  assert.equal(options[0].disabled, true);
  const crossSide = pickerOptions([factoryOrg(1)], { kind: 'factory', fromType: 'supplier' });
  assert.equal(crossSide[0].disabled, false);
});

test('buildPayload sends org_ids without codes for supplier/factory attendees', () => {
  const payload = buildPayload({
    fromType: 'factory', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D',
    rows: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
  });
  assert.deepEqual(payload, {
    from_type: 'factory', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', website: '',
    orgs: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
  });
});

test('buildPayload for other attendees carries organisation_name, no orgs; photo_path only when set', () => {
  const baseArgs = { fromType: 'other', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', organisationName: 'Primark Limited' };
  assert.deepEqual(buildPayload(baseArgs), {
    from_type: 'other', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', website: '',
    organisation_name: 'Primark Limited', orgs: [],
  });
  const withPhoto = buildPayload({ ...baseArgs, photoPath: '123e4567-e89b-42d3-a456-426614174000.png' });
  assert.equal(withPhoto.photo_path, '123e4567-e89b-42d3-a456-426614174000.png');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `SEAT_LIMITS`/`ORGANISATION_OPTIONS` not exported, `validateRegistration` still expects the old payload.

- [ ] **Step 3: Replace `public/shared/constants.js`**

```js
// Event-wide settings shared by the browser (/shared/constants.js) and the server. Keep it dependency-free.
// The database functions in supabase/migrations enforce the same seat limits; change both together.

// Maximum attendees charged per organisation of each kind ("attending from" side).
export const SEAT_LIMITS = { supplier: 2, factory: 1 };

// All dates and times are shown and exported in the event's local time.
export const EVENT_TIME_ZONE = 'Asia/Dhaka';

// Organisation choices for attendees who register as "Other". Keep this list as the single place to edit.
// The last entry, "Other", reveals a free-text input in the form.
export const ORGANISATION_OPTIONS = [
  'Primark Limited',
  'Associated British Foods',
  'Maersk Bangladesh',
  'WAC - Bangladesh',
  'Uniglory Packaging Industries Limited',
  'Reflex Packaging Ltd.',
  'Union Label and Accessories Limited',
  'Epyllion Limited',
  'Youngshine Packtrims Limited',
  'Other',
];

// Photo uploads: JPEG or PNG, at most 1 MiB. Enforced in the form, the /api/photos route
// (magic bytes) and the storage bucket settings.
export const PHOTO_MAX_BYTES = 1024 * 1024;
```

- [ ] **Step 4: Replace `public/shared/validate.js`**

```js
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
    const ownKind = KINDS.includes(from_type) ? from_type : 'supplier';
    const otherKind = ownKind === 'supplier' ? 'factory' : 'supplier';
    orgs = (Array.isArray(src.orgs) ? src.orgs : []).map((raw, i) => validateOrg(raw, i, fields));
    const count = (kind) => orgs.filter((o) => o.kind === kind).length;
    if (count(ownKind) < 1 || count(ownKind) > MAX_ORGS_PER_KIND) {
      fields[plural[ownKind]] = `Select 1–${MAX_ORGS_PER_KIND} ${plural[ownKind]}.`;
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
```

- [ ] **Step 5: Replace `public/shared/form-logic.js`** (`escapeHtml` and `orderRows` unchanged; `isListed` is deleted)

```js
// Pure helpers for the registration form. No DOM access, so they can be unit tested in Node.
import { SEAT_LIMITS } from './constants.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ownSeat: the person being edited already holds a seat here. The server does not re-check such
// organisations, so they are never full for that person (even over the limit after "merge anyway").
export function seatInfo(org, fromType, ownSeat = false) {
  const limit = SEAT_LIMITS[org.kind];
  if (!limit || !fromType || org.kind !== fromType) return { left: null, full: false, label: '' };
  const used = org.seats_used - (ownSeat ? 1 : 0);
  const left = Math.max(ownSeat ? 1 : 0, limit - used);
  if (left === 0) return { left, full: true, label: '(full)' };
  return { left, full: false, label: `· ${left} seat${left === 1 ? '' : 's'} left` };
}

export function pickerOptions(orgs, { kind, fromType = null, selectedIds = new Set(), ownSeatIds = new Set() }) {
  return orgs
    .filter((o) => o.kind === kind && !selectedIds.has(o.id))
    .map((o) => {
      const info = seatInfo(o, fromType, ownSeatIds.has(o.id));
      return { value: String(o.id), text: o.name, hint: info.label, disabled: info.full };
    });
}

export function buildPayload({
  fromType, name, email, phone, designation, website = '', rows = [], photoPath = null, organisationName = '',
}) {
  const payload = { from_type: fromType, name, email, phone, designation, website };
  if (photoPath) payload.photo_path = photoPath;
  if (fromType === 'other') {
    payload.organisation_name = organisationName;
    payload.orgs = [];
  } else {
    payload.orgs = rows.map((r) => ({ kind: r.kind, org_id: r.org_id }));
  }
  return payload;
}

export function orderRows(rows) {
  return [...rows.filter((r) => r.kind === 'supplier'), ...rows.filter((r) => r.kind === 'factory')];
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit -- tests/unit/validate.test.js tests/unit/form-logic.test.js`
(If the runner needs the glob form: `node --test tests/unit/validate.test.js tests/unit/form-logic.test.js`.)
Expected: PASS for both files.

**Note:** other suites still referencing `SEAT_LIMIT` (admin-filters, dashboard, export, errors tests) will fail until Tasks 6 and 9 — expected; do not chase them here.

---


### Task 2: Organisation list files + import service/script

**Files:**
- Input (already created in planning): `scripts/data/suppliers.psv`, `scripts/data/factories.psv`
- Modify: `src/services/import.js` (full rewrite)
- Modify: `scripts/import-orgs.js`
- Test: `tests/unit/import.test.js` (full rewrite), `tests/unit/import-script.test.js` (small update)

**Interfaces:**
- Produces:
  - `parseList(text, kind)` → `[{ kind, code, name }]` — exported for tests
  - `readOrganisationLists(dir)` → `[{ kind, code, name }]` (80 suppliers + 168 factories from the two files)
  - `importOrganisations(db, orgs)` → `{ read, refreshed, pruned }` — upserts `(kind, match_key)` rows with `name`+`code`, then deletes `source='list'` rows absent from the files that have no `attendee_orgs` links
- Consumes: `runQuery` from `src/db.js`.

- [ ] **Step 1: Rewrite `tests/unit/import.test.js`** (xlsx fixtures are gone entirely; `exceljs` import removed)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseList, readOrganisationLists } from '../../src/services/import.js';

test('parseList trims rows, skips blanks and keeps commas inside names', () => {
  const rows = parseList('code|name\n 84016 | BIOWORLD INTERNATIONAL LTD FOB \n\n83666|HONG KONG DIJIA TUO TECHNOLOGY CO., LIMITED\n', 'supplier');
  assert.deepEqual(rows, [
    { kind: 'supplier', code: '84016', name: 'BIOWORLD INTERNATIONAL LTD FOB' },
    { kind: 'supplier', code: '83666', name: 'HONG KONG DIJIA TUO TECHNOLOGY CO., LIMITED' },
  ]);
});

test('parseList rejects a malformed line and a wrong header', () => {
  assert.throws(() => parseList('code|name\nNO-PIPE-HERE\n', 'supplier'), /line 2/i);
  assert.throws(() => parseList('name|code\n68740|ABA\n', 'supplier'), /header/i);
});

async function writeLists(t, suppliers, factories) {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'suppliers.psv'), suppliers);
  await writeFile(path.join(dir, 'factories.psv'), factories);
  return dir;
}

test('readOrganisationLists reads both files from a directory', async (t) => {
  const dir = await writeLists(t, 'code|name\n68740|ABA FASHIONS LTD\n', 'code|name\n24718|AB Apparels Ltd\n');
  assert.deepEqual(await readOrganisationLists(dir), [
    { kind: 'supplier', code: '68740', name: 'ABA FASHIONS LTD' },
    { kind: 'factory', code: '24718', name: 'AB Apparels Ltd' },
  ]);
});

test('the committed data files parse to 80 suppliers and 168 factories, all with codes', async () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'scripts', 'data');
  const orgs = await readOrganisationLists(dir);
  const suppliers = orgs.filter((o) => o.kind === 'supplier');
  const factories = orgs.filter((o) => o.kind === 'factory');
  assert.equal(suppliers.length, 80);
  assert.equal(factories.length, 168);
  assert.ok(orgs.every((o) => /^[0-9]{5}$/.test(o.code) && o.name.length > 0));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/unit/import.test.js`
Expected: FAIL — `parseList`/`readOrganisationLists` not exported.

- [ ] **Step 3: Rewrite `src/services/import.js`**

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runQuery } from '../db.js';

const FILES = { supplier: 'suppliers.psv', factory: 'factories.psv' };

// Pipe-delimited `code|name` per line (names can contain commas, so not CSV).
export function parseList(text, kind) {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.trim();
  if (header !== 'code|name') {
    throw new Error(`Expected header "code|name", found "${header}"`);
  }
  const orgs = [];
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return;
    const sep = line.indexOf('|');
    const code = sep === -1 ? '' : line.slice(0, sep).trim();
    const name = sep === -1 ? '' : line.slice(sep + 1).trim();
    if (!code || !name) throw new Error(`Bad line ${index + 2}: "${line.trim()}"`);
    orgs.push({ kind, code, name });
  });
  return orgs;
}

export async function readOrganisationLists(dir) {
  const orgs = [];
  for (const [kind, file] of Object.entries(FILES)) {
    orgs.push(...parseList(await readFile(path.join(dir, file), 'utf8'), kind));
  }
  return orgs;
}

const normalise = (name) => name.trim().toLowerCase();

export async function importOrganisations(db, orgs) {
  const rows = orgs.map((o) => ({ kind: o.kind, name: o.name, code: o.code, source: 'list', status: 'approved' }));
  const refreshed = await runQuery(
    db.from('organisations').upsert(rows, { onConflict: 'kind,match_key' }).select('id'),
  );

  // Remove list orgs that are no longer in the files, but never one an attendee links to.
  const keepKey = new Set(orgs.map((o) => `${o.kind}${normalise(o.name)}`));
  const listed = await runQuery(db.from('organisations').select('id, kind, name').eq('source', 'list'));
  const stale = listed.filter((o) => !keepKey.has(`${o.kind}${normalise(o.name)}`));
  let pruned = 0;
  if (stale.length) {
    const linked = await runQuery(
      db.from('attendee_orgs').select('org_id').in('org_id', stale.map((o) => o.id)),
    );
    const linkedIds = new Set(linked.map((l) => l.org_id));
    const removable = stale.filter((o) => !linkedIds.has(o.id)).map((o) => o.id);
    if (removable.length) {
      await runQuery(db.from('organisations').delete().in('id', removable));
      pruned = removable.length;
    }
  }
  return { read: rows.length, refreshed: refreshed.length, pruned };
}
```

- [ ] **Step 4: Rewrite `scripts/import-orgs.js`** (data dir argument optional; ExcelJS no longer used here)

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { importOrganisations, readOrganisationLists } from '../src/services/import.js';

const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const dir = process.argv[2] ?? defaultDir;

try {
  const orgs = await readOrganisationLists(dir);
  const suppliers = orgs.filter((o) => o.kind === 'supplier').length;
  const factories = orgs.length - suppliers;
  const { read, refreshed, pruned } = await importOrganisations(createDb(loadConfig()), orgs);

  console.log(
    `Read ${suppliers} suppliers and ${factories} factories; upserted ${refreshed}, pruned ${pruned} organisations no longer on the list.`,
  );
} catch (error) {
  // Bad path, wrong headers, missing env vars or a database error: one readable line, no stack trace.
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
}
```

Check `tests/unit/import-script.test.js` — it likely asserts usage text/the old xlsx flow. Update it to match (run it, fix the specific expectations to the new output line shape above).

- [ ] **Step 5: Run tests to verify**

Run: `node --test tests/unit/import.test.js tests/unit/import-script.test.js`
Expected: PASS.

---


### Task 3: Migration `005_carton_nomination.sql`

**Files:**
- Create: `supabase/migrations/005_carton_nomination.sql`
- No tests in this task (DB coverage is Task 10); gate = SQL review.

**Interfaces:**
- Produces (DB-level contracts consumed by routes/tests):
  - `organisations.code text`
  - `attendees.designation text not null default ''`, `attendees.organisation_name text`, `attendees.photo_path text`; `from_type in ('supplier','factory','other')`
  - storage bucket `attendee-photos` (private, 1 MiB limit, mime allowlist)
  - `register_attendee`/`update_attendee` accept the new payload; `private.prepare_registration` returns `[{org_id, code}]` with codes taken from `organisations.code`; `merge_org` uses the per-kind limit
  - Errors raised: `VALIDATION` (details: `from_type` | `contact` | `photo` | `orgs` | `organisation_name`), `ORG_NOT_FOUND`, `SEAT_FULL`, `DUPLICATE_EMAIL`, `MERGE_OVER_LIMIT`, `NOT_FOUND`
- Consumes: schema from `001`–`004`, including `private.delete_orphan_pending(bigint[])` and the lock-order/soft-check comments in 004.

- [ ] **Step 1: Create the migration** with exactly this content:

```sql
-- Carton Nomination Program update.
-- * Per-kind seat limits: supplier 2, factory 1 (charged only on the attending-from side).
-- * organisations.code holds the list code; registration codes are resolved server-side and
--   snapshotted into attendee_orgs.code as before.
-- * from_type gains 'other': no organisation links, no seats, organisation_name 2-150 instead.
-- * Attendees gain designation (required for new registrations) and photo_path (optional).
-- * storage bucket attendee-photos: private, <= 1 MiB, JPEG/PNG only. Only the server's
--   service_role key ever touches it (RLS has no policies for anyone else), so no extra
--   storage policies are needed.

alter table public.organisations
  add column if not exists code text;

alter table public.attendees
  add column if not exists designation text not null default '',
  add column if not exists organisation_name text,
  add column if not exists photo_path text;

alter table public.attendees drop constraint attendees_from_type_check;
alter table public.attendees
  add constraint attendees_from_type_check check (from_type in ('supplier', 'factory', 'other'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attendee-photos', 'attendee-photos', false, 1048576, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Validates the payload, resolves organisations by id, fills each code from organisations.code,
-- removes duplicates (first entry wins), locks the from-side organisations in id order and
-- checks the per-kind seat limit. Returns [{org_id, code}].
-- Raises VALIDATION, ORG_NOT_FOUND or SEAT_FULL.
create or replace function private.prepare_registration(
  p jsonb,
  p_exclude_attendee uuid,
  p_allow_pending boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_from text := p->>'from_type';
  v_entry jsonb;
  v_kind text;
  v_code text;
  v_org_id bigint;
  v_ids bigint[] := '{}';
  v_codes text[] := '{}';
  v_suppliers int;
  v_factories int;
  v_limit int;
  v_full jsonb;
begin
  if v_from is null or v_from not in ('supplier', 'factory', 'other') then
    raise exception 'VALIDATION' using detail = 'from_type';
  end if;
  if coalesce(btrim(p->>'name'), '') = ''
     or coalesce(btrim(p->>'email'), '') = ''
     or coalesce(btrim(p->>'phone'), '') = ''
     or coalesce(btrim(p->>'designation'), '') = '' then
    raise exception 'VALIDATION' using detail = 'contact';
  end if;
  -- Shape check only; real type/size validation happens in the /api/photos route before upload.
  if p->>'photo_path' is not null and p->>'photo_path'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$' then
    raise exception 'VALIDATION' using detail = 'photo';
  end if;
  if jsonb_typeof(p->'orgs') is distinct from 'array' then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  -- "Other" attendees belong to no supplier/factory and use no seats.
  if v_from = 'other' then
    if jsonb_array_length(p->'orgs') <> 0
       or char_length(btrim(coalesce(p->>'organisation_name', ''))) not between 2 and 150 then
      raise exception 'VALIDATION' using detail = 'organisation_name';
    end if;
    return '[]'::jsonb;
  end if;

  v_limit := case v_from when 'supplier' then 2 else 1 end;

  select count(*) filter (where e->>'kind' = 'supplier'),
         count(*) filter (where e->>'kind' = 'factory')
    into v_suppliers, v_factories
    from jsonb_array_elements(p->'orgs') as e;
  if (case v_from when 'supplier' then v_suppliers else v_factories end) not between 1 and 10
     or (case v_from when 'supplier' then v_factories else v_suppliers end) > 10
     or v_suppliers + v_factories <> jsonb_array_length(p->'orgs') then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  for v_entry in select value from jsonb_array_elements(p->'orgs') loop
    v_kind := v_entry->>'kind';
    if v_kind not in ('supplier', 'factory')
       or not (v_entry ? 'org_id')
       or (v_entry->>'org_id') !~ '^\d+$' then
      raise exception 'VALIDATION' using detail = 'orgs';
    end if;

    select o.id, coalesce(o.code, '')
      into v_org_id, v_code
      from public.organisations o
     where o.id = (v_entry->>'org_id')::bigint
       and o.kind = v_kind
       and (o.status = 'approved' or p_allow_pending);
    if v_org_id is null then
      raise exception 'ORG_NOT_FOUND' using detail = v_entry->>'org_id';
    end if;

    if array_position(v_ids, v_org_id) is null then
      v_ids := v_ids || v_org_id;
      v_codes := v_codes || v_code;
    end if;
  end loop;

  -- Lock in id order. FOR NO KEY UPDATE serialises seat checks without blocking the
  -- foreign-key checks (FOR KEY SHARE) of registrations from the other side, which
  -- FOR UPDATE would deadlock against.
  perform 1
     from public.organisations o
    where o.id = any (v_ids)
      and o.kind = v_from
    order by o.id
      for no key update;

  -- An edit is only checked at organisations it would newly charge. Where the person already
  -- holds a seat on this side the check is skipped, so edits still work after "merge anyway"
  -- has put an organisation over the limit. (p_exclude_attendee null: nothing is skipped.)
  select jsonb_agg(o.name order by o.name) into v_full
    from public.organisations o
   where o.id = any (v_ids)
     and o.kind = v_from
     and not exists (select 1
                       from public.attendee_orgs ao2
                       join public.attendees a2 on a2.id = ao2.attendee_id
                      where ao2.org_id = o.id
                        and a2.id = p_exclude_attendee
                        and a2.from_type = o.kind)
     and (select count(*)
            from public.attendee_orgs ao
            join public.attendees a on a.id = ao.attendee_id
           where ao.org_id = o.id
             and a.from_type = o.kind
             and a.id is distinct from p_exclude_attendee) >= v_limit;
  if v_full is not null then
    raise exception 'SEAT_FULL'
      using detail = jsonb_build_object('side', v_from, 'orgs', v_full)::text;
  end if;

  return (
    select jsonb_agg(jsonb_build_object('org_id', i.id, 'code', i.code) order by i.ord)
      from unnest(v_ids, v_codes) with ordinality as i (id, code, ord)
  );
end;
$$;

create or replace function public.register_attendee(p jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
  v_id uuid;
begin
  v_orgs := private.prepare_registration(p, null, false);

  begin
    insert into public.attendees (name, email, phone, designation, from_type, organisation_name, photo_path)
    values (btrim(p->>'name'), btrim(p->>'email'), btrim(p->>'phone'), btrim(p->>'designation'),
            p->>'from_type',
            case when p->>'from_type' = 'other' then btrim(p->>'organisation_name') end,
            p->>'photo_path')
    returning id into v_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  insert into public.attendee_orgs (attendee_id, org_id, code)
  select v_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  return v_id;
end;
$$;

create or replace function public.update_attendee(p_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
  v_old_org_ids bigint[];
begin
  perform 1 from public.attendees where id = p_id for no key update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  v_orgs := private.prepare_registration(p, p_id, true);

  begin
    update public.attendees
       set name = btrim(p->>'name'),
           email = btrim(p->>'email'),
           phone = btrim(p->>'phone'),
           designation = btrim(p->>'designation'),
           from_type = p->>'from_type',
           organisation_name = case when p->>'from_type' = 'other' then btrim(p->>'organisation_name') end,
           photo_path = p->>'photo_path',
           updated_at = now()
     where id = p_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  select array_agg(org_id) into v_old_org_ids from public.attendee_orgs where attendee_id = p_id;
  delete from public.attendee_orgs where attendee_id = p_id;
  insert into public.attendee_orgs (attendee_id, org_id, code)
  select p_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  perform private.delete_orphan_pending(v_old_org_ids);
end;
$$;

create or replace function public.merge_org(p_source bigint, p_target bigint, p_allow_over_limit boolean)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_source public.organisations;
  v_target public.organisations;
  v_count int;
  v_limit int;
begin
  -- Same lock order as prepare_registration (by id) to avoid deadlocks; see 004 for why
  -- the source takes FOR UPDATE and the target FOR NO KEY UPDATE.
  if p_source < p_target then
    perform 1 from public.organisations where id = p_source for update;
    perform 1 from public.organisations where id = p_target for no key update;
  else
    perform 1 from public.organisations where id = p_target for no key update;
    perform 1 from public.organisations where id = p_source for update;
  end if;

  select * into v_source from public.organisations where id = p_source;
  if v_source.id is null or v_source.status <> 'pending' then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_target from public.organisations where id = p_target;
  if v_target.id is null or v_target.status <> 'approved' or v_target.kind <> v_source.kind then
    raise exception 'VALIDATION' using detail = 'target';
  end if;

  select count(distinct a.id)::int into v_count
    from public.attendee_orgs ao
    join public.attendees a on a.id = ao.attendee_id
   where ao.org_id in (p_source, p_target)
     and a.from_type = v_target.kind;

  v_limit := case v_target.kind when 'supplier' then 2 else 1 end;
  if v_count > v_limit and not coalesce(p_allow_over_limit, false) then
    raise exception 'MERGE_OVER_LIMIT'
      using detail = jsonb_build_object('target', v_target.name, 'side', v_target.kind, 'count', v_count)::text;
  end if;

  insert into public.attendee_orgs (attendee_id, org_id, code)
  select ao.attendee_id, p_target, ao.code
    from public.attendee_orgs ao
   where ao.org_id = p_source
  on conflict (attendee_id, org_id) do nothing;

  delete from public.attendee_orgs where org_id = p_source;
  delete from public.organisations where id = p_source;

  return v_count;
end;
$$;
```

Notes for the implementer:
- `create or replace` preserves the service_role grants from 002/003; no `grant` statements needed.
- `delete_attendee` (004) is unchanged.
- `designated` default `''` keeps pre-005 rows readable; non-empty is enforced for every payload from now on (DB check + shared validator).

- [ ] **Step 2: Verify**

Run: apply to the **test** Supabase project via SQL editor (see Task 10) — offline gate here is a careful read-through plus the db test suite once applied. Do NOT hand-edit 001–004.

---


### Task 4: Photo upload service + endpoint

**Files:**
- Create: `src/services/photo.js`
- Create: `src/routes/photos.js`
- Modify: `src/create-app.js` (mount the router before the JSON-only API routes)
- Modify: `tests/helpers/fake-db.js` (add a storage stub)
- Test: `tests/unit/photo.test.js` (create), `tests/api/photos.test.js` (create)

**Interfaces:**
- Produces:
  - `PHOTO_BUCKET = 'attendee-photos'`, `sniffPhoto(buffer)` → `null | { ext: 'jpg'|'png', contentType }`, `newPhotoPath(ext)` → `'<uuid>.jpg|png'`, `photoContentType(path)` → `'image/jpeg'|'image/png'` (used by the admin proxy in Task 5)
  - `photosRoutes({ db })` → an Express Router with its own `express.raw` parser
  - `POST /api/photos` (public) → `201 { path }`; rejects with `VALIDATION{photo}` for wrong type/size/spoofed content-type
- Consumes: `config`/`db` (supabase-js storage), `errors` from `src/errors.js`.

- [ ] **Step 1: Write the failing unit tests** — `tests/unit/photo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPhotoPath, PHOTO_BUCKET, photoContentType, sniffPhoto } from '../../src/services/photo.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

test('sniffs JPEG and PNG by magic bytes, rejects anything else', () => {
  assert.deepEqual(sniffPhoto(JPEG), { ext: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(sniffPhoto(PNG), { ext: 'png', contentType: 'image/png' });
  assert.equal(sniffPhoto(GIF), null);
  assert.equal(sniffPhoto(Buffer.from('<html>')), null);
  assert.equal(sniffPhoto(Buffer.alloc(0)), null);
  assert.equal(sniffPhoto(undefined), null);
});

test('photo paths are uuid.ext and carry a matching content type', () => {
  const path = newPhotoPath('png');
  assert.match(path, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  assert.equal(photoContentType(path), 'image/png');
  assert.equal(photoContentType(newPhotoPath('jpg')), 'image/jpeg');
  assert.notEqual(newPhotoPath('jpg'), newPhotoPath('jpg'));
});

test('bucket name stays in one place', () => {
  assert.equal(PHOTO_BUCKET, 'attendee-photos');
});
```

- [ ] **Step 2: Write the failing API tests** — `tests/api/photos.test.js` (follow `tests/api/public.test.js` conventions; the app comes from `createApp({ db, config, loginDelayMs: 0 })`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(100)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(100)]);
const UPLOADED = [];

function appWithStorage() {
  const db = fakeDb();
  db.storage = {
    from: (bucket) => ({
      upload: (path, body, opts) => {
        UPLOADED.push({ bucket, path, size: body.length, contentType: opts.contentType });
        return Promise.resolve({ data: { path }, error: null });
      },
    }),
  };
  return createApp({ db, config: testConfig, loginDelayMs: 0 });
}

test('accepts a PNG under 1 MB and stores it in the private bucket', async () => {
  UPLOADED.length = 0;
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(PNG);
  assert.equal(res.status, 201);
  assert.match(res.body.path, /\.png$/);
  assert.equal(UPLOADED.length, 1);
  assert.equal(UPLOADED[0].bucket, 'attendee-photos');
  assert.equal(UPLOADED[0].contentType, 'image/png');
});

test('rejects a content type outside JPEG/PNG', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/gif')
    .send(Buffer.from([0x47, 0x49, 0x46, 0x38]));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('rejects a spoofed content type (JSON bytes labelled image/png)', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(Buffer.from('{"not":"an image"}'));
  assert.equal(res.status, 400);
  assert.equal(res.body.fields.photo.length > 0, true);
});

test('rejects a labelled-JPEG whose bytes are PNG (content type must match magic bytes)', async () => {
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(PNG);
  assert.equal(res.status, 400);
});

test('rejects a file over 1 MB even with valid magic bytes', async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(big);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('storage failures map to DB_UNAVAILABLE, not a crash', async () => {
  const db = fakeDb();
  db.storage = { from: () => ({ upload: () => Promise.resolve({ data: null, error: new Error('boom') }) }) };
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .post('/api/photos')
    .set('Content-Type', 'image/png')
    .send(PNG);
  assert.equal(res.status, 503);
});

test('JPEG uploads land with a .jpg path', async () => {
  UPLOADED.length = 0;
  const res = await request(appWithStorage())
    .post('/api/photos')
    .set('Content-Type', 'image/jpeg')
    .send(JPEG);
  assert.equal(res.status, 201);
  assert.match(res.body.path, /\.jpg$/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/unit/photo.test.js tests/api/photos.test.js`
Expected: FAIL — module/route missing.

- [ ] **Step 4: Create `src/services/photo.js`**

```js
import { randomUUID } from 'node:crypto';
import { PHOTO_MAX_BYTES } from '../../public/shared/constants.js';

export const PHOTO_BUCKET = 'attendee-photos';
export const PHOTO_UPLOAD_LIMIT = '1500kb'; // parser ceiling; the 1 MiB rule below is the real limit

const SIGNATURES = [
  { ext: 'jpg', contentType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', contentType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];

// Magic-byte sniff so a renamed or mislabelled file is still rejected.
export function sniffPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  return SIGNATURES.find((sig) => sig.bytes.every((byte, i) => buffer[i] === byte)) ?? null;
}

export function newPhotoPath(ext) {
  return `${randomUUID()}.${ext}`;
}

export function photoContentType(path) {
  return path.endsWith('.png') ? 'image/png' : 'image/jpeg';
}

export function photoTooLarge(buffer) {
  return !Buffer.isBuffer(buffer) || buffer.length > PHOTO_MAX_BYTES;
}
```

- [ ] **Step 5: Create `src/routes/photos.js`**

```js
import express, { Router } from 'express';
import { errors } from '../errors.js';
import {
  newPhotoPath, PHOTO_BUCKET, PHOTO_UPLOAD_LIMIT, photoTooLarge, sniffPhoto,
} from '../services/photo.js';

const TYPE_MESSAGE = 'Please choose a JPG or PNG image.';
const SIZE_MESSAGE = 'Photo must be 1 MB or smaller.';

export function photosRoutes({ db }) {
  const router = Router();
  // Runs instead of express.json for image bodies: create-app's json parser only matches JSON
  // content types, so this raw parser (its own ceiling above the 1 MiB rule) sees every upload.
  router.post(
    '/photos',
    express.raw({ type: ['image/jpeg', 'image/png'], limit: PHOTO_UPLOAD_LIMIT }),
    async (req, res) => {
      const sig = sniffPhoto(req.body);
      if (!sig || sig.contentType !== req.headers['content-type']) {
        throw errors.validation({ photo: TYPE_MESSAGE });
      }
      if (photoTooLarge(req.body)) throw errors.validation({ photo: SIZE_MESSAGE });
      const path = newPhotoPath(sig.ext);
      const { error } = await db.storage
        .from(PHOTO_BUCKET)
        .upload(path, req.body, { contentType: sig.contentType });
      if (error) throw Object.assign(errors.dbUnavailable(), { cause: error });
      res.status(201).json({ path });
    },
  );
  return router;
}
```

`express.raw` with a non-matching content type leaves `req.body` unparsed (`{}`), so a GIF upload fails the sniff as desired. A body over the 1500kb parser ceiling throws `entity.too.large`, which the existing error handler maps to a 400 — still rejected regardless of the client.

- [ ] **Step 6: Add a default storage stub to `tests/helpers/fake-db.js`**

Keeps existing API tests passing once admin routes (Task 5) start calling `db.storage`:

```js
export function fakeDb({ rpc = {}, tables = {}, storage = {} } = {}) {
  const calls = [];
  return {
    calls,
    // storage ops: upload/remove resolve ok; override by replacing db.storage in a test.
    storage: Object.assign(
      {
        from: (bucket) => ({
          upload: (path, body, opts) => {
            calls.push({ storage: bucket, op: 'upload', path, size: body?.length, contentType: opts?.contentType });
            return Promise.resolve({ data: { path }, error: null });
          },
          download: (path) => {
            calls.push({ storage: bucket, op: 'download', path });
            return Promise.resolve({ data: new Blob([]), error: null });
          },
          remove: (paths) => {
            calls.push({ storage: bucket, op: 'remove', paths });
            return Promise.resolve({ data: [], error: null });
          },
        }),
      },
      storage,
    ),
    rpc(fn, args) { /* unchanged */ },
    from(table) { /* unchanged */ },
  };
}
```

(Only the `storage` key is new; keep the existing `rpc` and `from` implementations exactly as they are.)

- [ ] **Step 7: Mount the router in `src/create-app.js`**

```js
import { photosRoutes } from './routes/photos.js';
// ...
app.use('/api', publicRoutes({ db, config }));
app.use('/api', photosRoutes({ db }));   // next to the other /api mounts
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test tests/unit/photo.test.js tests/api/photos.test.js`
Expected: PASS (7 API tests + 3 unit tests).

---


### Task 5: Register/update/delete wiring + admin photo proxy

`POST /api/register` needs **no code change** — `validateRegistration` (Task 1) already shapes the new payload and `register_attendee` (Task 3) consumes it. This task covers the admin routes: photo cleanup on update/delete and the authenticated photo proxy.

**Files:**
- Modify: `src/routes/admin.js`
- Test: `tests/api/public.test.js` (payload shape), `tests/api/admin.test.js` (cleanup + proxy)

**Interfaces:**
- Consumes: `PHOTO_BUCKET`, `photoContentType` from `src/services/photo.js` (Task 4); `runQuery` from `src/db.js` (add to the existing `callRpc` import).
- Produces: `GET /api/admin/participants/:id/photo` → `200 image/jpeg|image/png` (admin cookie) | `404`; PUT/DELETE keep their bodies/statuses but remove orphaned storage objects best-effort.

- [ ] **Step 1: Update `tests/api/public.test.js`** — new payload shape; error message changes land in Task 6:

```js
const body = () => ({
  from_type: 'factory',
  name: ' Rahim Uddin ',
  designation: 'Merchandiser',
  email: 'rahim@example.com',
  phone: '+880 1711-000000',
  website: '',
  orgs: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
});
```

Adjust assertions: `'website' in db.calls[0].args.p === false` stays; the invalid-body test uses `{ ...body(), email: 'nope', orgs: [] }` and asserts `res.body.fields.factories` (from-kind is factory → error key is `factories`, not `suppliers`). Add one photo-focused case:

```js
test('a junk photo_path is rejected before the database is called', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), photo_path: '../etc/passwd' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.photo);
  assert.equal(db.calls.length, 0);
});
```

- [ ] **Step 2: Update and extend `tests/api/admin.test.js`**

- `body()` becomes: `{ from_type: 'supplier', name: 'Rahim Uddin', designation: 'Merchandiser', email: 'rahim@example.com', phone: '+8801711000000', orgs: [{ kind: 'supplier', org_id: 1 }] }`.
- `protectedRoutes` gains `['get', \`/api/admin/participants/${PERSON_ID}/photo\`]`.
- PUT ok-case: the first db call is now the `attendees` table read; change `db.calls[0].fn` assertions to `const rpc = db.calls.find((c) => c.fn === 'update_attendee'); assert.equal(rpc.args.p_id, PERSON_ID); assert.equal(rpc.args.p.email, 'rahim@example.com');`
- DELETE: replace `db.calls[0]` with `db.calls.find((c) => c.fn === 'delete_attendee')`.
- Login/`/data` test: fixture now has 4 participants (Task 6) → `data.body.summary.participants.total` becomes `4`.
- Add:

```js
test('PUT removes the old storage object when the photo changes, and never when it does not', async () => {
  const OLD = '00000000-0000-4000-8000-00000000000a.jpg';
  const NEW = '00000000-0000-4000-8000-00000000000b.jpg';
  const db = fakeDb({ tables: { attendees: { data: [{ photo_path: OLD }], error: null } } });
  const app = appWith(db);

  const changed = await request(app).put(`/api/admin/participants/${PERSON_ID}`)
    .set('Cookie', validCookie()).send({ ...body(), photo_path: NEW });
  assert.equal(changed.status, 200);
  assert.deepEqual(db.calls.find((c) => c.op === 'remove'), { storage: 'attendee-photos', op: 'remove', paths: [OLD] });

  db.calls.length = 0;
  const same = await request(app).put(`/api/admin/participants/${PERSON_ID}`)
    .set('Cookie', validCookie()).send({ ...body(), photo_path: OLD });
  assert.equal(same.status, 200);
  assert.equal(db.calls.some((c) => c.op === 'remove'), false);
});

test('DELETE removes the attendee photo object after a successful delete', async () => {
  const OLD = '00000000-0000-4000-8000-00000000000a.jpg';
  const db = fakeDb({ tables: { attendees: { data: [{ photo_path: OLD }], error: null } } });
  const res = await request(appWith(db)).delete(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie());
  assert.equal(res.status, 200);
  const order = db.calls.map((c) => c.fn ?? c.op);
  assert.ok(order.includes('delete_attendee'));
  assert.ok(order.indexOf('delete_attendee') < order.indexOf('remove'));
  assert.deepEqual(db.calls.find((c) => c.op === 'remove').paths, [OLD]);
});

test('GET /participants/:id/photo streams the stored image with its content type', async () => {
  const PATH = '00000000-0000-4000-8000-00000000000a.png';
  const db = fakeDb({ tables: { attendees: { data: [{ photo_path: PATH }], error: null } } });
  db.storage.from = () => ({
    download: (p) => Promise.resolve({ data: new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]), error: null, path: p }),
  });
  const res = await request(appWith(db)).get(`/api/admin/participants/${PERSON_ID}/photo`).set('Cookie', validCookie());
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(res.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('GET /participants/:id/photo is 404 without a photo or when the object is gone', async () => {
  const none = await request(appWith(fakeDb({ tables: { attendees: { data: [{ photo_path: null }], error: null } } })))
    .get(`/api/admin/participants/${PERSON_ID}/photo`).set('Cookie', validCookie());
  assert.equal(none.status, 404);

  const db = fakeDb({ tables: { attendees: { data: [{ photo_path: '00000000-0000-4000-8000-00000000000a.jpg' }], error: null } } });
  db.storage.from = () => ({ download: () => Promise.resolve({ data: null, error: new Error('not found') }) });
  const gone = await request(appWith(db)).get(`/api/admin/participants/${PERSON_ID}/photo`).set('Cookie', validCookie());
  assert.equal(gone.status, 404);
});
```

(If the DELETE ordering assertion feels brittle, assert instead: `remove` call exists and `delete_attendee` rpc exists — cleanup ordering is best-effort by design.)

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/api/public.test.js tests/api/admin.test.js`
Expected: FAIL — no photo cleanup/proxy yet.

- [ ] **Step 4: Implement in `src/routes/admin.js`**

Add imports: `import { callRpc, runQuery } from '../db.js';` (replacing the `callRpc`-only import) and `import { PHOTO_BUCKET, photoContentType } from '../services/photo.js';`. Add helpers above `adminRoutes`:

```js
async function currentPhotoPath(db, id) {
  const rows = await runQuery(db.from('attendees').select('photo_path').eq('id', id));
  return rows?.[0]?.photo_path ?? null;
}

// Best effort: storage lives outside the DB transaction, so a failed remove is only logged.
function dropPhoto(db, path, context) {
  if (!path) return;
  Promise.resolve(db.storage.from(PHOTO_BUCKET).remove([path]))
    .then(({ error }) => { if (error) throw error; })
    .catch((error) => console.warn(`Photo cleanup failed (${context}, ${path}):`, error.message));
}
```

Rewire the routes:

```js
router.get('/participants/:id/photo', async (req, res) => {
  const id = participantId(req.params.id);
  const path = await currentPhotoPath(db, id);
  if (!path) throw errors.notFound();
  const { data, error } = await db.storage.from(PHOTO_BUCKET).download(path);
  if (error || !data) throw errors.notFound();
  res.set({ 'Content-Type': photoContentType(path), 'Cache-Control': 'private, max-age=300' });
  res.send(Buffer.from(await data.arrayBuffer()));
});

router.put('/participants/:id', async (req, res) => {
  const id = participantId(req.params.id);
  const result = validateRegistration(req.body);
  if (!result.ok) throw errors.validation(result.fields);
  const oldPath = await currentPhotoPath(db, id);
  await callRpc(db, 'update_attendee', { p_id: id, p: result.value });
  if (oldPath !== result.value.photo_path) dropPhoto(db, oldPath, 'photo replaced');
  res.json({ ok: true });
});

router.delete('/participants/:id', async (req, res) => {
  const id = participantId(req.params.id);
  const oldPath = await currentPhotoPath(db, id);
  await callRpc(db, 'delete_attendee', { p_id: id });
  dropPhoto(db, oldPath, 'attendee deleted');
  res.json({ ok: true });
});
```

Route order note: place `GET /participants/:id/photo` **next to** the other `/participants/:id` routes, all behind `router.use(requireAdmin(config))` — that middleware already covers it. Do not add it before the login routes.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/api/public.test.js tests/api/admin.test.js tests/api/photos.test.js`
Expected: PASS.

---


### Task 6: Dashboard service, export, error messages (+ fixtures)

**Files:**
- Modify: `src/services/dashboard.js`
- Modify: `src/services/export.js`
- Modify: `src/errors.js`
- Modify: `tests/helpers/dashboard-fixture.js`
- Test: `tests/unit/dashboard.test.js`, `tests/unit/export.test.js`, `tests/unit/errors.test.js`, `tests/unit/admin-filters.test.js`, `tests/api/export.test.js`, `tests/api/public.test.js` (SEAT_FULL message), `tests/api/admin.test.js` (total 3 → 4, done in Task 5)

**Interfaces:**
- Produces:
  - `registrationStatus({ seats_used, linked_count, kind })` — per-kind "full"
  - dashboard participants gain `designation`, `organisation_name`, `photo_path`; `summary.participants.other`
  - participants row for `other` attendees shows their organisation name; photo presence via `photo_path`
  - `fromDbError` messages: `Already full (factory limit 1): …` / `… (limit 1). Merge anyway?`
- Consumes: `SEAT_LIMITS` from `/shared/constants.js`; fixture shape below.

- [ ] **Step 1: Update `tests/helpers/dashboard-fixture.js`** — add the new attendee fields and one "other" attendee:

```js
// Rows shaped like org_status (ordered by name) and attendees with embedded attendee_orgs.
export const fixtureNow = new Date('2026-09-17T08:30:00Z');

export const fixtureOrgs = [
  { id: 3, kind: 'factory', name: 'Aspire Garments (24040)', source: 'list', status: 'approved', seats_used: 2, linked_count: 2, created_at: '2026-09-01T00:00:00Z' },
  { id: 6, kind: 'supplier', name: 'New Supplier Co', source: 'attendee', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-10T00:00:00Z' },
  { id: 1, kind: 'supplier', name: 'Padma Textiles Ltd', source: 'list', status: 'approved', seats_used: 1, linked_count: 2, created_at: '2026-09-01T00:00:00Z' },
  { id: 2, kind: 'supplier', name: 'Pearl Global', source: 'list', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-01T00:00:00Z' },
  { id: 5, kind: 'factory', name: 'Rainbow Knit Ltd', source: 'attendee', status: 'pending', seats_used: 1, linked_count: 1, created_at: '2026-09-17T06:15:00Z' },
  { id: 4, kind: 'factory', name: 'Windy Apparels (20096)', source: 'list', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-01T00:00:00Z' },
];

export const fixtureAttendees = [
  {
    id: 'a1', name: 'Rahim Uddin', designation: 'Merchandiser', email: 'rahim@example.com', phone: '+8801711000001',
    from_type: 'factory', organisation_name: null, photo_path: '123e4567-e89b-42d3-a456-426614174000.jpg',
    created_at: '2026-09-17T08:00:00Z', updated_at: '2026-09-17T08:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1' }, { org_id: 5, code: 'R-5' }, { org_id: 3, code: 'F-3' }],
  },
  {
    id: 'a2', name: 'Karim Ahmed', designation: 'QA Executive', email: 'karim@example.com', phone: '+8801711000002',
    from_type: 'factory', organisation_name: null, photo_path: null,
    created_at: '2026-09-17T09:00:00Z', updated_at: '2026-09-17T09:00:00Z',
    attendee_orgs: [{ org_id: 3, code: 'F-3b' }],
  },
  {
    id: 'a3', name: 'Salma Begum', designation: 'Director', email: 'salma@example.com', phone: '+8801711000003',
    from_type: 'supplier', organisation_name: null, photo_path: null,
    created_at: '2026-09-17T10:00:00Z', updated_at: '2026-09-17T10:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1c' }],
  },
  {
    id: 'a4', name: 'Nadia Islam', designation: 'Sustainability Lead', email: 'nadia@example.com', phone: '+8801711000004',
    from_type: 'other', organisation_name: 'Primark Limited', photo_path: null,
    created_at: '2026-09-17T11:00:00Z', updated_at: '2026-09-17T11:00:00Z',
    attendee_orgs: [],
  },
];
```

(Aspire keeps `seats_used: 2` past the factory limit of 1 — exactly what "merge anyway" can produce — so `full` and the over-limit badge stay exercised.)

- [ ] **Step 2: Update the unit tests** (write these first, watch fail)

`tests/unit/dashboard.test.js`:
- `registrationStatus`: now takes `kind` — `assert.equal(registrationStatus({ seats_used: 1, linked_count: 1, kind: 'factory' }), 'full');` and `assert.equal(registrationStatus({ seats_used: 1, linked_count: 1, kind: 'supplier' }), 'registered');` plus the previous boundaries updated (`supplier` full at 2).
- Summary expectation becomes:
```js
assert.deepEqual(d.summary, {
  participants: { total: 4, supplier: 1, factory: 2, other: 1 },
  suppliers: { list_total: 2, list_registered: 1, missing: 2, full: 0 },
  factories: { list_total: 2, list_registered: 1, missing: 1, full: 1 },
  pending: '\u0031' —–> pending: 1,
});
```
- Participants test: assert `rahim.designation === 'Merchandiser'`, `rahim.photo_path` set; add an "other" assertion:
```js
const nadia = data().participants.find((p) => p.from_type === 'other');
assert.equal(nadia.organisation_name, 'Primark Limited');
assert.deepEqual(nadia.suppliers, []);
assert.deepEqual(nadia.factories, []);
```
- `links to organisations missing…` test: spread now needs the extra fields — use `{ ...fixtureAttendees[1], ... }` as before (fixture carries them).

`tests/unit/errors.test.js`:
- SEAT_FULL message → `'Already full (factory limit 1): Aspire (1); Windy (2). Remove them or contact the event team.'`
- MERGE_OVER_LIMIT stays `'PADMA TEXTILES LTD would have 3 supplier attendees (limit 2). Merge anyway?'` (supplier limit 2); add a factory case:
```js
const factory = fromDbError(dbError('MERGE_OVER_LIMIT', JSON.stringify({ target: 'Aspire (24040)', side: 'factory', count: 2 })));
assert.equal(factory.message, 'Aspire (24040) would have 2 factory attendees (limit 1). Merge anyway?');
```

`tests/unit/export.test.js`:
- Summary: `summary.Participants === 4`; add `summary['Participants from other orgs'] === 1`.
- Participants sheet headers become:
```js
['Name', 'Designation', 'Email', 'Phone', 'From', 'Suppliers', 'Supplier codes', 'Factories', 'Factory codes', 'Organisation (other)', 'Photo', 'Registered at']
```
rowCount 5; Rahim's row:
```js
['Rahim Uddin', 'Merchandiser', 'rahim@example.com', '+8801711000001', 'Factory',
 'Padma Textiles Ltd', 'S-1', 'Aspire Garments (24040); Rainbow Knit Ltd', 'F-3; R-5', '', 'Y', '2026-09-17 14:00']
```
Nadia's row: `['Nadia Islam', 'Sustainability Lead', 'nadia@example.com', '+8801711000004', 'Other', '', '', '', '', 'Primark Limited', 'N', '2026-09-17 17:00']`.
- Participant-Orgs unchanged (other attendee has no links): rowCount `1 + 5` stays.

`tests/unit/admin-filters.test.js`:
- `filterParticipants(data.participants, {})` length becomes 4.
- Add: `assert.deepEqual(names(filterParticipants(data.participants, { side: 'other' })), ['Nadia Islam']);`
- Search now also covers designation and organisation_name:
```js
assert.deepEqual(names(filterParticipants(data.participants, { search: 'merchandiser' })), ['Rahim Uddin']);
assert.deepEqual(names(filterParticipants(data.participants, { search: 'primark' })), ['Nadia Islam']);
```

`tests/api/export.test.js`: after reading it at execution time, update any Participants-hader/row-count assertions to the new columns (12 columns, 5 data rows with the fixture). Also the participants-total assertions if present (3 → 4).

`tests/api/public.test.js` SEAT_FULL case: expected body message → `'Already full (factory limit 1): Aspire (24040). Remove them or contact the event team.'`

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/unit/dashboard.test.js tests/unit/export.test.js tests/unit/errors.test.js tests/unit/admin-filters.test.js`
Expected: FAIL (registrationStatus kind, summary counts, headers).

- [ ] **Step 4: Implement**

`src/services/dashboard.js`:
```js
import { SEAT_LIMITS } from '../../public/shared/constants.js';
// ...
export function registrationStatus({ seats_used, linked_count, kind }) {
  if (seats_used >= SEAT_LIMITS[kind]) return 'full';
  if (linked_count >= 1) return 'registered';
  return 'missing';
}
// loadDashboard select becomes:
db.from('attendees').select('id, name, email, phone, designation, from_type, organisation_name, photo_path, created_at, updated_at, attendee_orgs(org_id, code)')
// participants objects gain:
designation: a.designation,
organisation_name: a.organisation_name,
photo_path: a.photo_path,
// summary:
participants: {
  total: participants.length,
  supplier: participants.filter((p) => p.from_type === 'supplier').length,
  factory: participants.filter((p) => p.from_type === 'factory').length,
  other: participants.filter((p) => p.from_type === 'other').length,
},
```
`peopleByOrg` entries stay `{ id, name, from_type, code }` (no designation there).

`src/services/export.js`:
- `const SIDE = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };`
- Summary sheet gains `{ item: 'Participants from other orgs', value: s.participants.other }` after the factory line.
- Participants sheet:
```js
addSheet(workbook, 'Participants', [
  ['Name', 'name', 25], ['Designation', 'designation', 22], ['Email', 'email', 30], ['Phone', 'phone', 18],
  ['From', 'from', 10], ['Suppliers', 'suppliers', 45], ['Supplier codes', 'supplier_codes', 20],
  ['Factories', 'factories', 45], ['Factory codes', 'factory_codes', 20],
  ['Organisation (other)', 'organisation', 30], ['Photo', 'photo', 8], ['Registered at', 'registered_at', 18],
], data.participants.map((p) => ({
  name: p.name,
  designation: p.designation,
  email: p.email,
  phone: p.phone,
  from: SIDE[p.from_type],
  suppliers: names(p.suppliers),
  supplier_codes: codes(p.suppliers),
  factories: names(p.factories),
  factory_codes: codes(p.factories),
  organisation: p.organisation_name ?? '',
  photo: p.photo_path ? 'Y' : 'N',
  registered_at: formatDhaka(p.created_at),
})));
```
Everything else (Participant-Orgs, Suppliers/Factories, Missing, Pending) stays as-is.

`src/errors.js`:
```js
import { SEAT_LIMITS } from '../public/shared/constants.js';
// SEAT_FULL:
`Already full (${side} limit ${SEAT_LIMITS[side]}): ${orgs.join('; ')}. Remove them or contact the event team.`
// MERGE_OVER_LIMIT:
`${target} would have ${count} ${side} attendees (limit ${SEAT_LIMITS[side]}). Merge anyway?`
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/unit/dashboard.test.js tests/unit/export.test.js tests/unit/errors.test.js tests/unit/admin-filters.test.js tests/api/public.test.js tests/api/admin.test.js`
Expected: PASS.

---


### Task 7: Public registration form rewrite

**Files:**
- Modify: `public/js/registration-form.js` (full rewrite)
- Modify: `public/js/register.js` (confirmation screen)
- Test: `tests/unit/form-logic.test.js` already covers pure helpers; this task relies on manual smoke (Task 11).

**Interfaces:**
- Produces: `mountRegistrationForm(container, { orgs, initial?, submitLabel?, onSubmit, reloadOrgs?, photoUrl? })` with the same admin-edit compatibility.
- Consumes: `validateRegistration`, `PHOTO_PATH_RE` from `/shared/validate.js`; `ORGANISATION_OPTIONS`, `PHOTO_MAX_BYTES` from `/shared/constants.js`; `buildPayload`, `escapeHtml`, `orderRows`, `pickerOptions`, `seatInfo` from `/shared/form-logic.js`; `api` from `./api.js` (not used for photo upload because it sends JSON; photo uses raw `fetch`).

- [ ] **Step 1: Replace `public/js/registration-form.js`** with:

```js
import { MAX_ORGS_PER_KIND, validateRegistration } from '/shared/validate.js';
import { ORGANISATION_OPTIONS, PHOTO_MAX_BYTES } from '/shared/constants.js';
import { buildPayload, escapeHtml, orderRows, pickerOptions, seatInfo } from '/shared/form-logic.js';

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
 *   orgs        approved organisations [{ id, kind, name, seats_used }]
 *   initial     a dashboard participant to edit (admin only)
 *   submitLabel button text
 *   onSubmit    async (payload) => void; throw an api() error to show it on the form
 *   reloadOrgs  async () => orgs; used to refresh seat hints after SEAT_FULL
 *   photoUrl    URL to show an existing photo in admin edit (null for public form)
 */
export function mountRegistrationForm(container, { orgs, initial = null, submitLabel = 'Register', onSubmit, reloadOrgs = null, photoUrl = null }) {
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
    photoPath: initial?.photo_path ?? null,
    orgName: '',
    orgCustom: '',
    uploading: false,
  };
  const ownSeatIds = () => (initial && state.fromType === initial.from_type ? originalSeatIds : new Set());
  let enteringKey = null;
  let previewObjectUrl = null;

  container.innerHTML = `
    <form class="reg-form" method="post" novalidate>
      <p class="alert" role="alert" hidden></p>
      <fieldset class="field">
        <legend>You are attending from <span class="req">*</span></legend>
        <div class="radios">
          ${FROM_OPTIONS.map((o) => `<label><input type="radio" name="from_type" value="${o.value}"> ${o.label}</label>`).join('')}
        </div>
        <p class="field-error" data-error="from_type"></p>
      </fieldset>

      <div data-kind-sections>
        ${KINDS.map(({ kind, label, search, errorKey }) => `
          <section class="field org-block">
            <label for="picker-${kind}-${uid}">${label} <span class="req">*</span></label>
            <select id="picker-${kind}-${uid}" data-picker="${kind}" placeholder="${search}"></select>
            <ul class="org-rows" data-rows="${kind}"></ul>
            <p class="field-error" data-error="${errorKey}"></p>
          </section>`).join('')}
      </div>

      <section class="field" data-other-org hidden>
        <label for="orgname-${uid}">Organization Name <span class="req">*</span></label>
        <select id="orgname-${uid}" data-org-name placeholder="Search organisations…"></select>
        <input data-field="org_name_custom" maxlength="150" placeholder="Enter your organisation name *" aria-label="Organisation name" hidden>
        <p class="field-error" data-error="organisation_name"></p>
      </section>

      <section class="sub-card">
        <h2 class="sub-card-title">Attendee information</h2>
        <div class="field">
          <label for="name-${uid}">Attendee name <span class="req">*</span></label>
          <input id="name-${uid}" name="name" autocomplete="name" maxlength="100">
        </div>
        <div class="field">
          <label for="designation-${uid}">Designation <span class="req">*</span></label>
          <input id="designation-${uid}" name="designation" autocomplete="organization-title" maxlength="100">
        </div>
        <div class="field">
          <label for="email-${uid}">Email <span class="req">*</span></label>
          <input id="email-${uid}" name="email" type="email" autocomplete="email" maxlength="254">
        </div>
        <div class="field">
          <label for="phone-${uid}">Phone <span class="req">*</span></label>
          <input id="phone-${uid}" name="phone" type="tel" autocomplete="tel" maxlength="30">
        </div>
        <div class="field">
          <label for="photo-${uid}">Photo <span class="muted">(optional — JPG or PNG, max 1 MB)</span></label>
          <input id="photo-${uid}" type="file" accept="image/jpeg,image/png" data-photo-input>
          <p class="field-error" data-error="photo"></p>
          <div class="photo-preview" data-photo-preview hidden>
            <img data-photo-img alt="Attendee photo preview">
            <button type="button" class="link-btn" data-photo-remove>Remove photo</button>
          </div>
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

  const pickers = Object.fromEntries(KINDS.map(({ kind }) => [kind, new window.TomSelect(
    form.querySelector(`[data-picker="${kind}"]`),
    {
      maxOptions: 500,
      searchField: ['text'],
      render: {
        option: (data, escape) => `<div class="picker-option">${escape(data.text)} <small>${escape(data.hint)}</small></div>`,
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

  const orgSelect = new window.TomSelect(form.querySelector('[data-org-name]'), {
    maxOptions: 20,
    options: ORGANISATION_OPTIONS.map((name) => ({ value: name, text: name })),
    onChange(value) {
      state.orgName = value || '';
      const custom = form.querySelector('[data-field="org_name_custom"]');
      custom.hidden = value !== CUSTOM_ORG;
      if (value === CUSTOM_ORG) {
        custom.value = state.orgCustom;
        custom.focus();
      }
    },
  });

  function resolvedOrgName() {
    if (state.orgName === CUSTOM_ORG) return form.querySelector('[data-field="org_name_custom"]').value.trim();
    return state.orgName;
  }

  function rowHtml(row, own) {
    const org = orgList.find((o) => o.id === row.org_id);
    const full = org ? seatInfo(org, state.fromType, own.has(row.org_id)).full : false;
    const pendingNote = !org ? ' <em class="muted">(pending approval)</em>' : '';
    const fullNote = full ? ' <strong class="warn-text">full</strong>' : '';
    const classes = ['org-row'];
    if (full) classes.push('is-full');
    if (row.key === enteringKey) classes.push('is-entering');
    return `
      <li class="${classes.join(' ')}" data-key="${row.key}">
        <span class="org-name">${escapeHtml(row.name)}${pendingNote}${fullNote}</span>
        <button type="button" class="icon-btn" data-remove="${row.key}" aria-label="Remove ${escapeHtml(row.name)}">✕</button>
      </li>`;
  }

  function render() {
    const own = ownSeatIds();
    const isOther = state.fromType === 'other';
    form.querySelector('[data-kind-sections]').hidden = isOther;
    form.querySelector('[data-other-org]').hidden = !isOther;

    for (const { kind } of KINDS) {
      const rows = state.rows.filter((r) => r.kind === kind);
      form.querySelector(`[data-rows="${kind}"]`).innerHTML = rows.map((r) => rowHtml(r, own)).join('');
      const picker = pickers[kind];
      picker.clearOptions();
      picker.addOptions(pickerOptions(orgList, {
        kind,
        fromType: state.fromType,
        ownSeatIds: own,
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

  function clearErrors() {
    alertBox.hidden = true;
    alertBox.textContent = '';
    form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  }

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
    alertBox.classList.remove('shake');
    void alertBox.offsetWidth;
    alertBox.classList.add('shake');
    alertBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showFieldErrors(fields, ordered = orderRows(state.rows)) {
    for (const [key, message] of Object.entries(fields)) {
      const rowMatch = key.match(/^orgs\.(\d+)/);
      const target = rowMatch
        ? form.querySelector(`[data-row-error="${ordered[Number(rowMatch[1])]?.key}"]`)
        : form.querySelector(`[data-error="${key}"]`);
      if (target) target.textContent = target.textContent ? `${target.textContent} ${message}` : message;
    }
  }

  const preview = form.querySelector('[data-photo-preview]');
  const previewImg = form.querySelector('[data-photo-img]');
  function showPreview(src) { previewImg.src = src; preview.hidden = false; }
  function clearPhoto() {
    state.photoPath = null;
    field('photo').value = '';
    if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
    preview.hidden = true;
    previewImg.removeAttribute('src');
  }

  form.addEventListener('change', (event) => {
    if (event.target.name !== 'from_type') return;
    state.fromType = event.target.value;
    render();
  });

  form.addEventListener('input', (event) => {
    if (event.target.dataset?.field === 'org_name_custom') {
      state.orgCustom = event.target.value;
    }
  });

  form.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const key = Number(remove.dataset.remove);
      const item = remove.closest('.org-row');
      let removed = false;
      const finish = () => {
        if (removed) return;
        removed = true;
        state.rows = state.rows.filter((r) => r.key !== key);
        render();
      };
      item.classList.add('is-leaving');
      item.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 300);
      return;
    }
    if (event.target.closest('[data-photo-remove]')) {
      clearPhoto();
      form.querySelector('[data-error="photo"]').textContent = '';
    }
  });

  const photoInput = form.querySelector('[data-photo-input]');
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    clearPhoto();
    form.querySelector('[data-error="photo"]').textContent = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > PHOTO_MAX_BYTES) {
      form.querySelector('[data-error="photo"]').textContent = PHOTO_RULE_MESSAGE;
      return;
    }
    state.uploading = true;
    submitButton.disabled = true;
    try {
      const res = await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Photo upload failed, please try again.');
      state.photoPath = data.path;
      previewObjectUrl = URL.createObjectURL(file);
      showPreview(previewObjectUrl);
    } catch (err) {
      form.querySelector('[data-error="photo"]').textContent = err.message;
      state.photoPath = null;
    } finally {
      state.uploading = false;
      submitButton.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    const submittedRows = orderRows(state.rows);
    const payload = buildPayload({
      fromType: state.fromType,
      name: field('name').value,
      email: field('email').value,
      phone: field('phone').value,
      designation: field('designation').value,
      website: field('website').value,
      rows: submittedRows,
      photoPath: state.photoPath,
      organisationName: state.fromType === 'other' ? resolvedOrgName() : '',
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
    field('designation').value = initial.designation ?? '';
    field('email').value = initial.email;
    field('phone').value = initial.phone;
    form.querySelector(`input[name="from_type"][value="${initial.from_type}"]`).checked = true;
    if (initial.from_type === 'other' && initial.organisation_name) {
      const name = initial.organisation_name;
      if (ORGANISATION_OPTIONS.includes(name)) {
        state.orgName = name;
        orgSelect.setValue(name, true);
      } else {
        state.orgName = CUSTOM_ORG;
        state.orgCustom = name;
        orgSelect.setValue(CUSTOM_ORG, true);
        const custom = form.querySelector('[data-field="org_name_custom"]');
        custom.hidden = false;
        custom.value = name;
      }
    }
    if (initial.photo_path) {
      showPreview(photoUrl || `/api/admin/participants/${initial.id}/photo`);
    }
  }
  render();

  return {
    destroy: () => {
      Object.values(pickers).forEach((picker) => picker.destroy());
      orgSelect.destroy();
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    },
  };
}
```

- [ ] **Step 2: Update `public/js/register.js`**

Replace `showConfirmation`:

```js
function showConfirmation(payload, orgs) {
  const fromLabel = { supplier: 'Supplier', factory: 'Factory', other: 'Other' }[payload.from_type];
  const orgNames = (kind) => payload.orgs
    .filter((entry) => entry.kind === kind)
    .map((entry) => escapeHtml(orgs.find((o) => o.id === entry.org_id)?.name ?? ''))
    .join('</li><li>') || '—';

  root.innerHTML = `
    <div class="confirmation" tabindex="-1">
      <div class="success-badge" aria-hidden="true">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h2>You're registered!</h2>
      <dl>
        <dt>Name</dt><dd>${escapeHtml(payload.name)}</dd>
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
        <ul>${orgNames('supplier')}</ul>
        <h3>Factories</h3>
        <ul>${orgNames('factory')}</ul>
      ` : ''}
      <p class="muted">To change or cancel your registration, contact the event team.</p>
      <button type="button" class="btn" id="register-another">Register another person</button>
    </div>`;
  root.querySelector('.confirmation').focus();
  root.querySelector('#register-another').addEventListener('click', () => window.location.reload());
}
```

Also update the `start()` title logic to:

```js
document.title = `Primark Carton Nomination Program — ${data.event_title}`;
document.getElementById('event-subtitle').textContent = data.event_title;
```

- [ ] **Step 3: Smoke (visual only — no unit test)**

Run: `npm run dev` and open http://localhost:3000.
Check:
- Three radio options; picking Other hides supplier/factory pickers and shows an org dropdown.
- Picking "Other" in that dropdown reveals a text box.
- Selecting a supplier/factory auto-adds a row with no code input.
- The "Attendee information" block is visually grouped as a sub-card.
- Photo selection previews and can be removed.

---


### Task 8: Pages, header styling and environment examples

**Files:**
- Modify: `public/index.html`
- Modify: `public/admin.html`
- Modify: `public/styles.css`
- Modify: `.env.example`, `.env.test.example`
- Test: `tests/api/public.test.js` (title assertion), manual smoke.

**Interfaces:**
- Produces: transparent header with navy text; event details line; `.sub-card`, `.photo-preview` and simplified `.org-row` styles.
- Consumes: the form markup from Task 7 (`.sub-card`, `.photo-preview`, no code input).

- [ ] **Step 1: Update `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Primark Carton Nomination Program</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
  <link rel="icon" type="image/png" sizes="512x512" href="/brand/icon-512.png">
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
  <meta name="theme-color" content="#eaf1fb">
  ...
</head>
<body>
  <div class="bg-blobs" aria-hidden="true"><span></span><span></span><span></span></div>
  <header class="brand-band">
    <div class="brand-inner anim-rise">
      <span class="logo-chip"><img class="brand-logo pacd" src="/brand/pacd.png" alt="PacD" width="458" height="154"></span>
      <div class="brand-title">
        <h1>Primark Carton Nomination Program</h1>
        <p class="brand-sub" id="event-subtitle"></p>
        <p class="brand-details">Nov 04, 2026 · 9:00 AM – 3:30 PM (GMT+6) · Face-to-Face</p>
      </div>
      <img class="brand-logo primark" src="/brand/primark.png" alt="Primark" width="2285" height="311">
    </div>
    <p class="band-intro anim-rise" style="--i: 1">Fields marked <span class="req">*</span> are required. Each supplier can register up to 2 people and each factory 1 person.</p>
  </header>
  <main class="page">
    ...
  </main>
</body>
</html>
```

- [ ] **Step 2: Update `public/admin.html`**

- `<title>Primark Carton Nomination Program – Admin</title>`
- `<meta name="theme-color" content="#eaf1fb">`
- Header:

```html
<header class="brand-band wide">
  <div class="brand-inner anim-rise">
    <span class="logo-chip"><img class="brand-logo pacd" src="/brand/pacd.png" alt="PacD" width="458" height="154"></span>
    <div class="brand-title">
      <h1>Primark Carton Nomination Program</h1>
      <p class="brand-sub">Admin dashboard</p>
      <p class="brand-details">Nov 04, 2026 · 9:00 AM – 3:30 PM (GMT+6) · Face-to-Face</p>
    </div>
    <img class="brand-logo primark" src="/brand/primark.png" alt="Primark" width="2285" height="311">
  </div>
</header>
```

- [ ] **Step 3: Update `public/styles.css`**

Replace the `.brand-band` block (lines 119–146) with:

```css
.brand-band {
  position: relative;
  overflow: hidden;
  padding: 22px 16px 16px;
  color: var(--ink);
  background: transparent;
}
.brand-inner, .band-intro { max-width: 760px; margin: 0 auto; }
.brand-band.wide .brand-inner { max-width: 1280px; }
.brand-inner { display: flex; align-items: center; gap: 18px; }
.logo-chip {
  display: flex;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  background: #fff;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.brand-logo { display: block; height: auto; }
.brand-logo.pacd { width: 80px; }
.brand-logo.primark { width: 132px; margin-left: auto; }
.brand-title { min-width: 0; }
.brand-title h1 { margin: 0; font-size: 1.5rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; color: var(--navy); }
.brand-sub { margin: 2px 0 0; color: var(--navy); font-weight: 600; opacity: 0.85; }
.brand-sub:empty { display: none; }
.brand-details { margin: 8px 0 0; color: var(--muted); font-size: 0.95rem; font-weight: 500; }
.band-intro { margin-top: 14px; color: var(--muted); font-size: 0.95rem; }
.band-intro .req { color: var(--danger-fill); }
```

Replace `.page` (line 150) with:

```css
.page { position: relative; max-width: 760px; margin: 24px auto 0; padding: 0 16px 56px; }
.page.wide { max-width: 1312px; }
```

Simplify `.org-row` (line 304) to:

```css
.org-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 10px 10px 14px;
  margin-bottom: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  box-shadow: var(--shadow-xs);
}
```

Add sub-card and photo styles after the card block (around line 169):

```css
.sub-card {
  margin: 22px 0 0;
  padding: 22px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-glass);
}
.sub-card-title { margin: 0 0 18px; color: var(--navy); font-size: 1.15rem; font-weight: 700; }
.photo-preview { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.photo-preview img { max-height: 96px; max-width: 160px; border-radius: 10px; border: 1px solid var(--line); object-fit: cover; }
```

Update the small-screen header/page rules (lines 588 and 594):

```css
  .brand-band { padding: 16px 12px 16px; }
  ...
  .page { padding: 0 12px 40px; margin-top: 0; }
```

Update the `.org-row` mobile block (lines 603–606) to:

```css
  .org-row { grid-template-columns: 1fr auto; }
  .org-row > .org-name { grid-column: 1; grid-row: 1; }
  .org-row > .icon-btn { grid-column: 2; grid-row: 1; }
```

- [ ] **Step 4: Update `.env.example` and `.env.test.example`**

`EVENT_TITLE=Bangladesh Origin` (the H1/event title is now hardcoded in the pages; the env var only drives the subtitle line).

- [ ] **Step 5: Update `tests/api/public.test.js` line 121**

Change the title assertion from `/Primark Event Registration/` to `/Primark Carton Nomination Program/`.

- [ ] **Step 6: Manual smoke**

Run `npm run dev`, open `/` and `/admin`, confirm:
- Header has no blue band; body gradient shows through.
- Title, subtitle and details line render on both pages.
- Form sub-card and photo preview are styled.

---


### Task 9: Admin dashboard front-end

**Files:**
- Modify: `public/js/admin.js`
- Modify: `public/shared/admin-filters.js`
- Modify: `public/styles.css` (add `.photo-thumb`)
- Test: `tests/unit/admin-filters.test.js` (already updated in Task 6), manual smoke.

**Interfaces:**
- Consumes: dashboard participants now have `designation`, `organisation_name`, `photo_path`; `SEAT_LIMITS` from `/shared/constants.js`.
- Produces: admin table shows the new fields, per-kind seat counts (`n/2` vs `n/1`), and `From other` filter chip; `filterParticipants` searches designation and organisation name.

- [ ] **Step 1: Update `tests/unit/admin-filters.test.js`** (covered in Task 6, but verify after this task)

Run: `node --test tests/unit/admin-filters.test.js` — should PASS.

- [ ] **Step 2: Modify `public/js/admin.js`**

Top imports:
```js
import { EVENT_TIME_ZONE, SEAT_LIMITS } from '/shared/constants.js';
```

Constants:
```js
const SIDE = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };
```

`renderTiles` participant sub:
```js
tile(0, 'Participants', counter('participants', s.participants.total), `supplier ${s.participants.supplier} · factory ${s.participants.factory} · other ${s.participants.other}`),
```

`renderParticipants`:
```js
const rows = filterParticipants(data.participants, view);
return table(
  ['Name', 'Designation', 'Email', 'Phone', 'From', 'Organisation', 'Suppliers', 'Factories', 'Photo', 'Registered', ''],
  rows.map((p) => {
    const photoCell = p.photo_path
      ? `<a href="/api/admin/participants/${p.id}/photo" target="_blank" rel="noopener"><img class="photo-thumb" src="/api/admin/participants/${p.id}/photo" alt=""></a>`
      : '—';
    const orgCell = p.from_type === 'other' ? escapeHtml(p.organisation_name ?? '') : '—';
    return [
      escapeHtml(p.name),
      escapeHtml(p.designation ?? ''),
      escapeHtml(p.email),
      escapeHtml(p.phone),
      SIDE[p.from_type],
      orgCell,
      p.suppliers.length ? orgLinks(p.suppliers) : '—',
      p.factories.length ? orgLinks(p.factories) : '—',
      photoCell,
      formatTime(p.created_at),
      `<span class="row-actions"><button type="button" class="btn small" data-edit="${p.id}">Edit</button>
       <button type="button" class="btn small danger" data-delete="${p.id}">Delete</button></span>`,
    ];
  }),
  'No participants match.',
);
```

`renderOrganisations`:
```js
const limit = SEAT_LIMITS[kind];
return table(
  ['Name', 'Seats used', 'People', 'Status'],
  rows.map((o) => [
    `${escapeHtml(o.name)}${o.source === 'attendee' ? ' <span class="badge new">New</span>' : ''}`,
    o.seats_used > limit
      ? `${o.seats_used}/${limit} <span class="badge over">over limit</span>`
      : `${o.seats_used}/${limit}`,
    peopleList(o.people),
    `<span class="badge ${o.reg_status}">${STATUS[o.reg_status]}</span>`,
  ]),
  ...
);
```

`renderChips`:
```js
if (view.tab === 'participants') {
  chips = [['all', 'All'], ['supplier', 'From supplier'], ['factory', 'From factory'], ['other', 'From other']]
    .map(([v, l]) => chip('side', v, l));
}
```

`openMerge` picker options:
```js
options: data.organisations
  .filter((o) => o.kind === source.kind)
  .map((o) => ({ value: String(o.id), text: `${o.name} (${o.seats_used}/${SEAT_LIMITS[o.kind]})` })),
```

`openEdit` needs no change to the `mountRegistrationForm` call — the shared form already handles the new fields. Ensure the dashboard fixture (Task 6) includes `designation`, `organisation_name`, and `photo_path` on participants so the edit dialog can prefill them.

- [ ] **Step 3: Update `public/shared/admin-filters.js`**

```js
export function filterParticipants(participants, { search = '', side = 'all' } = {}) {
  const query = norm(search).trim();
  return participants.filter((p) =>
    (side === 'all' || p.from_type === side)
    && matches(query, [
      p.name, p.email, p.phone, p.designation, p.organisation_name,
      ...p.suppliers.map((o) => o.name), ...p.factories.map((o) => o.name),
    ]));
}
```

- [ ] **Step 4: Add `.photo-thumb` to `public/styles.css`** (anywhere near the photo-preview block is fine)

```css
.photo-thumb { height: 40px; width: auto; border-radius: 6px; border: 1px solid var(--line); object-fit: cover; }
```

- [ ] **Step 5: Run unit tests**

Run: `node --test tests/unit/admin-filters.test.js`
Expected: PASS.

- [ ] **Step 6: Manual smoke**

Run `npm run dev`, open `/admin`, log in, verify:
- Participants table shows Designation, Organisation, Photo thumbnail.
- Supplier/Factory rows show `n/2` and `n/1` limits; over-limit badges where applicable.
- Filter chips include "From other".
- Edit an "other" participant: the form pre-fills the organisation dropdown/free-text and the designation.
- Edit a participant with a photo: the existing photo thumbnail appears; replacing it removes the old storage object.

---


### Task 10: Database test suite

**Files:**
- Modify: `tests/helpers/db.js`
- Modify: `tests/db/register.test.js`
- Modify: `tests/db/admin-functions.test.js`
- Modify: `tests/db/dashboard.test.js`, `tests/db/schema.test.js`, `tests/db/public-api.test.js`, `tests/db/import.test.js`

**Prerequisite:** migration `005_carton_nomination.sql` must be applied to the **test** Supabase project first. `npm test` reads `.env.test` and sets `ALLOW_DB_WIPE=yes`. Until the test project is migrated, these tests will fail on missing columns/functions — expected; apply the migration then re-run.

**Interfaces:**
- Consumes: `SEAT_LIMITS` semantics (supplier 2, factory 1); `from_type 'other'`; server-side code resolution; `designation` required.
- Produces: passing DB tests proving the new business rules.

- [ ] **Step 1: Update helpers (`tests/helpers/db.js`)**

```js
// spec: { alias: { kind, name, status?, source?, code? } }
export async function seedOrgs(db, spec) {
  const entries = Object.entries(spec);
  const rows = await check(
    db.from('organisations')
      .insert(entries.map(([, o]) => ({
        kind: o.kind,
        name: o.name,
        code: o.code ?? null,
        status: o.status ?? 'approved',
        source: o.source ?? 'list',
      })))
      .select('id, kind, name, match_key, status, source, code'),
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  return Object.fromEntries(entries.map(([alias, o]) => [alias, byName.get(o.name)]));
}

// Pick a listed organisation for a payload. Second arg ignored (legacy code parameter).
export const pick = (org) => ({ kind: org.kind, org_id: org.id });

// Old helper for attendee-typed "Other" organisations. Removed from public API usage because
// the form no longer submits other_name. Some admin tests still create pending orgs via seedOrgs.
export const other = (kind, other_name, _code = 'CODE') => ({ kind, other_name });

export function payload({
  from = 'factory', email = 'person@example.com', name = 'Test Person', phone = '+8801711000000',
  designation = 'Test Officer', photo_path = null, organisation_name = null, orgs,
}) {
  const p = { from_type: from, name, email, phone, designation, orgs };
  if (photo_path) p.photo_path = photo_path;
  if (from === 'other') p.organisation_name = organisation_name;
  return p;
}
```

- [ ] **Step 2: Rewrite / slim `tests/db/register.test.js`**

Key changes:
- `pick(o.padma, 'CODE')` → `pick(o.padma)` everywhere.
- Add codes to seeded orgs:
```js
o = await seedOrgs(db, {
  padma: { kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' },
  pearl: { kind: 'supplier', name: 'Pearl Global', code: '83810' },
  aspire: { kind: 'factory', name: 'Aspire Garments (24040)', code: '24040' },
  windy: { kind: 'factory', name: 'Windy Apparels (20096)', code: '20096' },
  nkm: { kind: 'factory', name: 'NKM Fashion (27798)', code: '27798' },
  hidden: { kind: 'factory', name: 'Hidden Pending Factory', status: 'pending', source: 'attendee', code: 'HIDDEN' },
});
```
- Add tests:
```js
test('the server resolves the organisation code and ignores any code the client sent', async () => {
  const id = await check(register(db, payload({ orgs: [pick(o.padma), pick(o.aspire)] })));
  const links = await check(db.from('attendee_orgs').select('code').eq('attendee_id', id).order('code'));
  assert.deepEqual(links.map((l) => l.code), ['24040', '83760']);
});

test('designation is required for registration', async () => {
  const { error } = await register(db, payload({ designation: '', orgs: [pick(o.padma), pick(o.aspire)] }));
  assert.equal(error.message, 'VALIDATION');
});

test('an "other" attendee needs no orgs and stores the organisation name', async () => {
  const id = await check(register(db, payload({
    from: 'other', email: 'other@example.com', orgs: [], organisation_name: 'WAC - Bangladesh',
  })));
  const [row] = await check(db.from('attendees').select('from_type, organisation_name, designation').eq('id', id));
  assert.deepEqual(row, { from_type: 'other', organisation_name: 'WAC - Bangladesh', designation: 'Test Officer' });
});
```
- Remove tests that rely on attendee-typed `other()` orgs:
  - "a typed name matching an approved organisation links to it"
  - "typed names matching a pending organisation reuse it"
  - "a failed registration leaves no new pending organisation behind"
  - "picking the same organisation twice creates one link and keeps the first code"
  - "5 parallel registrations for the last seat" still applies, but the limit is **factory 1** now. Update the race test to 2 parallel factory-side registrations after 1 initial factory attendee at Aspire → exactly 1 succeeds, Aspire seats_used becomes 1. Or keep the supplier race (limit 2) by using a supplier attendee.
- Update "a third attendee from the same side is rejected" for **factory** limit 1: register 1 factory attendee at Aspire, then 2nd factory attendee at Aspire must fail SEAT_FULL.
- Update "supplier-side and factory-side registrations over the same pairs run concurrently" — seats per supplier remain 1 (because each pair has 1 supplier-side person), which is under limit 2; factories also 1. Keep; it still exercises no deadlock.

- [ ] **Step 3: Rewrite / slim `tests/db/admin-functions.test.js`**

- Same `seedOrgs` code additions as register.test.js.
- Replace `other('factory', 'Rainbow Knit Ltd')` in registration payloads by seeding a pending factory directly:
```js
rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee', code: 'RNB' }
```
Then register with `pick(o.rainbow)` where needed.
- Tests that specifically exercise creating a pending org from the payload are obsolete; replace with a seed.
- Update seat-limit assertions: factory limit is 1. In "refuses to go over the limit unless allowed", registering one factory attendee at Aspire and then merging a pending factory into Aspire should produce `count: 2`, error message factory limit 1.
- Add/update tests for `from_type 'other'` edits, e.g.:
```js
test('an attendee can be switched to "other" and loses all org links', async () => {
  const p = await reg({ orgs: [pick(o.padma), pick(o.aspire)] });
  await check(db.rpc('update_attendee', {
    p_id: p, p: payload({ from: 'other', orgs: [], organisation_name: 'Primark Limited' }),
  }));
  assert.equal((await seats(db, o.aspire.id)).seats_used, 0);
  const [row] = await check(db.from('attendees').select('from_type, organisation_name').eq('id', p));
  assert.deepEqual(row, { from_type: 'other', organisation_name: 'Primark Limited' });
});
```

- [ ] **Step 4: Update `tests/db/dashboard.test.js`, `tests/db/schema.test.js`, `tests/db/public-api.test.js`, `tests/db/import.test.js`**

- `dashboard.test.js`: ensure attendee rows include `designation`, `organisation_name`, `photo_path` in `seedOrgs`/`seedAttendees` or direct inserts; update any summary/total assertions to include `other` participants.
- `schema.test.js`: assert the new columns (`code`, `designation`, `organisation_name`, `photo_path`) and the extended `from_type` check exist; assert the `attendee-photos` bucket exists.
- `public-api.test.js`: update registration payload shape; assert `/api/organisations` still does **not** expose `code`.
- `import.test.js`: switch from xlsx to the `.psv` lists and assert codes are upserted.

- [ ] **Step 5: Run (after migration applied)**

Run: `npm test`
Expected: PASS once the test project has 005 applied.

---


### Task 11: Documentation + self-review + rollout

**Files:**
- Modify: `README.md`
- Review: `docs/superpowers/specs/2026-09-25-carton-nomination-design.md`

- [ ] **Step 1: Update `README.md`**

Keep the existing structure; edit these sections:

1. Title/intro:
```markdown
# Primark Carton Nomination Program — Registration

Public registration form and admin dashboard for the Primark Carton Nomination Program event.
```

2. Environment variables table:
- `EVENT_TITLE`: "Subtitle shown under the event title (set to `Bangladesh Origin`)."

3. Database section:
```markdown
Apply `supabase/migrations/001_schema.sql`, `002_register.sql`, `003_admin_functions.sql`, `004_hardening.sql`, `005_carton_nomination.sql` in order.
Put any future database change in a new numbered migration file; never edit a migration that has already been applied.
```

4. Import section (replace the xlsx section):
```markdown
## Import the supplier/factory lists

The canonical lists live in `scripts/data/suppliers.psv` and `scripts/data/factories.psv` as pipe-delimited `code|name` lines (names may contain commas, so not CSV). Safe to re-run.

```bash
npm run import-orgs   # defaults to scripts/data
# or with a custom directory:
node --env-file=.env.production scripts/import-orgs.js "path/to/data-dir"
```

`.env.production` must contain all five environment variables (the config loader requires them), although the import only uses the Supabase values.
```

5. Before sharing the link / Vercel Firewall:
```markdown
- `POST /api/photos`: 10 requests per minute per IP (each request can be up to 1 MB).
```

6. Local development smoke checklist:
```markdown
### Manual checks
- Register as supplier (limit 2), factory (limit 1) and Other.
- Upload a photo, then delete the registration in the admin panel and confirm the old object is removed.
- Export to Excel and confirm new columns (Designation, Organisation, Photo).
```

- [ ] **Step 2: Self-review the implementation against the spec**

Run this checklist after all code is written:

| Spec requirement | Where implemented |
|---|---|
| Project title + subtitle + date/time/type on page | `public/index.html`, `public/admin.html` |
| Supplier/factory codes hidden, auto-filled from data | `organisations.code`, `prepare_registration` resolves code server-side, `registration-form.js` no code input |
| Updated supplier/factory lists | `scripts/data/*.psv`, `src/services/import.js`, `scripts/import-orgs.js` |
| Per-kind seat limits (supplier 2 / factory 1) | `SEAT_LIMITS`, migration 005, `src/errors.js`, `src/services/dashboard.js`, `public/shared/form-logic.js` |
| From-kind required, other side optional | `validateRegistration`, `prepare_registration` org count checks |
| Designation required, photo optional JPG/PNG ≤ 1 MB | `attendees` columns, `validateRegistration`, form file input + upload, `/api/photos` route + bucket settings |
| "Other" attending-from with org dropdown + free-text | `validateRegistration`, `registration-form.js`, `ORGANISATION_OPTIONS` |
| Attendee information sub-card | `registration-form.js` `.sub-card`, `styles.css` |
| Header un-banded | `styles.css` `.brand-band`, page markup |
| Private photo storage + admin proxy | storage bucket, `src/routes/photos.js`, `src/routes/admin.js` photo route/cleanup |
| Admin dashboard + export updates | `src/services/dashboard.js`, `src/services/export.js`, `public/js/admin.js` |
| Tests | unit/api/db updates described in Tasks 1–10 |

Placeholder scan: ensure no `TBD`, `TODO`, or `xxx` remain in new files.
Type consistency: `photo_path`, `organisation_name`, `designation`, `from_type` names match between DB, JS validator, dashboard, export, and admin front-end.

- [ ] **Step 3: Final test run**

Run what works without the migrated test database:

```bash
npm run test:unit
node --test tests/api/*.test.js
```

For the DB integration tests, first apply `005_carton_nomination.sql` to the test Supabase project, then:

```bash
npm test
```

- [ ] **Step 4: Rollout checklist**

1. Apply `005_carton_nomination.sql` to the **production** Supabase project.
2. Run `npm run import-orgs` (or `node --env-file=.env.production scripts/import-orgs.js`) against production.
3. In Vercel: update `EVENT_TITLE` to `Bangladesh Origin` for both Production and Preview environments.
4. Deploy.
5. In Vercel Firewall, add rate limits:
   - `POST /api/register`: 30/min/IP.
   - `POST /api/photos`: 10/min/IP.
   - `POST /api/admin/login`: 10/min/IP.
6. Smoke-test supplier limit (2), factory limit (1), Other flow, photo upload, admin edit, Excel export.

**Note:** the design doc is at `docs/superpowers/specs/2026-09-25-carton-nomination-design.md` and this plan is at `docs/superpowers/plans/2026-09-25-carton-nomination.md`. The canonical supplier/factory data files (`scripts/data/*.psv`) were already created during planning.

---

## Execution options

Plan complete. Two ways to implement:

1. **Inline in this session** (recommended here) — I execute the plan task-by-task, running tests as I go. Best because the tasks share files (`constants.js`, `styles.css`, test fixtures) and the full context is already loaded.
2. **Subagent-driven** — I dispatch a fresh subagent per task. More overhead for this tightly coupled set of changes.

Which would you like?
