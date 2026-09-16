# Primark Event Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public registration form that limits each supplier and factory to 2 attendees per side, plus a password-protected admin dashboard with approval, merge and Excel export.

**Architecture:** Plain HTML/JS pages in `public/`, served by Vercel's CDN, call a small Express 5 API. Vercel runs `server.js` as a single function. All seat-limit logic lives in Postgres functions on Supabase, which run in one transaction and lock rows so concurrent registrations can't exceed the limit. The server uses the Supabase secret key. The browser never talks to Supabase.

**Tech Stack:** Node.js ≥ 22 (ES modules), Express 5.2.1, @supabase/supabase-js 2.116.0, ExcelJS 4.4.0, cookie-parser 1.4.7, Tom Select 2.6.2 (CDN), node:test with supertest 7.2.2, Supabase Postgres, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-17-event-registration-design.md`. Read it before starting any task. Section numbers below (e.g. "spec §9") refer to it.

## Global Constraints

- Node.js ≥ 22 (the dev machine has 26). `"type": "module"`. No build step, no TypeScript, no front-end framework.
- Runtime dependencies are only `express@5.2.1`, `@supabase/supabase-js@2.116.0`, `exceljs@4.4.0` and `cookie-parser@1.4.7`. The only dev dependency is `supertest@7.2.2`. No `dotenv`: env files are loaded with `node --env-file` / `--env-file-if-exists`.
- Load Tom Select 2.6.2 from `https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/css/tom-select.default.min.css` and `https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/js/tom-select.complete.min.js`.
- Seat limit: **2** per organisation, counting only attendees whose `from_type` equals the organisation's `kind`. Each registration needs **1–10 suppliers and 1–10 factories**.
- Environment variables, with these exact names: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET` (≥ 32 chars), `EVENT_TITLE`. Tests also need `SUPABASE_PUBLISHABLE_KEY` and `ALLOW_DB_WIPE=yes`.
- API error body: `{ error, message }`, plus `fields` for `VALIDATION`. Codes, HTTP statuses and messages must match spec §9 exactly.
- Admin cookie: `admin_session`, lifetime 43200 s, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production.
- The Supabase secret key never reaches the browser. RLS is enabled on every table. Table privileges are revoked from `anon` and `authenticated`. Function `EXECUTE` is revoked from `public`, `anon` and `authenticated` and granted to `service_role`.
- Regions: Supabase `ap-southeast-1`, Vercel `sin1`. Export timestamps use `Asia/Dhaka`.
- Tests use `node:test` and `node:assert/strict`. Tests that need a database run only against the **test** Supabase project and throw unless `ALLOW_DB_WIPE=yes`.
- Commands are written for Git Bash on Windows, run from the project root. Quote paths that contain spaces.
- Commit at the end of every task. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `.env.example`, `.env.test.example`, `.gitignore` | Project setup, scripts, env templates | 1 |
| `src/config.js` | Read and check env vars → config object | 1 |
| `src/db.js` | Supabase client; `callRpc` / `runQuery` helpers that throw `AppError` | 1, 6 |
| `public/shared/validate.js` | Registration payload validation (browser and server) | 2 |
| `supabase/migrations/001_schema.sql` | Tables, `make_match_key`, `org_status` view, RLS, grants | 3 |
| `supabase/migrations/002_register.sql` | `private.prepare_registration`, `register_attendee` | 4 |
| `supabase/migrations/003_admin_functions.sql` | `update_attendee`, `delete_attendee`, `approve_org`, `merge_org` | 5 |
| `src/errors.js` | `AppError`, `errors.*`, `fromDbError`, `errorHandler` | 6 |
| `src/auth.js` | Session cookie sign/verify, password check, `requireAdmin` | 6 |
| `src/create-app.js` | Express app factory | 7, 9 |
| `src/routes/public.js` | `GET /api/organisations`, `POST /api/register` | 7 |
| `server.js`, `vercel.json` | Vercel entry and local dev server; deploy config | 7 |
| `src/services/dashboard.js` | `loadDashboard`, `buildDashboard`, `registrationStatus` | 8 |
| `src/routes/admin.js` | Admin login/logout/data/edit/delete/approve/merge/export | 9, 10 |
| `src/services/export.js` | `buildWorkbook`, `exportFilename`, `formatDhaka` | 10 |
| `src/services/import.js`, `scripts/import-orgs.js` | Excel list → organisations | 11 |
| `public/shared/form-logic.js` | `escapeHtml`, `seatInfo`, `pickerOptions`, `buildPayload` | 12 |
| `public/index.html`, `public/styles.css`, `public/js/api.js`, `public/js/registration-form.js`, `public/js/register.js` | Registration page | 12 |
| `public/shared/admin-filters.js` | `filterParticipants`, `filterOrganisations` | 13 |
| `public/admin.html`, `public/js/admin.js` | Admin dashboard page | 13 |
| `tests/helpers/db.js` | Test DB client, wipe, seed and registration helpers | 3 |
| `tests/helpers/fake-db.js` | In-memory stand-in for the Supabase client, plus `testConfig` | 7 |
| `tests/helpers/dashboard-fixture.js` | Shared organisation and attendee fixture | 8 |

---

### Task 1: Project scaffold and config loader

**Files:**
- Create: `package.json`, `.env.example`, `.env.test.example`, `src/config.js`, `src/db.js`
- Modify: `.gitignore`
- Test: `tests/unit/config.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadConfig(env = process.env) → { supabaseUrl, supabaseSecretKey, adminPassword, sessionSecret, eventTitle, isProduction }`. Throws `Error('Missing environment variables: A, B')` or `Error('SESSION_SECRET must be at least 32 characters')`.
  - `createDb(config) → SupabaseClient`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "primark-event-registration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "node --env-file=.env --watch server.js",
    "test": "node --env-file-if-exists=.env.test --test --test-concurrency=1 \"tests/**/*.test.js\"",
    "test:unit": "node --test \"tests/unit/**/*.test.js\"",
    "import-orgs": "node --env-file=.env scripts/import-orgs.js"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install express@5.2.1 @supabase/supabase-js@2.116.0 exceljs@4.4.0 cookie-parser@1.4.7
npm install --save-dev supertest@7.2.2
```
Expected: `package.json` gains `dependencies` and `devDependencies`, and `package-lock.json` is created.

- [ ] **Step 3: Create env templates and extend `.gitignore`**

`.env.example`:
```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_replace_me
ADMIN_PASSWORD=choose-a-strong-shared-password
SESSION_SECRET=replace-with-at-least-32-random-characters
EVENT_TITLE=Primark Supplier Event 2026
```

`.env.test.example`:
```
# Points at the TEST Supabase project only. Tests delete all data in it.
SUPABASE_URL=https://YOUR-TEST-PROJECT-REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_replace_me
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
ADMIN_PASSWORD=test-admin-password
SESSION_SECRET=test-session-secret-at-least-32-characters
EVENT_TITLE=Test Event
ALLOW_DB_WIPE=yes
```

Append to `.gitignore`:
```
!.env.test.example
```

- [ ] **Step 4: Write the failing test** `tests/unit/config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

const valid = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_x',
  ADMIN_PASSWORD: 'pw',
  SESSION_SECRET: 'a'.repeat(32),
  EVENT_TITLE: ' Supplier Day ',
};

test('returns a config object when every variable is set', () => {
  const config = loadConfig(valid);
  assert.deepEqual(config, {
    supabaseUrl: 'https://example.supabase.co',
    supabaseSecretKey: 'sb_secret_x',
    adminPassword: 'pw',
    sessionSecret: 'a'.repeat(32),
    eventTitle: 'Supplier Day',
    isProduction: false,
  });
});

test('lists every missing or blank variable', () => {
  assert.throws(
    () => loadConfig({ ...valid, ADMIN_PASSWORD: '  ', EVENT_TITLE: undefined }),
    /Missing environment variables: ADMIN_PASSWORD, EVENT_TITLE/,
  );
});

test('rejects a session secret shorter than 32 characters', () => {
  assert.throws(() => loadConfig({ ...valid, SESSION_SECRET: 'short' }), /at least 32 characters/);
});

test('treats Vercel and NODE_ENV=production as production', () => {
  assert.equal(loadConfig({ ...valid, VERCEL: '1' }).isProduction, true);
  assert.equal(loadConfig({ ...valid, NODE_ENV: 'production' }).isProduction, true);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `node --test tests/unit/config.test.js`
Expected: FAIL with `Cannot find module` for `src/config.js`.

- [ ] **Step 6: Implement `src/config.js`**

```js
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'EVENT_TITLE'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name] || !env[name].trim());
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return {
    supabaseUrl: env.SUPABASE_URL.trim(),
    supabaseSecretKey: env.SUPABASE_SECRET_KEY.trim(),
    adminPassword: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    eventTitle: env.EVENT_TITLE.trim(),
    isProduction: env.NODE_ENV === 'production' || Boolean(env.VERCEL),
  };
}
```

- [ ] **Step 7: Implement `src/db.js`** (the helpers are added in Task 6)

```js
import { createClient } from '@supabase/supabase-js';

export function createDb(config) {
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test tests/unit/config.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example .env.test.example src/config.js src/db.js tests/unit/config.test.js
git commit -m "chore: scaffold project with config loader" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 2: Shared validation module

**Files:**
- Create: `public/shared/validate.js`
- Test: `tests/unit/validate.test.js`

**Interfaces:**
- Consumes: nothing. It must stay dependency-free because the browser imports it from `/shared/validate.js`.
- Produces:
  - `MAX_ORGS_PER_KIND = 10`
  - `validateRegistration(input) → { ok: true, value } | { ok: false, fields }`
    - `value` = `{ from_type, name, email, phone, orgs: [{ kind, org_id, code } | { kind, other_name, code }] }`, with all strings trimmed and entries in input order. Unknown keys such as `website` are dropped.
    - `fields` keys: `from_type`, `name`, `email`, `phone`, `suppliers`, `factories`, `orgs.<i>`, `orgs.<i>.kind`, `orgs.<i>.code`, `orgs.<i>.other_name`. Values are user-facing messages.

- [ ] **Step 1: Write the failing test** `tests/unit/validate.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, MAX_ORGS_PER_KIND } from '../../public/shared/validate.js';

const base = () => ({
  from_type: 'factory',
  name: '  Rahim Uddin ',
  email: ' rahim@example.com ',
  phone: '+880 1711-000000',
  website: '',
  orgs: [
    { kind: 'supplier', org_id: 1, code: ' S-1 ' },
    { kind: 'factory', other_name: ' Rainbow Knit Ltd ', code: '30001' },
  ],
});

const fieldsFor = (overrides) => {
  const result = validateRegistration({ ...base(), ...overrides });
  return result.ok ? {} : result.fields;
};

const twoOrgs = (supplierEntry) => [supplierEntry, { kind: 'factory', org_id: 2, code: 'F' }];

test('accepts a valid payload, trims every string and drops unknown keys', () => {
  const result = validateRegistration(base());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    from_type: 'factory',
    name: 'Rahim Uddin',
    email: 'rahim@example.com',
    phone: '+880 1711-000000',
    orgs: [
      { kind: 'supplier', org_id: 1, code: 'S-1' },
      { kind: 'factory', other_name: 'Rainbow Knit Ltd', code: '30001' },
    ],
  });
});

test('from_type must be supplier or factory', () => {
  assert.ok(fieldsFor({ from_type: 'buyer' }).from_type);
  assert.ok(fieldsFor({ from_type: undefined }).from_type);
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

test('each organisation needs a 1–30 character code', () => {
  const withCode = (code) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', org_id: 1, code }) });
  assert.ok(withCode('  ')['orgs.0.code']);
  assert.equal(withCode('c'.repeat(30))['orgs.0.code'], undefined);
  assert.ok(withCode('c'.repeat(31))['orgs.0.code']);
});

test('a new organisation name must be 2–150 characters', () => {
  const withOther = (other_name) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', other_name, code: 'S' }) });
  assert.ok(withOther('A')['orgs.0.other_name']);
  assert.equal(withOther('Ab')['orgs.0.other_name'], undefined);
  assert.equal(withOther('a'.repeat(150))['orgs.0.other_name'], undefined);
  assert.ok(withOther('a'.repeat(151))['orgs.0.other_name']);
});

test('each entry needs exactly one of org_id or other_name, and org_id must be a positive integer', () => {
  const entry = (extra) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', code: 'S', ...extra }) });
  assert.ok(entry({})['orgs.0']);
  assert.ok(entry({ org_id: 1, other_name: 'Both' })['orgs.0']);
  assert.ok(entry({ org_id: '1' })['orgs.0']);
  assert.ok(entry({ org_id: 0 })['orgs.0']);
  assert.ok(entry({ org_id: 1, kind: 'buyer' })['orgs.0.kind']);
});

test('needs 1–10 suppliers and 1–10 factories', () => {
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory', org_id: 2, code: 'F' }] }).suppliers);
  assert.ok(fieldsFor({ orgs: [{ kind: 'supplier', org_id: 1, code: 'S' }] }).factories);
  const factories = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'factory', org_id: i + 10, code: 'F' }));
  const supplier = { kind: 'supplier', org_id: 1, code: 'S' };
  assert.equal(fieldsFor({ orgs: [supplier, ...factories(MAX_ORGS_PER_KIND)] }).factories, undefined);
  assert.ok(fieldsFor({ orgs: [supplier, ...factories(MAX_ORGS_PER_KIND + 1)] }).factories);
});

test('handles missing or malformed input without throwing', () => {
  assert.equal(validateRegistration(undefined).ok, false);
  assert.equal(validateRegistration({ orgs: [null, 'x'] }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/validate.test.js`
Expected: FAIL with `Cannot find module` for `public/shared/validate.js`.

- [ ] **Step 3: Implement `public/shared/validate.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/validate.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add public/shared/validate.js tests/unit/validate.test.js
git commit -m "feat: add shared registration validation" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 3: Test database, schema migration and DB test helpers

**Files:**
- Create: `supabase/migrations/001_schema.sql`, `tests/helpers/db.js`, `.env.test` (git-ignored, never committed)
- Test: `tests/db/schema.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - Tables `public.organisations`, `public.attendees`, `public.attendee_orgs`; view `public.org_status (id, kind, name, source, status, created_at, seats_used int, linked_count int)`; function `public.make_match_key(text) → text`. Columns exactly as spec §5.1.
  - `tests/helpers/db.js` exports:
    - `skipReason` (`false` | string, for `describe(..., { skip: skipReason })`)
    - `testDb()`, `anonDb()`
    - `check(request) → data` (throws on error)
    - `wipe(db)`
    - `seedOrgs(db, { alias: { kind, name, status?, source? } }) → { alias: { id, kind, name, match_key, status, source } }`
    - `pick(org, code?)`, `other(kind, other_name, code?)`
    - `payload({ from?, email?, name?, phone?, orgs })`
    - `register(db, p) → Promise<{ data, error }>`
    - `seats(db, orgId) → { seats_used, linked_count }`
    - `findOrgs(db, { column: value }) → rows`

- [ ] **Step 1: Provision the test Supabase project (needs the user)**

Ask the user to create, or approve you creating through the Supabase MCP tools, a **separate** Supabase project named `primark-event-reg-test` in region `ap-southeast-1`. Creating a project may need cost confirmation, so do not create it without the user's explicit OK.

From that project's **Project Settings → API Keys**, copy the project URL, the **publishable** key (`sb_publishable_…`) and a **secret** key (`sb_secret_…`). Then:

```bash
cp .env.test.example .env.test
```

Fill in `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `SUPABASE_PUBLISHABLE_KEY` in `.env.test`. Keep `ALLOW_DB_WIPE=yes`. Check that git ignores it:

```bash
git check-ignore .env.test
```
Expected: prints `.env.test`.

- [ ] **Step 2: Create `tests/helpers/db.js`**

```js
import { createClient } from '@supabase/supabase-js';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// false when the test DB is configured, otherwise a reason string for node:test's `skip` option.
export const skipReason = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? false
  : 'test database not configured (.env.test)';

export function testDb() {
  if (process.env.ALLOW_DB_WIPE !== 'yes') {
    throw new Error('Refusing to run database tests without ALLOW_DB_WIPE=yes: they delete all data.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, clientOptions);
}

export function anonDb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, clientOptions);
}

export async function check(request) {
  const { data, error } = await request;
  if (error) throw new Error(`${error.code ?? ''} ${error.message} ${error.details ?? ''}`.trim());
  return data;
}

export async function wipe(db) {
  await check(db.from('attendee_orgs').delete().not('attendee_id', 'is', null));
  await check(db.from('attendees').delete().not('id', 'is', null));
  await check(db.from('organisations').delete().gt('id', 0));
}

// spec: { alias: { kind, name, status?, source? } } → { alias: row }
export async function seedOrgs(db, spec) {
  const entries = Object.entries(spec);
  const rows = await check(
    db.from('organisations')
      .insert(entries.map(([, o]) => ({
        kind: o.kind,
        name: o.name,
        status: o.status ?? 'approved',
        source: o.source ?? 'list',
      })))
      .select('id, kind, name, match_key, status, source'),
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  return Object.fromEntries(entries.map(([alias, o]) => [alias, byName.get(o.name)]));
}

export const pick = (org, code = 'CODE') => ({ kind: org.kind, org_id: org.id, code });
export const other = (kind, other_name, code = 'CODE') => ({ kind, other_name, code });

export function payload({ from = 'factory', email = 'person@example.com', name = 'Test Person', phone = '+8801711000000', orgs }) {
  return { from_type: from, name, email, phone, orgs };
}

export const register = (db, p) => db.rpc('register_attendee', { p });

export async function seats(db, orgId) {
  const [row] = await check(db.from('org_status').select('seats_used, linked_count').eq('id', orgId));
  return row;
}

export async function findOrgs(db, filters) {
  let request = db.from('organisations').select('id, kind, name, match_key, status, source');
  for (const [column, value] of Object.entries(filters)) request = request.eq(column, value);
  return check(request);
}
```

- [ ] **Step 3: Write the failing test** `tests/db/schema.test.js`

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anonDb, check, seedOrgs, seats, skipReason, testDb, wipe } from '../helpers/db.js';

describe('schema', { skip: skipReason }, () => {
  let db;
  before(() => { db = testDb(); });
  beforeEach(() => wipe(db));

  test('match_key ignores case, punctuation and Ltd/Limited', async () => {
    const orgs = await seedOrgs(db, {
      hopLun: { kind: 'supplier', name: 'Hop Lun (H.K.) LTD.' },
      modele: { kind: 'factory', name: 'Modele De Capital Ind Ltd (Unit 2) (26088)' },
      colour: { kind: 'factory', name: 'Colour & Co Limited' },
      htl: { kind: 'supplier', name: 'HTL FASHION HAZIR GIYIM SAN.TIC.LTD.STI' },
    });
    assert.equal(orgs.hopLun.match_key, 'hop lun h k');
    assert.equal(orgs.modele.match_key, 'modele de capital ind unit 2 26088');
    assert.equal(orgs.colour.match_key, 'colour and co');
    assert.equal(orgs.htl.match_key, 'htl fashion hazir giyim san tic sti');
  });

  test('a match_key is unique per kind but may repeat across kinds', async () => {
    await seedOrgs(db, { padma: { kind: 'supplier', name: 'Padma Textiles Ltd' } });
    const duplicate = await db.from('organisations')
      .insert({ kind: 'supplier', name: 'PADMA TEXTILES LIMITED', source: 'list', status: 'approved' });
    assert.equal(duplicate.error?.code, '23505');
    const otherKind = await db.from('organisations')
      .insert({ kind: 'factory', name: 'Padma Textiles', source: 'list', status: 'approved' });
    assert.equal(otherKind.error, null);
  });

  test('attendee email is unique regardless of letter case', async () => {
    await check(db.from('attendees').insert({ name: 'A', email: 'Rahim@Example.com', phone: '1234567', from_type: 'factory' }));
    const duplicate = await db.from('attendees')
      .insert({ name: 'B', email: 'rahim@example.com', phone: '1234567', from_type: 'supplier' });
    assert.equal(duplicate.error?.code, '23505');
  });

  test('org_status counts seats only for attendees from the matching side', async () => {
    const orgs = await seedOrgs(db, { aspire: { kind: 'factory', name: 'Aspire Garments (24040)' } });
    const people = await check(db.from('attendees').insert([
      { name: 'Factory Person', email: 'f@example.com', phone: '1234567', from_type: 'factory' },
      { name: 'Supplier Person', email: 's@example.com', phone: '1234567', from_type: 'supplier' },
    ]).select('id'));
    await check(db.from('attendee_orgs').insert(
      people.map((p) => ({ attendee_id: p.id, org_id: orgs.aspire.id, code: 'X' })),
    ));
    assert.deepEqual(await seats(db, orgs.aspire.id), { seats_used: 1, linked_count: 2 });
  });

  test('the publishable (anon) key cannot read or write any table or the view', async () => {
    await seedOrgs(db, { aspire: { kind: 'factory', name: 'Aspire Garments (24040)' } });
    const anon = anonDb();
    for (const table of ['organisations', 'attendees', 'attendee_orgs', 'org_status']) {
      const { data, error } = await anon.from(table).select('*');
      assert.ok(error || data.length === 0, `${table} must not be readable with the anon key`);
    }
    const write = await anon.from('organisations')
      .insert({ kind: 'factory', name: 'Sneaky', source: 'list', status: 'approved' });
    assert.ok(write.error, 'anon insert must fail');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --env-file=.env.test --test tests/db/schema.test.js`
Expected: FAIL. The errors say the `organisations` table cannot be found (PostgREST `PGRST205` / relation does not exist).

- [ ] **Step 5: Write `supabase/migrations/001_schema.sql`**

```sql
-- Organisations (suppliers and factories), attendees and their links.
-- Only the server (service_role via the secret key) may touch these objects.

create or replace function public.make_match_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(replace(lower(p_name), '&', ' and '), '[^a-z0-9 ]', ' ', 'g'),
        '\m(ltd|limited)\M', ' ', 'g'),
      '\s+', ' ', 'g'))
$$;

create table public.organisations (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('supplier', 'factory')),
  name text not null check (length(btrim(name)) > 0),
  match_key text generated always as (public.make_match_key(name)) stored,
  source text not null check (source in ('list', 'attendee')),
  status text not null check (status in ('approved', 'pending')),
  created_at timestamptz not null default now(),
  constraint organisations_kind_match_key_key unique (kind, match_key)
);

create table public.attendees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text not null,
  from_type text not null check (from_type in ('supplier', 'factory')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index attendees_email_lower_key on public.attendees (lower(email));

create table public.attendee_orgs (
  attendee_id uuid not null references public.attendees (id) on delete cascade,
  org_id bigint not null references public.organisations (id),
  code text not null,
  primary key (attendee_id, org_id)
);
create index attendee_orgs_org_id_idx on public.attendee_orgs (org_id);

create view public.org_status with (security_invoker = true) as
select
  o.id,
  o.kind,
  o.name,
  o.source,
  o.status,
  o.created_at,
  (count(ao.attendee_id) filter (where a.from_type = o.kind))::int as seats_used,
  count(ao.attendee_id)::int as linked_count
from public.organisations o
left join public.attendee_orgs ao on ao.org_id = o.id
left join public.attendees a on a.id = ao.attendee_id
group by o.id;

alter table public.organisations enable row level security;
alter table public.attendees enable row level security;
alter table public.attendee_orgs enable row level security;

revoke all on table public.organisations, public.attendees, public.attendee_orgs, public.org_status
  from anon, authenticated;
grant all on table public.organisations, public.attendees, public.attendee_orgs, public.org_status
  to service_role;

revoke execute on function public.make_match_key(text) from public, anon, authenticated;
grant execute on function public.make_match_key(text) to service_role;
```

- [ ] **Step 6: Apply the migration to the test project**

Either paste the file into the test project's **SQL Editor** and run it, or use the Supabase MCP `apply_migration` tool with `name: "001_schema"` and the file contents as `query`, against the **test** project id.
Expected: no errors.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --env-file=.env.test --test tests/db/schema.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 8: Check that unit tests still pass without a database**

Run: `npm run test:unit`
Expected: PASS. No database tests run.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/001_schema.sql tests/helpers/db.js tests/db/schema.test.js
git commit -m "feat: add database schema with RLS and match keys" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 4: `register_attendee` with the seat rule

**Files:**
- Create: `supabase/migrations/002_register.sql`
- Test: `tests/db/register.test.js`

**Interfaces:**
- Consumes: the Task 3 schema and `tests/helpers/db.js`.
- Produces:
  - `private.prepare_registration(p jsonb, p_exclude_attendee uuid, p_allow_pending boolean) → jsonb`. It returns `[{ "org_id": <bigint>, "code": <text> }]` with duplicates removed and first-entry order kept. It locks charged organisations and raises `VALIDATION` / `ORG_NOT_FOUND` / `SEAT_FULL`.
  - `public.register_attendee(p jsonb) → uuid`, called as `db.rpc('register_attendee', { p })`.
  - Error contract read by the server (Task 6): `error.message` is exactly the code.
    - `SEAT_FULL` carries `error.details` = JSON text `{"side":"factory","orgs":["Name A","Name B"]}` (names sorted).
    - `VALIDATION` carries the offending area in `error.details` (`from_type`, `contact`, `orgs` or `other_name`).
    - `ORG_NOT_FOUND` carries the org id in `error.details`.
    - `DUPLICATE_EMAIL` has no details.

- [ ] **Step 1: Write the failing test** `tests/db/register.test.js`

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, other, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

describe('register_attendee', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      pearl: { kind: 'supplier', name: 'Pearl Global' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
      windy: { kind: 'factory', name: 'Windy Apparels (20096)' },
      nkm: { kind: 'factory', name: 'NKM Fashion (27798)' },
      hidden: { kind: 'factory', name: 'Hidden Pending Factory', status: 'pending', source: 'attendee' },
    });
  });

  test('a factory attendee with 3 factories uses a seat at each and counts as one participant', async () => {
    const id = await check(register(db, payload({
      from: 'factory',
      orgs: [pick(o.padma), pick(o.aspire), pick(o.windy), pick(o.nkm)],
    })));
    assert.match(id, /^[0-9a-f-]{36}$/);
    for (const factory of [o.aspire, o.windy, o.nkm]) {
      assert.equal((await seats(db, factory.id)).seats_used, 1);
    }
    assert.deepEqual(await seats(db, o.padma.id), { seats_used: 0, linked_count: 1 });
    assert.equal((await check(db.from('attendees').select('id'))).length, 1);
  });

  test('supplier-side attendees do not use factory seats', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ from: 'supplier', email: `s${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    for (const n of [1, 2]) {
      await check(register(db, payload({ from: 'factory', email: `f${n}@example.com`, orgs: [pick(o.pearl), pick(o.aspire)] })));
    }
    assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 2, linked_count: 4 });
  });

  test('a third attendee from the same side is rejected with SEAT_FULL and nothing is saved', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ email: `p${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    const { error } = await register(db, payload({
      email: 'p3@example.com',
      orgs: [pick(o.padma), pick(o.aspire), pick(o.windy)],
    }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.deepEqual(JSON.parse(error.details), { side: 'factory', orgs: ['Aspire Garments (24040)'] });
    assert.equal((await seats(db, o.windy.id)).linked_count, 0);
  });

  test('5 parallel registrations for the last seat: exactly one succeeds', async () => {
    await check(register(db, payload({ email: 'first@example.com', orgs: [pick(o.padma), pick(o.aspire)] })));
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      register(db, payload({ email: `race${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] }))));
    assert.equal(results.filter((r) => !r.error).length, 1);
    assert.ok(results.filter((r) => r.error).every((r) => r.error.message === 'SEAT_FULL'));
    assert.equal((await seats(db, o.aspire.id)).seats_used, 2);
  });

  test('the same email in different case is rejected with DUPLICATE_EMAIL', async () => {
    await check(register(db, payload({ email: 'Rahim@Example.com', orgs: [pick(o.padma), pick(o.aspire)] })));
    const { error } = await register(db, payload({ email: 'rahim@example.com', orgs: [pick(o.pearl), pick(o.windy)] }));
    assert.equal(error.message, 'DUPLICATE_EMAIL');
  });

  test('a typed name matching an approved organisation links to it and creates nothing', async () => {
    const id = await check(register(db, payload({
      orgs: [other('supplier', 'PADMA TEXTILES LIMITED'), pick(o.aspire)],
    })));
    const links = await check(db.from('attendee_orgs').select('org_id').eq('attendee_id', id));
    assert.deepEqual(links.map((l) => l.org_id).sort((a, b) => a - b), [o.padma.id, o.aspire.id].sort((a, b) => a - b));
    assert.equal((await findOrgs(db, { status: 'pending' })).length, 1); // only the seeded hidden one
  });

  test('typed names matching a pending organisation reuse it, and its seat limit applies', async () => {
    await check(register(db, payload({ email: 'r1@example.com', orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] })));
    await check(register(db, payload({ email: 'r2@example.com', orgs: [pick(o.padma), other('factory', 'rainbow knit limited')] })));
    const { error } = await register(db, payload({ email: 'r3@example.com', orgs: [pick(o.padma), other('factory', 'Rainbow-Knit')] }));
    assert.equal(error.message, 'SEAT_FULL');
    const rainbow = await findOrgs(db, { match_key: 'rainbow knit' });
    assert.equal(rainbow.length, 1);
    assert.equal(rainbow[0].status, 'pending');
    assert.equal(rainbow[0].source, 'attendee');
    assert.equal(rainbow[0].name, 'Rainbow Knit Ltd');
  });

  test('a failed registration leaves no new pending organisation behind', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ email: `p${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    const { error } = await register(db, payload({
      email: 'p3@example.com',
      orgs: [pick(o.padma), other('factory', 'Brand New Factory'), pick(o.aspire)],
    }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.equal((await findOrgs(db, { match_key: 'brand new factory' })).length, 0);
  });

  test('picking the same organisation twice creates one link and keeps the first code', async () => {
    const id = await check(register(db, payload({
      orgs: [pick(o.padma, 'FIRST'), other('supplier', 'Padma Textiles', 'SECOND'), pick(o.aspire)],
    })));
    const links = await check(db.from('attendee_orgs').select('org_id, code').eq('attendee_id', id).eq('org_id', o.padma.id));
    assert.deepEqual(links, [{ org_id: o.padma.id, code: 'FIRST' }]);
  });

  test('a pending organisation cannot be picked by id from the public form', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.padma), pick(o.hidden)] }));
    assert.equal(error.message, 'ORG_NOT_FOUND');
  });

  test('a payload without a factory is rejected with VALIDATION', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.padma)] }));
    assert.equal(error.message, 'VALIDATION');
  });

  test('the publishable (anon) key cannot call register_attendee', async () => {
    const { error } = await anonDb().rpc('register_attendee', { p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) });
    assert.ok(error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test tests/db/register.test.js`
Expected: FAIL. The errors say function `public.register_attendee` could not be found (PostgREST `PGRST202`).

- [ ] **Step 3: Write `supabase/migrations/002_register.sql`**

```sql
-- Registration. All checks and writes happen in one transaction.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- Validates the payload, resolves typed names to organisations (creating pending ones),
-- removes duplicate organisations (first code wins), locks every organisation that would
-- use a seat and checks the limit of 2.
-- Returns [{org_id, code}]. Raises VALIDATION, ORG_NOT_FOUND or SEAT_FULL.
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
  v_other text;
  v_org_id bigint;
  v_ids bigint[] := '{}';
  v_codes text[] := '{}';
  v_suppliers int;
  v_factories int;
  v_full jsonb;
begin
  if v_from is null or v_from not in ('supplier', 'factory') then
    raise exception 'VALIDATION' using detail = 'from_type';
  end if;
  if coalesce(btrim(p->>'name'), '') = ''
     or coalesce(btrim(p->>'email'), '') = ''
     or coalesce(btrim(p->>'phone'), '') = '' then
    raise exception 'VALIDATION' using detail = 'contact';
  end if;
  if jsonb_typeof(p->'orgs') is distinct from 'array' then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  select count(*) filter (where e->>'kind' = 'supplier'),
         count(*) filter (where e->>'kind' = 'factory')
    into v_suppliers, v_factories
    from jsonb_array_elements(p->'orgs') as e;
  if v_suppliers not between 1 and 10
     or v_factories not between 1 and 10
     or v_suppliers + v_factories <> jsonb_array_length(p->'orgs') then
    raise exception 'VALIDATION' using detail = 'orgs';
  end if;

  for v_entry in select value from jsonb_array_elements(p->'orgs') loop
    v_kind := v_entry->>'kind';
    v_code := btrim(coalesce(v_entry->>'code', ''));
    if v_code = '' or (v_entry ? 'org_id') = (v_entry ? 'other_name') then
      raise exception 'VALIDATION' using detail = 'orgs';
    end if;

    if v_entry ? 'org_id' then
      select o.id into v_org_id
        from public.organisations o
       where o.id = (v_entry->>'org_id')::bigint
         and o.kind = v_kind
         and (o.status = 'approved' or p_allow_pending);
      if v_org_id is null then
        raise exception 'ORG_NOT_FOUND' using detail = v_entry->>'org_id';
      end if;
    else
      v_other := btrim(coalesce(v_entry->>'other_name', ''));
      if public.make_match_key(v_other) = '' then
        raise exception 'VALIDATION' using detail = 'other_name';
      end if;
      insert into public.organisations (kind, name, source, status)
      values (v_kind, v_other, 'attendee', 'pending')
      on conflict (kind, match_key) do nothing;
      select o.id into v_org_id
        from public.organisations o
       where o.kind = v_kind
         and o.match_key = public.make_match_key(v_other);
    end if;

    if not (v_org_id = any (v_ids)) then
      v_ids := v_ids || v_org_id;
      v_codes := v_codes || v_code;
    end if;
  end loop;

  -- Lock in id order so concurrent registrations queue instead of deadlocking.
  perform 1
     from public.organisations o
    where o.id = any (v_ids)
      and o.kind = v_from
    order by o.id
      for update;

  select jsonb_agg(o.name order by o.name) into v_full
    from public.organisations o
   where o.id = any (v_ids)
     and o.kind = v_from
     and (select count(*)
            from public.attendee_orgs ao
            join public.attendees a on a.id = ao.attendee_id
           where ao.org_id = o.id
             and a.from_type = o.kind
             and a.id is distinct from p_exclude_attendee) >= 2;
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
    insert into public.attendees (name, email, phone, from_type)
    values (btrim(p->>'name'), btrim(p->>'email'), btrim(p->>'phone'), p->>'from_type')
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

revoke execute on function private.prepare_registration(jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function private.prepare_registration(jsonb, uuid, boolean) to service_role;
revoke execute on function public.register_attendee(jsonb) from public, anon, authenticated;
grant execute on function public.register_attendee(jsonb) to service_role;
```

- [ ] **Step 4: Apply the migration to the test project**

Use the SQL Editor, or MCP `apply_migration` with `name: "002_register"`, against the **test** project.
Expected: no errors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=.env.test --test tests/db/register.test.js`
Expected: PASS, 12 tests. If the parallel test is flaky (more than 1 success), the lock step is wrong. Check that `perform ... for update` runs **before** the seat count.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/002_register.sql tests/db/register.test.js
git commit -m "feat: add register_attendee with locked seat check" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 5: Admin database functions (update, delete, approve, merge)

**Files:**
- Create: `supabase/migrations/003_admin_functions.sql`
- Test: `tests/db/admin-functions.test.js`

**Interfaces:**
- Consumes: `private.prepare_registration` (Task 4) and the Task 3 helpers.
- Produces, called as `db.rpc(name, args)` with these exact argument names:
  - `update_attendee({ p_id: uuid, p: jsonb }) → null`. Raises `NOT_FOUND`, `VALIDATION`, `ORG_NOT_FOUND`, `SEAT_FULL`, `DUPLICATE_EMAIL`.
  - `delete_attendee({ p_id: uuid }) → null`. Raises `NOT_FOUND`.
  - `approve_org({ p_id: bigint }) → null`. Raises `NOT_FOUND`.
  - `merge_org({ p_source: bigint, p_target: bigint, p_allow_over_limit: boolean }) → int`, the target's seats used after the merge. Raises `NOT_FOUND` (bad source), `VALIDATION` (bad target), or `MERGE_OVER_LIMIT` with `error.details` = JSON text `{"target":"Name","side":"factory","count":3}`.
  - `update_attendee` and `delete_attendee` both delete pending organisations left with no links.

- [ ] **Step 1: Write the failing test** `tests/db/admin-functions.test.js`

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, other, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

describe('admin database functions', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      pearl: { kind: 'supplier', name: 'Pearl Global' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
      windy: { kind: 'factory', name: 'Windy Apparels (20096)' },
    });
  });

  const reg = (fields) => check(register(db, payload(fields)));
  const pendingOrg = async (matchKey) => (await findOrgs(db, { match_key: matchKey }))[0];

  describe('update_attendee', () => {
    test('does not count the person\'s own seats', async () => {
      const p1 = await reg({ email: 'p1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'p2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await check(db.rpc('update_attendee', {
        p_id: p1,
        p: payload({ name: 'Renamed', email: 'p1@example.com', orgs: [pick(o.padma), pick(o.aspire, 'NEW')] }),
      }));
      const [row] = await check(db.from('attendees').select('name').eq('id', p1));
      assert.equal(row.name, 'Renamed');
      assert.equal((await seats(db, o.aspire.id)).seats_used, 2);
    });

    test('switching from_type re-checks seats on the other side', async () => {
      await reg({ from: 'supplier', email: 's1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ from: 'supplier', email: 's2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      const f = await reg({ from: 'factory', email: 'f@example.com', orgs: [pick(o.padma), pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: f,
        p: payload({ from: 'supplier', email: 'f@example.com', orgs: [pick(o.padma), pick(o.windy)] }),
      });
      assert.equal(error.message, 'SEAT_FULL');
      assert.deepEqual(JSON.parse(error.details), { side: 'supplier', orgs: ['Padma Textiles Ltd'] });
    });

    test('rejects another person\'s email with DUPLICATE_EMAIL', async () => {
      await reg({ email: 'taken@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      const p = await reg({ email: 'me@example.com', orgs: [pick(o.pearl), pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: p, p: payload({ email: 'TAKEN@example.com', orgs: [pick(o.pearl), pick(o.windy)] }),
      });
      assert.equal(error.message, 'DUPLICATE_EMAIL');
    });

    test('may keep a link to a pending organisation by id', async () => {
      const p = await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      await check(db.rpc('update_attendee', {
        p_id: p, p: payload({ orgs: [pick(o.padma), pick(rainbow, 'R-2')] }),
      }));
      const links = await check(db.from('attendee_orgs').select('code').eq('attendee_id', p).eq('org_id', rainbow.id));
      assert.deepEqual(links, [{ code: 'R-2' }]);
    });

    test('removing the last link to a pending organisation deletes it', async () => {
      const p = await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) }));
      assert.equal(await pendingOrg('rainbow knit'), undefined);
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('update_attendee', {
        p_id: MISSING_UUID, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }),
      });
      assert.equal(error.message, 'NOT_FOUND');
    });
  });

  describe('delete_attendee', () => {
    test('frees seats and removes pending organisations left with no links', async () => {
      const p = await reg({ orgs: [pick(o.padma), pick(o.aspire), other('factory', 'Rainbow Knit Ltd')] });
      await check(db.rpc('delete_attendee', { p_id: p }));
      assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 0, linked_count: 0 });
      assert.equal(await pendingOrg('rainbow knit'), undefined);
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('delete_attendee', { p_id: MISSING_UUID });
      assert.equal(error.message, 'NOT_FOUND');
    });
  });

  describe('approve_org', () => {
    test('approves a pending organisation once', async () => {
      await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      await check(db.rpc('approve_org', { p_id: rainbow.id }));
      assert.equal((await pendingOrg('rainbow knit')).status, 'approved');
      const again = await db.rpc('approve_org', { p_id: rainbow.id });
      assert.equal(again.error.message, 'NOT_FOUND');
    });
  });

  describe('merge_org', () => {
    test('moves links, removes duplicates, keeps the target code and deletes the source', async () => {
      const both = await reg({ email: 'both@example.com', orgs: [pick(o.padma), pick(o.aspire, 'TARGET'), other('factory', 'Aspire Garment X', 'SOURCE')] });
      const onlySource = await reg({ email: 'src@example.com', orgs: [pick(o.pearl), other('factory', 'Aspire Garment X', 'S2')] });
      const source = await pendingOrg('aspire garment x');

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: false }));
      assert.equal(count, 2);

      const links = await check(db.from('attendee_orgs').select('attendee_id, code').eq('org_id', o.aspire.id));
      const byPerson = Object.fromEntries(links.map((l) => [l.attendee_id, l.code]));
      assert.deepEqual(byPerson, { [both]: 'TARGET', [onlySource]: 'S2' });
      assert.equal(await pendingOrg('aspire garment x'), undefined);
    });

    test('refuses to go over the limit unless allowed', async () => {
      await reg({ email: 'f1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f3@example.com', orgs: [pick(o.padma), other('factory', 'Aspire Copy')] });
      const source = await pendingOrg('aspire copy');

      const refused = await db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(refused.error.message, 'MERGE_OVER_LIMIT');
      assert.deepEqual(JSON.parse(refused.error.details), { target: 'Aspire Garments (24040)', side: 'factory', count: 3 });
      assert.ok(await pendingOrg('aspire copy'), 'source must remain after a refused merge');

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: true }));
      assert.equal(count, 3);
      assert.equal((await seats(db, o.aspire.id)).seats_used, 3);
    });

    test('rejects a target of another kind and a source that is not pending', async () => {
      await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      const wrongKind = await db.rpc('merge_org', { p_source: rainbow.id, p_target: o.padma.id, p_allow_over_limit: false });
      assert.equal(wrongKind.error.message, 'VALIDATION');
      const notPending = await db.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(notPending.error.message, 'NOT_FOUND');
    });
  });

  test('the publishable (anon) key cannot call admin functions', async () => {
    const p = await reg({ orgs: [pick(o.padma), pick(o.aspire)] });
    const anon = anonDb();
    assert.ok((await anon.rpc('delete_attendee', { p_id: p })).error);
    assert.ok((await anon.rpc('approve_org', { p_id: o.padma.id })).error);
    assert.ok((await anon.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: true })).error);
    assert.ok((await anon.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) })).error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --env-file=.env.test --test tests/db/admin-functions.test.js`
Expected: FAIL. The errors say functions such as `public.update_attendee` could not be found (`PGRST202`).

- [ ] **Step 3: Write `supabase/migrations/003_admin_functions.sql`**

```sql
-- Admin changes: edit, delete, approve and merge. Each call is one transaction.

create or replace function private.delete_orphan_pending()
returns void
language sql
set search_path = ''
as $$
  delete from public.organisations o
   where o.status = 'pending'
     and not exists (select 1 from public.attendee_orgs ao where ao.org_id = o.id);
$$;

create or replace function public.update_attendee(p_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_orgs jsonb;
begin
  perform 1 from public.attendees where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  v_orgs := private.prepare_registration(p, p_id, true);

  begin
    update public.attendees
       set name = btrim(p->>'name'),
           email = btrim(p->>'email'),
           phone = btrim(p->>'phone'),
           from_type = p->>'from_type',
           updated_at = now()
     where id = p_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_EMAIL';
  end;

  delete from public.attendee_orgs where attendee_id = p_id;
  insert into public.attendee_orgs (attendee_id, org_id, code)
  select p_id, (e->>'org_id')::bigint, e->>'code'
    from jsonb_array_elements(v_orgs) as e;

  perform private.delete_orphan_pending();
end;
$$;

create or replace function public.delete_attendee(p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.attendees where id = p_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  perform private.delete_orphan_pending();
end;
$$;

create or replace function public.approve_org(p_id bigint)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.organisations
     set status = 'approved'
   where id = p_id
     and status = 'pending';
  if not found then
    raise exception 'NOT_FOUND';
  end if;
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
begin
  -- Same lock order as prepare_registration (by id) to avoid deadlocks.
  perform 1 from public.organisations where id in (p_source, p_target) order by id for update;

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

  if v_count > 2 and not p_allow_over_limit then
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

revoke execute on function private.delete_orphan_pending() from public, anon, authenticated;
grant execute on function private.delete_orphan_pending() to service_role;
revoke execute on function public.update_attendee(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_attendee(uuid, jsonb) to service_role;
revoke execute on function public.delete_attendee(uuid) from public, anon, authenticated;
grant execute on function public.delete_attendee(uuid) to service_role;
revoke execute on function public.approve_org(bigint) from public, anon, authenticated;
grant execute on function public.approve_org(bigint) to service_role;
revoke execute on function public.merge_org(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.merge_org(bigint, bigint, boolean) to service_role;
```

- [ ] **Step 4: Apply the migration to the test project**

Use the SQL Editor, or MCP `apply_migration` with `name: "003_admin_functions"`, against the **test** project.
Expected: no errors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --env-file=.env.test --test tests/db/admin-functions.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 6: Run every database test together**

Run: `npm test`
Expected: PASS. Files run one at a time (`--test-concurrency=1`), so their wipes do not interfere.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/003_admin_functions.sql tests/db/admin-functions.test.js
git commit -m "feat: add admin edit, delete, approve and merge functions" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 6: Error mapping, DB call helpers and admin auth

**Files:**
- Create: `src/errors.js`, `src/auth.js`
- Modify: `src/db.js` (add helpers)
- Test: `tests/unit/errors.test.js`, `tests/unit/auth.test.js`

**Interfaces:**
- Consumes: the database error contract from Tasks 4–5 (`error.message` = code, `error.details` = JSON text or area name).
- Produces:
  - `src/errors.js`:
    - `class AppError extends Error { code, status, extra }`, constructed as `new AppError(code, status, message, extra = {})`.
    - `errors.validation(fields)`, `errors.unauthorised(message?)`, `errors.notFound()`, `errors.dbUnavailable()`, `errors.internal(cause?)`.
    - `fromDbError(error) → AppError`
    - `errorHandler(err, req, res, next)`, the Express error middleware. It writes `{ error, message, ...extra }`.
  - `src/db.js` adds:
    - `callRpc(db, fn, args) → data`, which throws `fromDbError(error)`.
    - `runQuery(request) → data`, which also throws `fromDbError(error)`.
  - `src/auth.js`:
    - `COOKIE_NAME = 'admin_session'`, `SESSION_SECONDS = 43200`
    - `passwordMatches(given, expected) → boolean`
    - `signSession(secret, nowSeconds?) → string`
    - `verifySession(value, secret, nowSeconds?) → boolean`
    - `cookieOptions(config) → object` for `res.cookie`
    - `clearCookieOptions(config) → object` for `res.clearCookie`
    - `requireAdmin(config) → middleware`, which calls `next(errors.unauthorised())` when the cookie is invalid.

- [ ] **Step 1: Write the failing test** `tests/unit/errors.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorHandler, errors, fromDbError } from '../../src/errors.js';

const dbError = (message, details = null, code = 'P0001') => ({ message, details, hint: null, code });

test('SEAT_FULL becomes 409 naming the side and organisations', () => {
  const err = fromDbError(dbError('SEAT_FULL', JSON.stringify({ side: 'factory', orgs: ['Aspire (1)', 'Windy (2)'] })));
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'SEAT_FULL');
  assert.equal(err.status, 409);
  assert.equal(err.message, 'Already full (2 factory attendees): Aspire (1); Windy (2). Remove them or contact the event team.');
});

test('DUPLICATE_EMAIL becomes 409 with the spec message', () => {
  const err = fromDbError(dbError('DUPLICATE_EMAIL'));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'This email is already registered. Contact the event team to change it.');
});

test('MERGE_OVER_LIMIT becomes 409 with the projected count', () => {
  const err = fromDbError(dbError('MERGE_OVER_LIMIT', JSON.stringify({ target: 'PADMA TEXTILES LTD', side: 'supplier', count: 3 })));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'PADMA TEXTILES LTD would have 3 supplier attendees (limit 2). Merge anyway?');
  assert.deepEqual(err.extra, { count: 3 });
});

test('NOT_FOUND and ORG_NOT_FOUND become 404', () => {
  for (const code of ['NOT_FOUND', 'ORG_NOT_FOUND']) {
    const err = fromDbError(dbError(code, '42'));
    assert.equal(err.code, code);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'That record no longer exists. Refresh and try again.');
  }
});

test('VALIDATION from the database becomes 400 with a field entry', () => {
  const err = fromDbError(dbError('VALIDATION', 'orgs'));
  assert.equal(err.status, 400);
  assert.deepEqual(err.extra, { fields: { orgs: 'Invalid value.' } });
});

test('network failures and lock timeouts become 503, anything else 500', () => {
  assert.equal(fromDbError({ message: 'TypeError: fetch failed', details: '', hint: '', code: '' }).status, 503);
  assert.equal(fromDbError(dbError('deadlock detected', null, '40P01')).status, 503);
  const other = fromDbError(dbError('relation "x" does not exist', null, '42P01'));
  assert.equal(other.status, 500);
  assert.equal(other.message, 'Something went wrong, please try again.');
});

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('errorHandler writes AppErrors as { error, message, ...extra }', () => {
  const res = fakeRes();
  errorHandler(errors.validation({ name: 'Too short.' }), { method: 'POST', originalUrl: '/api/register' }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'VALIDATION', message: 'Please check the highlighted fields.', fields: { name: 'Too short.' } });
});

test('errorHandler hides unexpected errors behind a generic 500 and logs them', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const res = fakeRes();
  errorHandler(new Error('secret db detail'), { method: 'GET', originalUrl: '/api/x' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'INTERNAL', message: 'Something went wrong, please try again.' });
  assert.equal(logged.mock.callCount(), 1);
});

test('errorHandler turns body parse errors into VALIDATION', () => {
  const res = fakeRes();
  errorHandler(Object.assign(new Error('bad json'), { type: 'entity.parse.failed', status: 400 }), { method: 'POST', originalUrl: '/api/register' }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'VALIDATION');
});
```

- [ ] **Step 2: Write the failing test** `tests/unit/auth.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOKIE_NAME, SESSION_SECONDS, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession, verifySession,
} from '../../src/auth.js';

const secret = 's'.repeat(32);
const now = 1_800_000_000;

test('a freshly signed session verifies until it expires', () => {
  const value = signSession(secret, now);
  assert.equal(verifySession(value, secret, now), true);
  assert.equal(verifySession(value, secret, now + SESSION_SECONDS - 1), true);
  assert.equal(verifySession(value, secret, now + SESSION_SECONDS), false);
});

test('tampered, foreign or malformed sessions are rejected', () => {
  const value = signSession(secret, now);
  const [expiry, signature] = value.split('.');
  const flippedLast = signature.at(-1) === 'A' ? 'B' : 'A';
  assert.equal(verifySession(`${Number(expiry) + 9999}.${signature}`, secret, now), false);
  assert.equal(verifySession(`${expiry}.${signature.slice(0, -1)}${flippedLast}`, secret, now), false);
  assert.equal(verifySession(value, 'x'.repeat(32), now), false);
  for (const junk of [undefined, '', 'abc', 'a.b.c', '.']) assert.equal(verifySession(junk, secret, now), false);
});

test('passwordMatches compares exactly and tolerates missing input', () => {
  assert.equal(passwordMatches('correct horse', 'correct horse'), true);
  assert.equal(passwordMatches('correct horse ', 'correct horse'), false);
  assert.equal(passwordMatches(undefined, 'correct horse'), false);
});

test('cookie options follow the spec', () => {
  assert.deepEqual(cookieOptions({ isProduction: true }), {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS * 1000, secure: true,
  });
  assert.deepEqual(clearCookieOptions({ isProduction: false }), { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
});

test('requireAdmin passes a valid cookie and rejects everything else with UNAUTHORISED', () => {
  const guard = requireAdmin({ sessionSecret: secret });
  const run = (cookies) => {
    let received = 'not called';
    guard({ cookies }, {}, (err) => { received = err; });
    return received;
  };
  assert.equal(run({ [COOKIE_NAME]: signSession(secret) }), undefined);
  assert.equal(run({}).code, 'UNAUTHORISED');
  assert.equal(run({ [COOKIE_NAME]: 'forged.value' }).status, 401);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/errors.test.js tests/unit/auth.test.js`
Expected: FAIL with `Cannot find module` for `src/errors.js` and `src/auth.js`.

- [ ] **Step 4: Implement `src/errors.js`**

```js
export class AppError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const RECORD_GONE = 'That record no longer exists. Refresh and try again.';
const RETRYABLE_PG_CODES = new Set(['40P01', '40001', '55P03', '57014']);

export const errors = {
  validation: (fields) => new AppError('VALIDATION', 400, 'Please check the highlighted fields.', { fields }),
  unauthorised: (message = 'Please log in again.') => new AppError('UNAUTHORISED', 401, message),
  notFound: () => new AppError('NOT_FOUND', 404, RECORD_GONE),
  dbUnavailable: () => new AppError('DB_UNAVAILABLE', 503, 'Service is busy, please try again in a moment.'),
  internal: (cause) => Object.assign(new AppError('INTERNAL', 500, 'Something went wrong, please try again.'), { cause }),
};

function parseDetails(details) {
  try {
    return JSON.parse(details) ?? {};
  } catch {
    return {};
  }
}

export function fromDbError(error) {
  switch (error?.message) {
    case 'VALIDATION':
      return errors.validation({ [error.details || 'form']: 'Invalid value.' });
    case 'NOT_FOUND':
      return errors.notFound();
    case 'ORG_NOT_FOUND':
      return new AppError('ORG_NOT_FOUND', 404, RECORD_GONE);
    case 'SEAT_FULL': {
      const { side, orgs = [] } = parseDetails(error.details);
      return new AppError(
        'SEAT_FULL',
        409,
        `Already full (2 ${side} attendees): ${orgs.join('; ')}. Remove them or contact the event team.`,
      );
    }
    case 'DUPLICATE_EMAIL':
      return new AppError('DUPLICATE_EMAIL', 409, 'This email is already registered. Contact the event team to change it.');
    case 'MERGE_OVER_LIMIT': {
      const { target, side, count } = parseDetails(error.details);
      return new AppError(
        'MERGE_OVER_LIMIT',
        409,
        `${target} would have ${count} ${side} attendees (limit 2). Merge anyway?`,
        { count },
      );
    }
    default: {
      // supabase-js reports network failures with an empty code.
      if (!error?.code || RETRYABLE_PG_CODES.has(error.code)) {
        return Object.assign(errors.dbUnavailable(), { cause: error });
      }
      return errors.internal(error);
    }
  }
}

// Express error middleware: the 4-argument signature is required.
export function errorHandler(err, req, res, _next) {
  let appError = err;
  if (typeof err?.type === 'string' && err.type.startsWith('entity.')) {
    appError = errors.validation({ form: 'Invalid request body.' });
  } else if (!(err instanceof AppError)) {
    appError = errors.internal(err);
  }
  if (appError.status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, appError.cause ?? appError);
  }
  res.status(appError.status).json({ error: appError.code, message: appError.message, ...appError.extra });
}
```

- [ ] **Step 5: Implement `src/auth.js`**

```js
import crypto from 'node:crypto';
import { errors } from './errors.js';

export const COOKIE_NAME = 'admin_session';
export const SESSION_SECONDS = 12 * 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const hmac = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

export function passwordMatches(given, expected) {
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

export function signSession(secret, now = nowSeconds()) {
  const expiry = String(now + SESSION_SECONDS);
  return `${expiry}.${hmac(expiry, secret)}`;
}

export function verifySession(value, secret, now = nowSeconds()) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !parts[1]) return false;
  const [expiry, signature] = parts;
  const expected = Buffer.from(hmac(expiry, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  return Number(expiry) > now;
}

export function clearCookieOptions(config) {
  return { httpOnly: true, sameSite: 'strict', path: '/', secure: config.isProduction };
}

export function cookieOptions(config) {
  return { ...clearCookieOptions(config), maxAge: SESSION_SECONDS * 1000 };
}

export function requireAdmin(config) {
  return (req, _res, next) => {
    if (verifySession(req.cookies?.[COOKIE_NAME], config.sessionSecret)) return next();
    return next(errors.unauthorised());
  };
}
```

The test compares `cookieOptions` with `deepEqual`. Key order does not matter there, so the spread is fine.

- [ ] **Step 6: Add the helpers to `src/db.js`**

Replace the whole file with:

```js
import { createClient } from '@supabase/supabase-js';
import { fromDbError } from './errors.js';

export function createDb(config) {
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function callRpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromDbError(error);
  return data;
}

export async function runQuery(request) {
  const { data, error } = await request;
  if (error) throw fromDbError(error);
  return data;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/unit/errors.test.js tests/unit/auth.test.js`
Expected: PASS, 9 + 5 tests.

- [ ] **Step 8: Commit**

```bash
git add src/errors.js src/auth.js src/db.js tests/unit/errors.test.js tests/unit/auth.test.js
git commit -m "feat: add error mapping, db helpers and admin session auth" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 7: Express app, public routes, server entry and Vercel config

**Files:**
- Create: `src/create-app.js`, `src/routes/public.js`, `server.js`, `vercel.json`, `tests/helpers/fake-db.js`
- Test: `tests/api/public.test.js`, `tests/db/public-api.test.js`

**Interfaces:**
- Consumes: `validateRegistration` (Task 2); `callRpc`, `runQuery` (Task 6); `errors`, `errorHandler` (Task 6); `loadConfig`, `createDb` (Task 1).
- Produces:
  - `createApp({ db, config }) → express.Application`. Task 9 extends the signature to `{ db, config, loginDelayMs }`.
  - `publicRoutes({ db, config }) → express.Router`, mounted at `/api`.
  - `GET /api/organisations → 200 { event_title, organisations: [{ id, kind, name, seats_used }] }` (approved only, ordered by name, `Cache-Control: no-store`).
  - `POST /api/register → 201 { id }`. A filled honeypot returns `201 { id: null }` without saving.
  - `tests/helpers/fake-db.js` exports:
    - `fakeDb({ rpc?: { [fn]: (args) => ({ data, error }) }, tables?: { [table]: { data, error } | () => ({ data, error }) } })`. The returned object has `.calls` (list of `{ fn, args }` or `{ table }`), `.rpc` and `.from`.
    - `testConfig`, with `adminPassword: 'correct horse battery staple'` and `sessionSecret: 's'.repeat(32)`.

- [ ] **Step 1: Create `tests/helpers/fake-db.js`**

```js
// Minimal stand-in for the Supabase client, for API tests that don't need a real database.
export function fakeDb({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      const handler = rpc[fn];
      return Promise.resolve(handler ? handler(args) : { data: null, error: null });
    },
    from(table) {
      calls.push({ table });
      const result = tables[table] ?? { data: [], error: null };
      const request = {
        select: () => request,
        eq: () => request,
        order: () => request,
        then: (resolve, reject) =>
          Promise.resolve(typeof result === 'function' ? result() : result).then(resolve, reject),
      };
      return request;
    },
  };
}

export const testConfig = {
  supabaseUrl: 'http://fake.local',
  supabaseSecretKey: 'fake',
  adminPassword: 'correct horse battery staple',
  sessionSecret: 's'.repeat(32),
  eventTitle: 'Test Event',
  isProduction: false,
};
```

- [ ] **Step 2: Write the failing test** `tests/api/public.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const body = () => ({
  from_type: 'factory',
  name: ' Rahim Uddin ',
  email: 'rahim@example.com',
  phone: '+880 1711-000000',
  website: '',
  orgs: [{ kind: 'supplier', org_id: 1, code: 'S1' }, { kind: 'factory', org_id: 2, code: 'F1' }],
});

const appWith = (db) => createApp({ db, config: testConfig });
const rpcError = (message, details = null, code = 'P0001') => () => ({ data: null, error: { message, details, hint: null, code } });

test('GET /api/organisations returns the event title and organisations without caching', async () => {
  const organisations = [{ id: 1, kind: 'supplier', name: 'Padma', seats_used: 0 }];
  const db = fakeDb({ tables: { org_status: { data: organisations, error: null } } });
  const res = await request(appWith(db)).get('/api/organisations');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { event_title: 'Test Event', organisations });
});

test('POST /api/register saves the validated payload and returns 201', async () => {
  const db = fakeDb({ rpc: { register_attendee: () => ({ data: 'new-id', error: null }) } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'new-id' });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].fn, 'register_attendee');
  assert.equal(db.calls[0].args.p.name, 'Rahim Uddin');
  assert.equal('website' in db.calls[0].args.p, false);
});

test('an invalid body returns 400 with field messages and never reaches the database', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), email: 'nope', orgs: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
  assert.ok(res.body.fields.email);
  assert.ok(res.body.fields.suppliers);
  assert.equal(db.calls.length, 0);
});

test('a filled honeypot returns 201 without saving', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.equal(db.calls.length, 0);
});

test('SEAT_FULL from the database becomes 409 with a friendly message', async () => {
  const db = fakeDb({ rpc: { register_attendee: rpcError('SEAT_FULL', '{"side":"factory","orgs":["Aspire (24040)"]}') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, {
    error: 'SEAT_FULL',
    message: 'Already full (2 factory attendees): Aspire (24040). Remove them or contact the event team.',
  });
});

test('DUPLICATE_EMAIL becomes 409', async () => {
  const db = fakeDb({ rpc: { register_attendee: rpcError('DUPLICATE_EMAIL') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'DUPLICATE_EMAIL');
});

test('a network failure becomes 503', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ rpc: { register_attendee: rpcError('TypeError: fetch failed', '', '') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'DB_UNAVAILABLE');
});

test('an unexpected database error returns a generic 500 without details', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ rpc: { register_attendee: rpcError('relation "attendees" does not exist', null, '42P01') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'INTERNAL', message: 'Something went wrong, please try again.' });
});

test('malformed JSON returns 400 VALIDATION', async () => {
  const res = await request(appWith(fakeDb()))
    .post('/api/register')
    .set('Content-Type', 'application/json')
    .send('{"name":');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('an unknown /api route returns 404 JSON', async () => {
  const res = await request(appWith(fakeDb())).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'NOT_FOUND');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/api/public.test.js`
Expected: FAIL with `Cannot find module` for `src/create-app.js`.

- [ ] **Step 4: Implement `src/routes/public.js`**

```js
import { Router } from 'express';
import { validateRegistration } from '../../public/shared/validate.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';

export function publicRoutes({ db, config }) {
  const router = Router();

  router.get('/organisations', async (_req, res) => {
    const organisations = await runQuery(
      db.from('org_status').select('id, kind, name, seats_used').eq('status', 'approved').order('name'),
    );
    res.set('Cache-Control', 'no-store');
    res.json({ event_title: config.eventTitle, organisations });
  });

  router.post('/register', async (req, res) => {
    const body = req.body ?? {};
    // Honeypot: people never see this field; bots fill it. Pretend success, save nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return res.status(201).json({ id: null });
    }
    const result = validateRegistration(body);
    if (!result.ok) throw errors.validation(result.fields);
    const id = await callRpc(db, 'register_attendee', { p: result.value });
    return res.status(201).json({ id });
  });

  return router;
}
```

- [ ] **Step 5: Implement `src/create-app.js`**

```js
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { publicRoutes } from './routes/public.js';

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', publicRoutes({ db, config }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/api/public.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 7: Write the DB-backed test** `tests/db/public-api.test.js`

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { testConfig } from '../helpers/fake-db.js';
import { check, findOrgs, other, pick, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('public API against the test database', { skip: skipReason }, () => {
  let db;
  let app;
  let o;

  before(() => {
    db = testDb();
    app = createApp({ db, config: testConfig });
  });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
    });
  });

  const person = (email, orgs) => ({ from_type: 'factory', name: 'Rahim Uddin', email, phone: '+8801711000000', orgs });
  const orgNames = async () => (await request(app).get('/api/organisations')).body.organisations.map((x) => x.name);

  test('registers through the API and reports seats used', async () => {
    await request(app).post('/api/register').send(person('a@example.com', [pick(o.padma), pick(o.aspire)])).expect(201);
    const res = await request(app).get('/api/organisations').expect(200);
    assert.equal(res.body.organisations.find((x) => x.id === o.aspire.id).seats_used, 1);
  });

  test('a full organisation returns 409 SEAT_FULL', async () => {
    for (const email of ['a@example.com', 'b@example.com']) {
      await request(app).post('/api/register').send(person(email, [pick(o.padma), pick(o.aspire)])).expect(201);
    }
    const res = await request(app).post('/api/register').send(person('c@example.com', [pick(o.padma), pick(o.aspire)]));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'SEAT_FULL');
  });

  test('pending organisations are hidden until approved', async () => {
    await request(app).post('/api/register')
      .send(person('a@example.com', [pick(o.padma), other('factory', 'Rainbow Knit Ltd')]))
      .expect(201);
    assert.equal((await orgNames()).includes('Rainbow Knit Ltd'), false);
    const [rainbow] = await findOrgs(db, { match_key: 'rainbow knit' });
    await check(db.rpc('approve_org', { p_id: rainbow.id }));
    assert.equal((await orgNames()).includes('Rainbow Knit Ltd'), true);
  });
});
```

- [ ] **Step 8: Run the DB-backed test**

Run: `node --env-file=.env.test --test tests/db/public-api.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 9: Create `server.js` and `vercel.json`**

`server.js`:
```js
// Vercel detects this file as the Express entry point and uses the default export.
// Locally (not on Vercel) it also serves public/ and listens on a port.
import express from 'express';
import { loadConfig } from './src/config.js';
import { createApp } from './src/create-app.js';
import { createDb } from './src/db.js';

const config = loadConfig();
const app = createApp({ db: createDb(config), config });

if (!process.env.VERCEL) {
  app.use(express.static('public', { extensions: ['html'] }));
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

export default app;
```

`vercel.json`:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["sin1"],
  "cleanUrls": true
}
```

- [ ] **Step 10: Smoke-test the local server against the test project**

```bash
cp .env.test .env
npm run dev
```
(Run it in the background or a second terminal.) Then:
```bash
curl -s http://localhost:3000/api/organisations
```
Expected: `{"event_title":"Test Event","organisations":[...]}`. Stop the server afterwards. `.env` is git-ignored.

- [ ] **Step 11: Commit**

```bash
git add src/create-app.js src/routes/public.js server.js vercel.json tests/helpers/fake-db.js tests/api/public.test.js tests/db/public-api.test.js
git commit -m "feat: add express app with public registration API" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 8: Dashboard data service

**Files:**
- Create: `src/services/dashboard.js`, `tests/helpers/dashboard-fixture.js`
- Test: `tests/unit/dashboard.test.js`, `tests/db/dashboard.test.js`

**Interfaces:**
- Consumes: `runQuery` (Task 6); view `org_status` and table `attendees` with the embedded `attendee_orgs` (Task 3).
- Produces:
  - `registrationStatus({ seats_used, linked_count }) → 'full' | 'registered' | 'missing'`
  - `buildDashboard({ orgs, attendees, now }) → DashboardData` (pure)
  - `loadDashboard(db) → Promise<DashboardData>`
  - `DashboardData` shape, which Tasks 9, 10 and 13 rely on:
    ```
    {
      generated_at: ISO string,
      summary: {
        participants: { total, supplier, factory },
        suppliers: { list_total, list_registered, missing, full },
        factories: { list_total, list_registered, missing, full },
        pending: number
      },
      participants: [{ id, name, email, phone, from_type, created_at, updated_at,
                       suppliers: [OrgLink], factories: [OrgLink] }],   // attendee order = created_at
      organisations: [OrgRow],   // approved only, ordered by name
      pending: [OrgRow]          // pending only, ordered by name
    }
    OrgLink = { org_id, name, code, status, uses_seat }                   // sorted by name
    OrgRow  = { id, kind, name, source, status, created_at, seats_used, linked_count,
                reg_status, people: [{ id, name, from_type, code }] }
    ```
  - Summary rules (spec §8.2–8.3): `list_total` and `list_registered` count only `source='list'` organisations. `missing` and `full` count all approved organisations of that kind.
  - `tests/helpers/dashboard-fixture.js` exports `fixtureOrgs`, `fixtureAttendees`, `fixtureNow`.

- [ ] **Step 1: Create the fixture** `tests/helpers/dashboard-fixture.js`

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
    id: 'a1', name: 'Rahim Uddin', email: 'rahim@example.com', phone: '+8801711000001', from_type: 'factory',
    created_at: '2026-09-17T08:00:00Z', updated_at: '2026-09-17T08:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1' }, { org_id: 5, code: 'R-5' }, { org_id: 3, code: 'F-3' }],
  },
  {
    id: 'a2', name: 'Karim Ahmed', email: 'karim@example.com', phone: '+8801711000002', from_type: 'factory',
    created_at: '2026-09-17T09:00:00Z', updated_at: '2026-09-17T09:00:00Z',
    attendee_orgs: [{ org_id: 3, code: 'F-3b' }],
  },
  {
    id: 'a3', name: 'Salma Begum', email: 'salma@example.com', phone: '+8801711000003', from_type: 'supplier',
    created_at: '2026-09-17T10:00:00Z', updated_at: '2026-09-17T10:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1c' }],
  },
];
```

- [ ] **Step 2: Write the failing test** `tests/unit/dashboard.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, registrationStatus } from '../../src/services/dashboard.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = () => buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });

test('registrationStatus: full at 2+ seats, registered when linked, otherwise missing', () => {
  assert.equal(registrationStatus({ seats_used: 2, linked_count: 2 }), 'full');
  assert.equal(registrationStatus({ seats_used: 3, linked_count: 3 }), 'full');
  assert.equal(registrationStatus({ seats_used: 0, linked_count: 1 }), 'registered');
  assert.equal(registrationStatus({ seats_used: 0, linked_count: 0 }), 'missing');
});

test('summary counts participants, list coverage, missing, full and pending', () => {
  const d = data();
  assert.equal(d.generated_at, '2026-09-17T08:30:00.000Z');
  assert.deepEqual(d.summary, {
    participants: { total: 3, supplier: 1, factory: 2 },
    suppliers: { list_total: 2, list_registered: 1, missing: 2, full: 0 },
    factories: { list_total: 2, list_registered: 1, missing: 1, full: 1 },
    pending: 1,
  });
});

test('participants carry their organisations split by kind, sorted by name, with seat usage', () => {
  const [rahim] = data().participants;
  assert.equal(rahim.email, 'rahim@example.com');
  assert.deepEqual(rahim.suppliers, [
    { org_id: 1, name: 'Padma Textiles Ltd', code: 'S-1', status: 'approved', uses_seat: false },
  ]);
  assert.deepEqual(rahim.factories, [
    { org_id: 3, name: 'Aspire Garments (24040)', code: 'F-3', status: 'approved', uses_seat: true },
    { org_id: 5, name: 'Rainbow Knit Ltd', code: 'R-5', status: 'pending', uses_seat: true },
  ]);
});

test('organisations list only approved ones, with status and people', () => {
  const d = data();
  assert.deepEqual(d.organisations.map((o) => o.name), [
    'Aspire Garments (24040)', 'New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global', 'Windy Apparels (20096)',
  ]);
  const aspire = d.organisations[0];
  assert.equal(aspire.reg_status, 'full');
  assert.deepEqual(aspire.people, [
    { id: 'a1', name: 'Rahim Uddin', from_type: 'factory', code: 'F-3' },
    { id: 'a2', name: 'Karim Ahmed', from_type: 'factory', code: 'F-3b' },
  ]);
  assert.equal(d.organisations.find((o) => o.name === 'Pearl Global').reg_status, 'missing');
});

test('pending organisations are listed separately with the codes people typed', () => {
  const { pending } = data();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, 'Rainbow Knit Ltd');
  assert.deepEqual(pending[0].people, [{ id: 'a1', name: 'Rahim Uddin', from_type: 'factory', code: 'R-5' }]);
});

test('links to organisations missing from the org list are ignored', () => {
  const attendees = [{ ...fixtureAttendees[1], attendee_orgs: [{ org_id: 999, code: 'X' }, { org_id: 3, code: 'F' }] }];
  const d = buildDashboard({ orgs: fixtureOrgs, attendees, now: fixtureNow });
  assert.deepEqual(d.participants[0].factories.map((f) => f.org_id), [3]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/unit/dashboard.test.js`
Expected: FAIL with `Cannot find module` for `src/services/dashboard.js`.

- [ ] **Step 4: Implement `src/services/dashboard.js`**

```js
import { runQuery } from '../db.js';

const KINDS = ['supplier', 'factory'];

export function registrationStatus({ seats_used, linked_count }) {
  if (seats_used >= 2) return 'full';
  if (linked_count >= 1) return 'registered';
  return 'missing';
}

export async function loadDashboard(db) {
  const [orgs, attendees] = await Promise.all([
    runQuery(db.from('org_status')
      .select('id, kind, name, source, status, created_at, seats_used, linked_count')
      .order('name')),
    runQuery(db.from('attendees')
      .select('id, name, email, phone, from_type, created_at, updated_at, attendee_orgs(org_id, code)')
      .order('created_at')),
  ]);
  return buildDashboard({ orgs, attendees, now: new Date() });
}

export function buildDashboard({ orgs, attendees, now }) {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const peopleByOrg = new Map(orgs.map((o) => [o.id, []]));

  const participants = attendees.map((a) => {
    const links = a.attendee_orgs
      .filter((link) => orgById.has(link.org_id))
      .map((link) => ({ ...link, org: orgById.get(link.org_id) }))
      .sort((x, y) => x.org.name.localeCompare(y.org.name));

    for (const link of links) {
      peopleByOrg.get(link.org_id).push({ id: a.id, name: a.name, from_type: a.from_type, code: link.code });
    }

    const side = (kind) => links
      .filter((link) => link.org.kind === kind)
      .map((link) => ({
        org_id: link.org_id,
        name: link.org.name,
        code: link.code,
        status: link.org.status,
        uses_seat: kind === a.from_type,
      }));

    return {
      id: a.id,
      name: a.name,
      email: a.email,
      phone: a.phone,
      from_type: a.from_type,
      created_at: a.created_at,
      updated_at: a.updated_at,
      suppliers: side('supplier'),
      factories: side('factory'),
    };
  });

  const toRow = (o) => ({ ...o, reg_status: registrationStatus(o), people: peopleByOrg.get(o.id) });
  const organisations = orgs.filter((o) => o.status === 'approved').map(toRow);
  const pending = orgs.filter((o) => o.status === 'pending').map(toRow);

  const kindSummary = (kind) => {
    const approved = organisations.filter((o) => o.kind === kind);
    const list = approved.filter((o) => o.source === 'list');
    return {
      list_total: list.length,
      list_registered: list.filter((o) => o.linked_count >= 1).length,
      missing: approved.filter((o) => o.reg_status === 'missing').length,
      full: approved.filter((o) => o.reg_status === 'full').length,
    };
  };

  const [suppliers, factories] = KINDS.map(kindSummary);
  return {
    generated_at: now.toISOString(),
    summary: {
      participants: {
        total: participants.length,
        supplier: participants.filter((p) => p.from_type === 'supplier').length,
        factory: participants.filter((p) => p.from_type === 'factory').length,
      },
      suppliers,
      factories,
      pending: pending.length,
    },
    participants,
    organisations,
    pending,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/unit/dashboard.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the DB-backed test** `tests/db/dashboard.test.js`

This test proves the embedded `attendee_orgs(org_id, code)` select works against real PostgREST.

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadDashboard } from '../../src/services/dashboard.js';
import { check, other, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('loadDashboard against the test database', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
    });
  });

  test('loads participants with their organisations and separates pending ones', async () => {
    await check(register(db, payload({ orgs: [pick(o.padma, 'S-1'), pick(o.aspire, 'F-1'), other('factory', 'Rainbow Knit Ltd', 'R-1')] })));
    const d = await loadDashboard(db);
    assert.equal(d.summary.participants.total, 1);
    assert.deepEqual(d.participants[0].factories.map((f) => [f.name, f.code]), [
      ['Aspire Garments (24040)', 'F-1'],
      ['Rainbow Knit Ltd', 'R-1'],
    ]);
    assert.equal(d.organisations.length, 2);
    assert.equal(d.pending.length, 1);
    assert.equal(d.summary.factories.full, 0);
  });
});
```

- [ ] **Step 7: Run the DB-backed test**

Run: `node --env-file=.env.test --test tests/db/dashboard.test.js`
Expected: PASS, 1 test.

- [ ] **Step 8: Commit**

```bash
git add src/services/dashboard.js tests/helpers/dashboard-fixture.js tests/unit/dashboard.test.js tests/db/dashboard.test.js
git commit -m "feat: add dashboard data service" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 9: Admin API routes

**Files:**
- Create: `src/routes/admin.js`
- Modify: `src/create-app.js`
- Test: `tests/api/admin.test.js`

**Interfaces:**
- Consumes:
  - From Task 6: `passwordMatches`, `signSession`, `cookieOptions`, `clearCookieOptions`, `requireAdmin`, `COOKIE_NAME`, plus `callRpc`, `errors` and `AppError`.
  - From Task 8: `loadDashboard`.
  - From Task 2: `validateRegistration`.
- Produces:
  - `createApp({ db, config, loginDelayMs = 1000 })`
  - `adminRoutes({ db, config, loginDelayMs }) → express.Router`, mounted at `/api/admin`. Task 10 adds `GET /export` to this router.
  - Endpoints:
    - `POST /login { password }` → `200 { ok: true }` and sets `admin_session`. A wrong password waits `loginDelayMs`, then returns `401 { error: 'UNAUTHORISED', message: 'Wrong password.' }`.
    - `POST /logout` → `200 { ok: true }` and clears the cookie. No session needed.
    - Everything below requires a valid cookie; without one it returns `401 { error: 'UNAUTHORISED', message: 'Please log in again.' }`.
    - `GET /data` → `200 DashboardData` with `Cache-Control: no-store`
    - `PUT /participants/:id` with a registration body → `200 { ok: true }`
    - `DELETE /participants/:id` → `200 { ok: true }`
    - `POST /organisations/:id/approve` → `200 { ok: true }`
    - `POST /organisations/:id/merge { target_id, allow_over_limit }` → `200 { ok: true, seats_used }`
  - A malformed `:id` (not a UUID or not a positive integer) returns 404 `NOT_FOUND` without calling the database.

- [ ] **Step 1: Write the failing test** `tests/api/admin.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { COOKIE_NAME, SESSION_SECONDS, signSession } from '../../src/auth.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';
import { fixtureAttendees, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const PERSON_ID = '3f0c1d2e-4b5a-4c6d-8e7f-0123456789ab';
const validCookie = () => `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`;
const appWith = (db) => createApp({ db, config: testConfig, loginDelayMs: 0 });
const body = () => ({
  from_type: 'supplier', name: 'Rahim Uddin', email: 'rahim@example.com', phone: '+8801711000000',
  orgs: [{ kind: 'supplier', org_id: 1, code: 'S1' }, { kind: 'factory', org_id: 2, code: 'F1' }],
});
const rpcError = (message, details = null) => () => ({ data: null, error: { message, details, hint: null, code: 'P0001' } });

const protectedRoutes = [
  ['get', '/api/admin/data'],
  ['put', `/api/admin/participants/${PERSON_ID}`],
  ['delete', `/api/admin/participants/${PERSON_ID}`],
  ['post', '/api/admin/organisations/1/approve'],
  ['post', '/api/admin/organisations/1/merge'],
];

test('protected admin routes return 401 without a valid cookie and never touch the database', async () => {
  const db = fakeDb();
  const app = appWith(db);
  const expired = `${COOKIE_NAME}=${signSession(testConfig.sessionSecret, Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1)}`;
  const forged = `${COOKIE_NAME}=${signSession('x'.repeat(32))}`;
  for (const [method, path] of protectedRoutes) {
    for (const cookie of [null, expired, forged]) {
      const req = request(app)[method](path);
      if (cookie) req.set('Cookie', cookie);
      const res = await req;
      assert.equal(res.status, 401, `${method} ${path} with ${cookie ? 'bad cookie' : 'no cookie'}`);
      assert.deepEqual(res.body, { error: 'UNAUTHORISED', message: 'Please log in again.' });
    }
  }
  assert.equal(db.calls.length, 0);
});

test('login with the wrong password returns 401 and sets no cookie', async () => {
  const res = await request(appWith(fakeDb())).post('/api/admin/login').send({ password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.message, 'Wrong password.');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login with the right password sets a strict, http-only session cookie that unlocks /data', async () => {
  const db = fakeDb({
    tables: { org_status: { data: fixtureOrgs, error: null }, attendees: { data: fixtureAttendees, error: null } },
  });
  const agent = request.agent(appWith(db));
  const login = await agent.post('/api/admin/login').send({ password: testConfig.adminPassword });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=43200/);

  const data = await agent.get('/api/admin/data');
  assert.equal(data.status, 200);
  assert.equal(data.headers['cache-control'], 'no-store');
  assert.equal(data.body.summary.participants.total, 3);
});

test('logout clears the cookie even without a session', async () => {
  const res = await request(appWith(fakeDb())).post('/api/admin/logout');
  assert.equal(res.status, 200);
  assert.match(res.headers['set-cookie'][0], /^admin_session=;/);
});

test('PUT /participants/:id validates the body and calls update_attendee', async () => {
  const db = fakeDb();
  const app = appWith(db);
  const bad = await request(app).put(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie()).send({ ...body(), phone: 'x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.phone);
  assert.equal(db.calls.length, 0);

  const ok = await request(app).put(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie()).send(body());
  assert.equal(ok.status, 200);
  assert.equal(db.calls[0].fn, 'update_attendee');
  assert.equal(db.calls[0].args.p_id, PERSON_ID);
  assert.equal(db.calls[0].args.p.email, 'rahim@example.com');
});

test('a malformed participant id returns 404 without calling the database', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).delete('/api/admin/participants/not-a-uuid').set('Cookie', validCookie());
  assert.equal(res.status, 404);
  assert.equal(db.calls.length, 0);
});

test('DELETE /participants/:id calls delete_attendee and maps NOT_FOUND to 404', async () => {
  const db = fakeDb({ rpc: { delete_attendee: rpcError('NOT_FOUND') } });
  const res = await request(appWith(db)).delete(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie());
  assert.equal(res.status, 404);
  assert.deepEqual(db.calls[0], { fn: 'delete_attendee', args: { p_id: PERSON_ID } });
});

test('POST /organisations/:id/approve calls approve_org with a numeric id', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/admin/organisations/42/approve').set('Cookie', validCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(db.calls[0], { fn: 'approve_org', args: { p_id: 42 } });
});

test('POST /organisations/:id/merge passes allow_over_limit and maps MERGE_OVER_LIMIT to 409', async () => {
  let allow = false;
  const db = fakeDb({
    rpc: {
      merge_org: (args) => {
        allow = args.p_allow_over_limit;
        return allow
          ? { data: 3, error: null }
          : rpcError('MERGE_OVER_LIMIT', '{"target":"Aspire (24040)","side":"factory","count":3}')();
      },
    },
  });
  const app = appWith(db);

  const refused = await request(app).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({ target_id: 3 });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: 'MERGE_OVER_LIMIT', message: 'Aspire (24040) would have 3 factory attendees (limit 2). Merge anyway?', count: 3,
  });

  const merged = await request(app).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({ target_id: 3, allow_over_limit: true });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body, { ok: true, seats_used: 3 });
  assert.deepEqual(db.calls.at(-1).args, { p_source: 7, p_target: 3, p_allow_over_limit: true });
});

test('merge without a valid target_id returns 400', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({});
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.target_id);
  assert.equal(db.calls.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/api/admin.test.js`
Expected: FAIL. Admin routes are not mounted yet, so the first test gets 404 instead of 401.

- [ ] **Step 3: Implement `src/routes/admin.js`**

```js
import { Router } from 'express';
import { validateRegistration } from '../../public/shared/validate.js';
import {
  COOKIE_NAME, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession,
} from '../auth.js';
import { callRpc } from '../db.js';
import { errors } from '../errors.js';
import { loadDashboard } from '../services/dashboard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function participantId(value) {
  if (!UUID_RE.test(value)) throw errors.notFound();
  return value;
}

function organisationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw errors.notFound();
  return id;
}

export function adminRoutes({ db, config, loginDelayMs }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    if (!passwordMatches(req.body?.password, config.adminPassword)) {
      await wait(loginDelayMs);
      throw errors.unauthorised('Wrong password.');
    }
    res.cookie(COOKIE_NAME, signSession(config.sessionSecret), cookieOptions(config));
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, clearCookieOptions(config));
    res.json({ ok: true });
  });

  router.use(requireAdmin(config));

  router.get('/data', async (_req, res) => {
    const data = await loadDashboard(db);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  });

  router.put('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const result = validateRegistration(req.body);
    if (!result.ok) throw errors.validation(result.fields);
    await callRpc(db, 'update_attendee', { p_id: id, p: result.value });
    res.json({ ok: true });
  });

  router.delete('/participants/:id', async (req, res) => {
    await callRpc(db, 'delete_attendee', { p_id: participantId(req.params.id) });
    res.json({ ok: true });
  });

  router.post('/organisations/:id/approve', async (req, res) => {
    await callRpc(db, 'approve_org', { p_id: organisationId(req.params.id) });
    res.json({ ok: true });
  });

  router.post('/organisations/:id/merge', async (req, res) => {
    const sourceId = organisationId(req.params.id);
    const targetId = req.body?.target_id;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      throw errors.validation({ target_id: 'Choose an organisation to merge into.' });
    }
    const seats_used = await callRpc(db, 'merge_org', {
      p_source: sourceId,
      p_target: targetId,
      p_allow_over_limit: req.body.allow_over_limit === true,
    });
    res.json({ ok: true, seats_used });
  });

  return router;
}
```

- [ ] **Step 4: Mount the router in `src/create-app.js`**

Replace the whole file with:

```js
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler, errors } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

export function createApp({ db, config, loginDelayMs = 1000 }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/admin', adminRoutes({ db, config, loginDelayMs }));
  app.use('/api', publicRoutes({ db, config }));

  app.use('/api', (_req, _res, next) => next(errors.notFound()));
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 5: Run the admin and public API tests**

Run: `node --test tests/api/`
Expected: PASS, 10 admin + 10 public tests.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.js src/create-app.js tests/api/admin.test.js
git commit -m "feat: add admin API with session login" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 10: Excel export

**Files:**
- Create: `src/services/export.js`
- Modify: `src/routes/admin.js` (add `GET /export`)
- Test: `tests/unit/export.test.js`, `tests/api/export.test.js`

**Interfaces:**
- Consumes: `DashboardData` from Task 8; `loadDashboard`; the fixture from Task 8; `adminRoutes` from Task 9.
- Produces:
  - `formatDhaka(isoOrDate) → 'YYYY-MM-DD HH:mm'` (Asia/Dhaka)
  - `exportFilename(date) → 'registrations-YYYY-MM-DD-HHmm.xlsx'` (Asia/Dhaka)
  - `buildWorkbook(data: DashboardData) → ExcelJS.Workbook`. Sheets in this order: `Summary`, `Participants`, `Participant-Orgs`, `Suppliers`, `Factories`, `Missing`, `Pending`.
  - `GET /api/admin/export` (cookie required) → 200 xlsx with `Content-Disposition: attachment; filename="registrations-….xlsx"`.

- [ ] **Step 1: Write the failing test** `tests/unit/export.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildDashboard } from '../../src/services/dashboard.js';
import { buildWorkbook, exportFilename, formatDhaka } from '../../src/services/export.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = () => buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });

async function roundTrip(workbook) {
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  return loaded;
}

const headers = (sheet) => sheet.getRow(1).values.slice(1);
const column = (sheet, n) => sheet.getColumn(n).values.slice(2);

test('times and filenames use Asia/Dhaka (UTC+6)', () => {
  assert.equal(formatDhaka('2026-09-17T08:00:00Z'), '2026-09-17 14:00');
  assert.equal(formatDhaka('2026-09-17T20:05:00Z'), '2026-09-18 02:05');
  assert.equal(exportFilename(new Date('2026-09-17T08:30:00Z')), 'registrations-2026-09-17-1430.xlsx');
});

test('the workbook has the seven sheets in order, each with a bold frozen filtered header', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  assert.deepEqual(wb.worksheets.map((s) => s.name), [
    'Summary', 'Participants', 'Participant-Orgs', 'Suppliers', 'Factories', 'Missing', 'Pending',
  ]);
  for (const sheet of wb.worksheets) {
    assert.equal(sheet.getRow(1).getCell(1).font?.bold, true, `${sheet.name} header bold`);
    assert.equal(sheet.views[0]?.state, 'frozen', `${sheet.name} frozen`);
    assert.ok(sheet.autoFilter, `${sheet.name} has filters`);
  }
});

test('Summary lists every dashboard number', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  const summary = Object.fromEntries(
    wb.getWorksheet('Summary').getSheetValues().slice(2).map((row) => [row[1], row[2]]),
  );
  assert.equal(summary['Exported at (Asia/Dhaka)'], '2026-09-17 14:30');
  assert.equal(summary.Participants, 3);
  assert.equal(summary['Participants from factories'], 2);
  assert.equal(summary['Suppliers registered (from list)'], 1);
  assert.equal(summary['Suppliers on list'], 2);
  assert.equal(summary['Factories full'], 1);
  assert.equal(summary['Pending approvals'], 1);
});

test('Participants has one row per person with joined organisations and codes', async () => {
  const sheet = (await roundTrip(buildWorkbook(data()))).getWorksheet('Participants');
  assert.deepEqual(headers(sheet), [
    'Name', 'Email', 'Phone', 'From', 'Suppliers', 'Supplier codes', 'Factories', 'Factory codes', 'Registered at',
  ]);
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    'Rahim Uddin', 'rahim@example.com', '+8801711000001', 'Factory',
    'Padma Textiles Ltd', 'S-1', 'Aspire Garments (24040); Rainbow Knit Ltd', 'F-3; R-5', '2026-09-17 14:00',
  ]);
});

test('Participant-Orgs has one row per person–organisation link', async () => {
  const sheet = (await roundTrip(buildWorkbook(data()))).getWorksheet('Participant-Orgs');
  assert.deepEqual(headers(sheet), ['Name', 'Email', 'Phone', 'From', 'Org kind', 'Org name', 'Code', 'Uses seat', 'Org status']);
  assert.equal(sheet.rowCount, 1 + 5);
  assert.deepEqual(column(sheet, 8), ['N', 'Y', 'Y', 'Y', 'Y']);
});

test('Suppliers, Factories, Missing and Pending sheets match the dashboard', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  const suppliers = wb.getWorksheet('Suppliers');
  assert.deepEqual(headers(suppliers), ['Name', 'Source', 'Status', 'Seats used', 'Linked count', 'Registration status', 'People']);
  assert.deepEqual(column(suppliers, 1), ['New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global']);
  assert.deepEqual(column(suppliers, 6), ['Missing', 'Registered', 'Missing']);
  assert.equal(suppliers.getRow(3).getCell(7).value, 'Rahim Uddin (Factory); Salma Begum (Supplier)');

  assert.deepEqual(column(wb.getWorksheet('Factories'), 6), ['Full', 'Missing']);
  assert.deepEqual(column(wb.getWorksheet('Missing'), 2), ['New Supplier Co', 'Pearl Global', 'Windy Apparels (20096)']);

  const pending = wb.getWorksheet('Pending');
  assert.deepEqual(headers(pending), ['Kind', 'Name', 'People', 'Codes typed', 'Created at']);
  assert.deepEqual(pending.getRow(2).values.slice(1), ['Factory', 'Rainbow Knit Ltd', 'Rahim Uddin (Factory)', 'R-5', '2026-09-17 12:15']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/export.test.js`
Expected: FAIL with `Cannot find module` for `src/services/export.js`.

- [ ] **Step 3: Implement `src/services/export.js`**

```js
import ExcelJS from 'exceljs';

const TIME_ZONE = 'Asia/Dhaka';
const SIDE = { supplier: 'Supplier', factory: 'Factory' };
const REG_STATUS = { missing: 'Missing', registered: 'Registered', full: 'Full' };
const ORG_STATUS = { approved: 'Approved', pending: 'Pending' };

function dhakaParts(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function formatDhaka(value) {
  const p = dhakaParts(value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function exportFilename(date) {
  const p = dhakaParts(date);
  return `registrations-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.xlsx`;
}

const names = (list) => list.map((x) => x.name).join('; ');
const codes = (list) => list.map((x) => x.code).join('; ');
const peopleText = (people) => people.map((p) => `${p.name} (${SIDE[p.from_type]})`).join('; ');

// columns: [header, key, width]
function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRows(rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

const ORG_COLUMNS = [
  ['Name', 'name', 45],
  ['Source', 'source', 10],
  ['Status', 'status', 12],
  ['Seats used', 'seats_used', 12],
  ['Linked count', 'linked_count', 13],
  ['Registration status', 'reg_status', 20],
  ['People', 'people', 60],
];

const orgRow = (o) => ({
  name: o.name,
  source: o.source === 'list' ? 'List' : 'New',
  status: ORG_STATUS[o.status],
  seats_used: o.seats_used,
  linked_count: o.linked_count,
  reg_status: REG_STATUS[o.reg_status],
  people: peopleText(o.people),
});

export function buildWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(data.generated_at);
  const s = data.summary;

  addSheet(workbook, 'Summary', [['Item', 'item', 40], ['Value', 'value', 20]], [
    { item: 'Exported at (Asia/Dhaka)', value: formatDhaka(data.generated_at) },
    { item: 'Participants', value: s.participants.total },
    { item: 'Participants from suppliers', value: s.participants.supplier },
    { item: 'Participants from factories', value: s.participants.factory },
    { item: 'Suppliers registered (from list)', value: s.suppliers.list_registered },
    { item: 'Suppliers on list', value: s.suppliers.list_total },
    { item: 'Suppliers missing', value: s.suppliers.missing },
    { item: 'Suppliers full', value: s.suppliers.full },
    { item: 'Factories registered (from list)', value: s.factories.list_registered },
    { item: 'Factories on list', value: s.factories.list_total },
    { item: 'Factories missing', value: s.factories.missing },
    { item: 'Factories full', value: s.factories.full },
    { item: 'Pending approvals', value: s.pending },
  ]);

  addSheet(workbook, 'Participants', [
    ['Name', 'name', 25], ['Email', 'email', 30], ['Phone', 'phone', 18], ['From', 'from', 10],
    ['Suppliers', 'suppliers', 45], ['Supplier codes', 'supplier_codes', 20],
    ['Factories', 'factories', 45], ['Factory codes', 'factory_codes', 20], ['Registered at', 'registered_at', 18],
  ], data.participants.map((p) => ({
    name: p.name,
    email: p.email,
    phone: p.phone,
    from: SIDE[p.from_type],
    suppliers: names(p.suppliers),
    supplier_codes: codes(p.suppliers),
    factories: names(p.factories),
    factory_codes: codes(p.factories),
    registered_at: formatDhaka(p.created_at),
  })));

  addSheet(workbook, 'Participant-Orgs', [
    ['Name', 'name', 25], ['Email', 'email', 30], ['Phone', 'phone', 18], ['From', 'from', 10],
    ['Org kind', 'kind', 10], ['Org name', 'org_name', 45], ['Code', 'code', 15],
    ['Uses seat', 'uses_seat', 10], ['Org status', 'org_status', 12],
  ], data.participants.flatMap((p) => [
    ...p.suppliers.map((o) => ['supplier', o]),
    ...p.factories.map((o) => ['factory', o]),
  ].map(([kind, o]) => ({
    name: p.name,
    email: p.email,
    phone: p.phone,
    from: SIDE[p.from_type],
    kind: SIDE[kind],
    org_name: o.name,
    code: o.code,
    uses_seat: o.uses_seat ? 'Y' : 'N',
    org_status: ORG_STATUS[o.status],
  }))));

  addSheet(workbook, 'Suppliers', ORG_COLUMNS, data.organisations.filter((o) => o.kind === 'supplier').map(orgRow));
  addSheet(workbook, 'Factories', ORG_COLUMNS, data.organisations.filter((o) => o.kind === 'factory').map(orgRow));

  const missing = ['supplier', 'factory'].flatMap((kind) =>
    data.organisations.filter((o) => o.kind === kind && o.reg_status === 'missing'));
  addSheet(workbook, 'Missing', [['Kind', 'kind', 12], ['Name', 'name', 50]],
    missing.map((o) => ({ kind: SIDE[o.kind], name: o.name })));

  addSheet(workbook, 'Pending', [
    ['Kind', 'kind', 12], ['Name', 'name', 45], ['People', 'people', 50], ['Codes typed', 'codes', 25], ['Created at', 'created_at', 18],
  ], data.pending.map((o) => ({
    kind: SIDE[o.kind],
    name: o.name,
    people: peopleText(o.people),
    codes: codes(o.people),
    created_at: formatDhaka(o.created_at),
  })));

  return workbook;
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --test tests/unit/export.test.js`
Expected: PASS, 6 tests. `addSheet` sets `sheet.columns` before `row.font`, so the header cells already exist and receive the bold font. If that assertion fails, check the order of those two lines.

- [ ] **Step 5: Write the failing route test** `tests/api/export.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { COOKIE_NAME, signSession } from '../../src/auth.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';
import { fixtureAttendees, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

test('GET /api/admin/export requires a session', async () => {
  const res = await request(createApp({ db: fakeDb(), config: testConfig, loginDelayMs: 0 })).get('/api/admin/export');
  assert.equal(res.status, 401);
});

test('GET /api/admin/export downloads an xlsx built from the dashboard data', async () => {
  const db = fakeDb({
    tables: { org_status: { data: fixtureOrgs, error: null }, attendees: { data: fixtureAttendees, error: null } },
  });
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .get('/api/admin/export')
    .set('Cookie', `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`)
    .buffer(true)
    .parse(binary);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers['content-disposition'], /^attachment; filename="registrations-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx"$/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.worksheets.length, 7);
  assert.equal(workbook.getWorksheet('Participants').rowCount, 4);
});
```

- [ ] **Step 6: Run the route test to verify it fails**

Run: `node --test tests/api/export.test.js`
Expected: the first test passes (401 from `requireAdmin`). The second fails with 404, because `/export` isn't defined yet.

- [ ] **Step 7: Add the route to `src/routes/admin.js`**

Add this import next to the other service import:
```js
import { buildWorkbook, exportFilename } from '../services/export.js';
```

Add this route directly after the `router.get('/data', …)` handler:
```js
  router.get('/export', async (_req, res) => {
    const data = await loadDashboard(db);
    const buffer = await buildWorkbook(data).xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(new Date(data.generated_at))}"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(buffer));
  });
```

- [ ] **Step 8: Run all API and unit tests**

Run: `node --test tests/api/ tests/unit/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/services/export.js src/routes/admin.js tests/unit/export.test.js tests/api/export.test.js
git commit -m "feat: add Excel export of dashboard data" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 11: Import the supplier and factory list from Excel

**Files:**
- Create: `src/services/import.js`, `scripts/import-orgs.js`
- Test: `tests/unit/import.test.js`, `tests/db/import.test.js`

**Interfaces:**
- Consumes: `runQuery` (Task 6), `loadConfig` and `createDb` (Task 1), the `organisations` table (Task 3).
- Produces:
  - `readAssignments(filePath) → Promise<[{ kind, name }]>`
    - Reads sheet `Assignments`, or the first sheet if that name is missing.
    - Requires `A1 = Supplier` and `B1 = Factory`.
    - Goes row by row, supplier before factory, trimming names and skipping blanks.
  - `importOrganisations(db, orgs) → Promise<{ read, inserted }>`. It inserts `source='list', status='approved'` and ignores any `(kind, match_key)` that already exists.
  - CLI: `node --env-file=<file> scripts/import-orgs.js "<path to xlsx>"`. It prints `Read N suppliers and M factories; inserted X new organisations (Y already existed).`

- [ ] **Step 1: Write the failing test** `tests/unit/import.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { readAssignments } from '../../src/services/import.js';

async function writeXlsx(t, rows, sheetName = 'Assignments') {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'list.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(file);
  return file;
}

test('reads suppliers and factories row by row, trimming names and skipping blanks', async (t) => {
  const file = await writeXlsx(t, [
    ['Supplier', 'Factory'],
    ['PADMA TEXTILES LTD ', 'Aspire Garments Ltd PJT (24040)'],
    [null, ' Windy Apparels Ltd (20096)'],
    ['PEARL GLOBAL (HK) LTD', ''],
  ]);
  assert.deepEqual(await readAssignments(file), [
    { kind: 'supplier', name: 'PADMA TEXTILES LTD' },
    { kind: 'factory', name: 'Aspire Garments Ltd PJT (24040)' },
    { kind: 'factory', name: 'Windy Apparels Ltd (20096)' },
    { kind: 'supplier', name: 'PEARL GLOBAL (HK) LTD' },
  ]);
});

test('falls back to the first sheet when there is no Assignments sheet', async (t) => {
  const file = await writeXlsx(t, [['Supplier', 'Factory'], ['A Supplier', 'A Factory']], 'Sheet1');
  assert.equal((await readAssignments(file)).length, 2);
});

test('rejects a sheet without Supplier / Factory headers', async (t) => {
  const file = await writeXlsx(t, [['Name', 'Code'], ['x', 'y']]);
  await assert.rejects(readAssignments(file), /Expected headers "Supplier" and "Factory"/);
});
```

- [ ] **Step 2: Write the failing DB test** `tests/db/import.test.js`

```js
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importOrganisations } from '../../src/services/import.js';
import { findOrgs, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('importOrganisations against the test database', { skip: skipReason }, () => {
  let db;
  before(() => { db = testDb(); });
  beforeEach(() => wipe(db));

  test('inserts list organisations once and is safe to re-run', async () => {
    const orgs = [
      { kind: 'supplier', name: 'PADMA TEXTILES LTD' },
      { kind: 'factory', name: 'Aspire Garments Ltd PJT (24040)' },
      { kind: 'supplier', name: 'Padma Textiles Limited' },
    ];
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 2 });
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 0 });
    const rows = await findOrgs(db, { source: 'list' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'approved'));
  });

  test('leaves an existing pending organisation with the same key untouched', async () => {
    await seedOrgs(db, { rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' } });
    assert.deepEqual(await importOrganisations(db, [{ kind: 'factory', name: 'RAINBOW KNIT LIMITED' }]), { read: 1, inserted: 0 });
    const [row] = await findOrgs(db, { match_key: 'rainbow knit' });
    assert.equal(row.status, 'pending');
    assert.equal(row.name, 'Rainbow Knit Ltd');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --env-file=.env.test --test tests/unit/import.test.js tests/db/import.test.js`
Expected: FAIL with `Cannot find module` for `src/services/import.js`.

- [ ] **Step 4: Implement `src/services/import.js`**

```js
import ExcelJS from 'exceljs';
import { runQuery } from '../db.js';

export async function readAssignments(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('Assignments') ?? workbook.worksheets[0];

  const supplierHeader = sheet.getCell('A1').text.trim();
  const factoryHeader = sheet.getCell('B1').text.trim();
  if (supplierHeader !== 'Supplier' || factoryHeader !== 'Factory') {
    throw new Error(
      `Expected headers "Supplier" and "Factory" in A1:B1, found "${supplierHeader}" and "${factoryHeader}"`,
    );
  }

  const orgs = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const supplier = row.getCell(1).text.trim();
    const factory = row.getCell(2).text.trim();
    if (supplier) orgs.push({ kind: 'supplier', name: supplier });
    if (factory) orgs.push({ kind: 'factory', name: factory });
  });
  return orgs;
}

export async function importOrganisations(db, orgs) {
  const rows = orgs.map((o) => ({ kind: o.kind, name: o.name, source: 'list', status: 'approved' }));
  const inserted = await runQuery(
    db.from('organisations')
      .upsert(rows, { onConflict: 'kind,match_key', ignoreDuplicates: true })
      .select('id'),
  );
  return { read: rows.length, inserted: inserted.length };
}
```

- [ ] **Step 5: Implement `scripts/import-orgs.js`**

```js
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { importOrganisations, readAssignments } from '../src/services/import.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node --env-file=.env scripts/import-orgs.js "<path to xlsx>"');
  process.exit(1);
}

const orgs = await readAssignments(filePath);
const suppliers = orgs.filter((o) => o.kind === 'supplier').length;
const factories = orgs.length - suppliers;
const { read, inserted } = await importOrganisations(createDb(loadConfig()), orgs);

console.log(
  `Read ${suppliers} suppliers and ${factories} factories; inserted ${inserted} new organisations (${read - inserted} already existed).`,
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --env-file=.env.test --test tests/unit/import.test.js tests/db/import.test.js`
Expected: PASS, 3 unit + 2 DB tests.

- [ ] **Step 7: Import the real list into the test project**

The earlier DB tests wiped it, so this gives Tasks 12–13 real data to try in the browser.

```bash
node --env-file=.env.test scripts/import-orgs.js "C:/Users/Shoaib/Downloads/Assignments (3).xlsx"
```
Expected: `Read 61 suppliers and 129 factories; inserted 190 new organisations (0 already existed).`

Run it a second time.
Expected: `… inserted 0 new organisations (190 already existed).`

- [ ] **Step 8: Commit**

The Excel file is business data and stays out of git.

```bash
git add src/services/import.js scripts/import-orgs.js tests/unit/import.test.js tests/db/import.test.js
git commit -m "feat: add Excel import for supplier and factory list" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 12: Registration page

**Files:**
- Create: `public/shared/form-logic.js`, `public/js/api.js`, `public/js/registration-form.js`, `public/js/register.js`, `public/index.html`, `public/styles.css`, `.claude/launch.json`
- Test: `tests/unit/form-logic.test.js`, plus a manual browser check

**Interfaces:**
- Consumes:
  - From Task 2: `validateRegistration` and `MAX_ORGS_PER_KIND` via `/shared/validate.js`.
  - From Task 7: `GET /api/organisations` and `POST /api/register`.
  - The error body `{ error, message, fields? }` from spec §9.
- Produces:
  - `public/shared/form-logic.js`:
    - `SEAT_LIMIT`, `escapeHtml(value)`
    - `seatInfo(org, fromType, ownSeat = false) → { left, full, label }`
    - `pickerOptions(orgs, { kind, fromType, selectedIds, ownSeatIds }) → [{ value, text, hint, disabled }]`
    - `buildPayload({ fromType, name, email, phone, website, rows }) → payload`
    - `orderRows(rows) → rows` (suppliers first)
  - `public/js/api.js`: `api(path, { method, body }) → data`. On failure it throws `Error` with `.code`, `.status` and `.data`. A network failure gives `code: 'NETWORK'`.
  - `public/js/registration-form.js`: `mountRegistrationForm(container, { orgs, initial?, submitLabel?, onSubmit, reloadOrgs? }) → { destroy() }`. Task 13 reuses it for admin edits. `initial` is a `DashboardData` participant (Task 8 shape).

- [ ] **Step 1: Write the failing test** `tests/unit/form-logic.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, escapeHtml, orderRows, pickerOptions, seatInfo } from '../../public/shared/form-logic.js';

const factory = (id, seats_used, name = `Factory ${id}`) => ({ id, kind: 'factory', name, seats_used });
const supplier = (id, seats_used, name = `Supplier ${id}`) => ({ id, kind: 'supplier', name, seats_used });

test('escapeHtml escapes the five HTML-special characters and handles null', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('seatInfo shows hints only for the side the person is from', () => {
  assert.deepEqual(seatInfo(factory(1, 0), null), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(factory(1, 0), 'supplier'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(factory(1, 0), 'factory'), { left: 2, full: false, label: '· 2 seats left' });
  assert.deepEqual(seatInfo(factory(1, 1), 'factory'), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(factory(1, 2), 'factory'), { left: 0, full: true, label: '(full)' });
  assert.deepEqual(seatInfo(factory(1, 3), 'factory'), { left: 0, full: true, label: '(full)' });
});

test('seatInfo ignores the edited person\'s own seat', () => {
  assert.deepEqual(seatInfo(factory(1, 2), 'factory', true), { left: 1, full: false, label: '· 1 seat left' });
});

test('pickerOptions filters by kind, hides selected ones and disables full ones', () => {
  const orgs = [supplier(1, 2), factory(2, 2), factory(3, 0), factory(4, 1)];
  assert.deepEqual(
    pickerOptions(orgs, { kind: 'factory', fromType: 'factory', selectedIds: new Set([4]) }),
    [
      { value: '2', text: 'Factory 2', hint: '(full)', disabled: true },
      { value: '3', text: 'Factory 3', hint: '· 2 seats left', disabled: false },
    ],
  );
  assert.deepEqual(
    pickerOptions(orgs, { kind: 'supplier', fromType: 'factory' }),
    [{ value: '1', text: 'Supplier 1', hint: '', disabled: false }],
  );
  assert.equal(
    pickerOptions(orgs, { kind: 'factory', fromType: 'factory', ownSeatIds: new Set([2]) })[0].disabled,
    false,
  );
});

test('buildPayload turns rows into listed and new organisation entries', () => {
  assert.deepEqual(buildPayload({
    fromType: 'factory', name: 'N', email: 'e', phone: 'p', website: '',
    rows: [
      { key: 1, kind: 'supplier', org_id: 7, name: 'Padma', code: 'S' },
      { key: 2, kind: 'factory', other_name: 'Rainbow', code: 'F' },
    ],
  }), {
    from_type: 'factory', name: 'N', email: 'e', phone: 'p', website: '',
    orgs: [
      { kind: 'supplier', org_id: 7, code: 'S' },
      { kind: 'factory', other_name: 'Rainbow', code: 'F' },
    ],
  });
});

test('orderRows puts suppliers before factories and keeps order within each kind', () => {
  const rows = [
    { key: 1, kind: 'factory' }, { key: 2, kind: 'supplier' }, { key: 3, kind: 'factory' }, { key: 4, kind: 'supplier' },
  ];
  assert.deepEqual(orderRows(rows).map((r) => r.key), [2, 4, 1, 3]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/form-logic.test.js`
Expected: FAIL with `Cannot find module` for `public/shared/form-logic.js`.

- [ ] **Step 3: Implement `public/shared/form-logic.js`**

```js
// Pure helpers for the registration form. No DOM access, so they can be unit tested in Node.
export const SEAT_LIMIT = 2;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ownSeat: the person being edited already holds a seat here, so don't count it against them.
export function seatInfo(org, fromType, ownSeat = false) {
  if (!fromType || org.kind !== fromType) return { left: null, full: false, label: '' };
  const used = org.seats_used - (ownSeat ? 1 : 0);
  const left = Math.max(0, SEAT_LIMIT - used);
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

export function buildPayload({ fromType, name, email, phone, website = '', rows }) {
  return {
    from_type: fromType,
    name,
    email,
    phone,
    website,
    orgs: rows.map((r) => (r.org_id != null
      ? { kind: r.kind, org_id: r.org_id, code: r.code }
      : { kind: r.kind, other_name: r.other_name, code: r.code })),
  };
}

export function orderRows(rows) {
  return [...rows.filter((r) => r.kind === 'supplier'), ...rows.filter((r) => r.kind === 'factory')];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/form-logic.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Create `public/js/api.js`**

```js
// fetch wrapper: returns parsed JSON, or throws an Error carrying the API's { error, message }.
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Network error. Check your connection and try again.'), { code: 'NETWORK', status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || 'Something went wrong, please try again.'), {
      code: data.error || 'INTERNAL',
      status: res.status,
      data,
    });
  }
  return data;
}
```

- [ ] **Step 6: Create `public/js/registration-form.js`**

```js
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
  function showFieldErrors(fields) {
    const ordered = orderRows(state.rows);
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
    const payload = buildPayload({
      fromType: state.fromType,
      name: field('name').value,
      email: field('email').value,
      phone: field('phone').value,
      website: field('website').value,
      rows: orderRows(state.rows),
    });
    const result = validateRegistration(payload);
    if (!result.ok) {
      showFieldErrors(result.fields);
      showAlert('Please check the highlighted fields.');
      return;
    }
    submitButton.disabled = true;
    try {
      await onSubmit(payload);
    } catch (err) {
      showAlert(err.message);
      if (err.data?.fields) showFieldErrors(err.data.fields);
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
```

- [ ] **Step 7: Create `public/js/register.js`**

```js
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
```

- [ ] **Step 8: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Registration</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/css/tom-select.default.min.css">
  <link rel="stylesheet" href="/styles.css">
  <script src="https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/js/tom-select.complete.min.js" defer></script>
  <script type="module" src="/js/register.js"></script>
</head>
<body>
  <main class="page">
    <header class="page-header">
      <h1 id="event-title">Registration</h1>
      <p class="muted">Fields marked <span class="req">*</span> are required. Each supplier and each factory can register up to 2 people.</p>
    </header>
    <div id="app" class="card"><p class="muted">Loading…</p></div>
  </main>
</body>
</html>
```

The deferred classic script and the module script run in document order after parsing, so `window.TomSelect` exists before `register.js` runs.

- [ ] **Step 9: Create `public/styles.css`**

```css
:root {
  --bg: #f5f6f8;
  --card: #ffffff;
  --text: #1d2330;
  --muted: #5f6b7a;
  --border: #d6dbe3;
  --primary: #0b5cad;
  --danger: #b42318;
  --danger-bg: #fdecea;
  --warn: #8a5a00;
  --warn-bg: #fff4d6;
  --ok: #1a7f37;
  --ok-bg: #e6f4ea;
  --radius: 8px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
}

* { box-sizing: border-box; }
body { margin: 0; line-height: 1.45; background: var(--bg); }

.page { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
.page-header h1 { margin: 0 0 4px; font-size: 1.6rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.muted { color: var(--muted); }
.req { color: var(--danger); }

.field { margin: 0 0 18px; border: 0; padding: 0; min-width: 0; }
.field > label, .field > legend { display: block; font-weight: 600; margin-bottom: 6px; padding: 0; }
input:not([type]), input[type="email"], input[type="tel"], input[type="password"], input[type="search"] {
  width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; font: inherit; background: #fff;
}
input:focus-visible, button:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.radios { display: flex; gap: 20px; flex-wrap: wrap; }
.radios label { display: flex; gap: 6px; align-items: center; }

.field-error { color: var(--danger); font-size: 0.9rem; margin: 4px 0 0; }
.field-error:empty { display: none; }
.alert { background: var(--danger-bg); color: var(--danger); border-radius: 6px; padding: 10px 12px; margin: 0 0 16px; }

.org-rows { list-style: none; margin: 8px 0 0; padding: 0; }
.org-row {
  display: grid; grid-template-columns: 1fr 150px auto; gap: 8px; align-items: center;
  padding: 8px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px;
}
.org-row.is-full { border-color: var(--warn); background: var(--warn-bg); }
.org-row .field-error { grid-column: 1 / -1; }
.org-name { overflow-wrap: anywhere; }
.warn-text { color: var(--warn); }
.picker-option small { color: var(--muted); }
.ts-dropdown .option.disabled { opacity: 0.55; }
.no-results { padding: 6px 8px; color: var(--muted); }

.btn {
  display: inline-block; padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--card); color: var(--text); font: inherit; cursor: pointer; text-decoration: none;
}
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.small { padding: 4px 8px; font-size: 0.85rem; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.icon-btn { border: 0; background: transparent; font-size: 1rem; cursor: pointer; padding: 6px 8px; color: var(--muted); }
.link-btn { border: 0; background: transparent; color: var(--primary); cursor: pointer; padding: 6px 0; font: inherit; }
.link-btn:disabled { color: var(--muted); cursor: not-allowed; }

/* Honeypot: off-screen for people, still present for bots. */
.hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }

.confirmation:focus { outline: none; }
.confirmation dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
.confirmation dt { color: var(--muted); }
.confirmation dd { margin: 0; overflow-wrap: anywhere; }

@media (max-width: 560px) {
  .card { padding: 14px; }
  .org-row { grid-template-columns: 1fr auto; }
  .org-row > .org-name, .org-row > [data-field="other_name"] { grid-column: 1; grid-row: 1; }
  .org-row > .icon-btn { grid-column: 2; grid-row: 1; }
  .org-row > [data-field="code"] { grid-column: 1 / -1; grid-row: 2; }
}
```

- [ ] **Step 10: Create `.claude/launch.json`** for the browser preview

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }
  ]
}
```

- [ ] **Step 11: Check the page manually in a browser**

`.env` must point at the test project (Task 7), and the list must be imported (Task 11). Start the `dev` preview, open `http://localhost:3000/`, then confirm each item:

1. The heading shows `Test Event`, and the browser console has no errors.
2. Submitting the empty form shows errors for from, suppliers, factories, name, email and phone, plus the top alert.
3. Choose **Factory**, type `aspire` in the factory picker. `Aspire Garments Ltd PJT (24040) · 2 seats left` appears. Pick it: a row with a Code box appears and the option leaves the picker.
4. Pick a supplier. The supplier options show no seat hints.
5. Click **+ Not in the list? Add a new factory**, type `Rainbow Knit Ltd`, and fill in all codes, name, email and phone. Submit: the confirmation lists both factories with codes.
6. Click **Register another person** and register 1 more **Factory** person with Aspire. On the next form, after choosing **Factory**, Aspire shows `(full)` and can't be picked.
7. Switch **Factory** to **Supplier**: Aspire becomes pickable again, without hints.
8. Using the same email in different letter case shows the duplicate-email message, and the form keeps its values.
9. At a 375px-wide viewport there is no horizontal scrolling, and each org row puts its code box on its own line.
10. The `Website` honeypot field is not visible.

Any failure found here is a bug. Fix it with a test where the logic lives in `form-logic.js`, then re-check.

- [ ] **Step 12: Run the unit tests and commit**

Run: `npm run test:unit`
Expected: PASS.

```bash
git add public/shared/form-logic.js public/js/api.js public/js/registration-form.js public/js/register.js public/index.html public/styles.css .claude/launch.json tests/unit/form-logic.test.js
git commit -m "feat: add public registration page" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 13: Admin dashboard page

**Files:**
- Create: `public/shared/admin-filters.js`, `public/admin.html`, `public/js/admin.js`
- Modify: `public/styles.css` (append admin styles)
- Test: `tests/unit/admin-filters.test.js`, plus a manual browser check

**Interfaces:**
- Consumes:
  - From Task 12: `api` and `mountRegistrationForm`, plus `escapeHtml` from `/shared/form-logic.js`.
  - From Tasks 9–10: the admin endpoints.
  - From Task 8: the `DashboardData` shape.
- Produces:
  - `filterParticipants(participants, { search = '', side = 'all' }) → participants`. Search covers name, email, phone and organisation names, case-insensitive.
  - `filterOrganisations(orgRows, { kind, search = '', status = 'all' }) → orgRows`. Search covers the organisation name and people's names.
  - `filterPending(orgRows, { search = '' }) → orgRows`. Search covers the name.
  - The page at `/admin` (`public/admin.html`, served through `cleanUrls` on Vercel and `extensions: ['html']` locally).

- [ ] **Step 1: Write the failing test** `tests/unit/admin-filters.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOrganisations, filterParticipants, filterPending } from '../../public/shared/admin-filters.js';
import { buildDashboard } from '../../src/services/dashboard.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });
const names = (list) => list.map((x) => x.name);

test('filterParticipants by side', () => {
  assert.deepEqual(names(filterParticipants(data.participants, { side: 'supplier' })), ['Salma Begum']);
  assert.equal(filterParticipants(data.participants, {}).length, 3);
});

test('filterParticipants searches name, email, phone and organisation names, ignoring case', () => {
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'KARIM' })), ['Karim Ahmed']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'salma@' })), ['Salma Begum']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: '000001' })), ['Rahim Uddin']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'rainbow' })), ['Rahim Uddin']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'aspire', side: 'factory' })), ['Rahim Uddin', 'Karim Ahmed']);
});

test('filterOrganisations by kind, status and search over name and people', () => {
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier' })), ['New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier', status: 'missing' })), ['New Supplier Co', 'Pearl Global']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'factory', status: 'full' })), ['Aspire Garments (24040)']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier', search: 'salma' })), ['Padma Textiles Ltd']);
});

test('filterPending searches by name', () => {
  assert.equal(filterPending(data.pending, { search: 'RAIN' }).length, 1);
  assert.equal(filterPending(data.pending, { search: 'zzz' }).length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/admin-filters.test.js`
Expected: FAIL with `Cannot find module` for `public/shared/admin-filters.js`.

- [ ] **Step 3: Implement `public/shared/admin-filters.js`**

```js
// Pure search/filter helpers for the admin dashboard tables.
const norm = (value) => String(value ?? '').toLowerCase();
const matches = (query, values) => !query || values.some((value) => norm(value).includes(query));

export function filterParticipants(participants, { search = '', side = 'all' } = {}) {
  const query = norm(search).trim();
  return participants.filter((p) =>
    (side === 'all' || p.from_type === side)
    && matches(query, [p.name, p.email, p.phone, ...p.suppliers.map((o) => o.name), ...p.factories.map((o) => o.name)]));
}

export function filterOrganisations(organisations, { kind, search = '', status = 'all' }) {
  const query = norm(search).trim();
  return organisations.filter((o) =>
    o.kind === kind
    && (status === 'all' || o.reg_status === status)
    && matches(query, [o.name, ...o.people.map((p) => p.name)]));
}

export function filterPending(pending, { search = '' } = {}) {
  const query = norm(search).trim();
  return pending.filter((o) => matches(query, [o.name]));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/admin-filters.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Create `public/admin.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Admin – Registrations</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/css/tom-select.default.min.css">
  <link rel="stylesheet" href="/styles.css">
  <script src="https://cdn.jsdelivr.net/npm/tom-select@2.6.2/dist/js/tom-select.complete.min.js" defer></script>
  <script type="module" src="/js/admin.js"></script>
</head>
<body>
  <main class="page wide">
    <section id="login" class="card narrow" hidden>
      <h1>Admin login</h1>
      <form id="login-form">
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p class="alert" id="login-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">Log in</button>
      </form>
    </section>

    <section id="dashboard" hidden>
      <header class="toolbar">
        <h1>Registrations</h1>
        <div class="toolbar-actions">
          <span class="muted" id="updated-at"></span>
          <button class="btn" type="button" id="refresh">Refresh</button>
          <button class="btn primary" type="button" id="export">Export to Excel</button>
          <button class="btn" type="button" id="logout">Logout</button>
        </div>
      </header>
      <p class="alert" id="dash-error" role="alert" hidden></p>
      <div class="tiles" id="tiles"></div>
      <nav class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="participants">Participants</button>
        <button type="button" role="tab" data-tab="supplier">Suppliers</button>
        <button type="button" role="tab" data-tab="factory">Factories</button>
        <button type="button" role="tab" data-tab="pending">Pending new orgs</button>
      </nav>
      <div class="filters">
        <input type="search" id="search" placeholder="Search…" aria-label="Search">
        <div class="chips" id="chips"></div>
      </div>
      <div class="table-wrap" id="table"></div>
    </section>
  </main>
  <dialog id="modal"><div id="modal-body"></div></dialog>
</body>
</html>
```

- [ ] **Step 6: Append admin styles to `public/styles.css`**

```css
/* ---------- Admin ---------- */
.page.wide { max-width: 1280px; }
.card.narrow { max-width: 380px; margin: 48px auto; }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.toolbar h1 { margin: 0; font-size: 1.5rem; }
.toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.tile-label { color: var(--muted); font-size: 0.9rem; }
.tile-value { font-size: 1.8rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile-sub { color: var(--muted); font-size: 0.85rem; }

.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.tabs button { border: 0; background: transparent; padding: 8px 12px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.tabs button[aria-selected="true"] { border-bottom-color: var(--primary); color: var(--primary); font-weight: 600; }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.filters input[type="search"] { max-width: 320px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--border); background: var(--card); border-radius: 999px; padding: 4px 12px; font: inherit; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--primary); border-color: var(--primary); color: #fff; }

.table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { background: #f0f2f5; position: sticky; top: 0; }
td code { background: #f0f2f5; padding: 0 4px; border-radius: 4px; }
.empty { padding: 16px; margin: 0; }
.row-actions { white-space: nowrap; }

.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
.badge.missing { background: var(--danger-bg); color: var(--danger); }
.badge.registered { background: var(--ok-bg); color: var(--ok); }
.badge.full, .badge.over { background: var(--warn-bg); color: var(--warn); }
.badge.new, .badge.pending { background: #e8f0fb; color: var(--primary); }

dialog { border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; width: min(720px, calc(100vw - 32px)); max-height: 90vh; overflow: auto; }
dialog::backdrop { background: rgb(0 0 0 / 0.4); }
.modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.modal-head h2 { margin: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
```

- [ ] **Step 7: Create `public/js/admin.js`**

```js
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
  });
  modalCleanup = () => picker.destroy();

  const merge = async (allowOverLimit) => {
    const targetId = Number(picker.getValue());
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
        $('#merge-anyway').addEventListener('click', () => merge(true));
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
```

Note: the first `refresh()` gets 401 when there is no session, so `guarded` shows the login screen.

- [ ] **Step 8: Check the dashboard manually in a browser**

Use the test project with the imported list plus the registrations from Task 12. Start the `dev` preview, open `http://localhost:3000/admin`, then confirm each item:

1. The login screen appears. A wrong password shows `Wrong password.` after about 1 second. The value in `.env` logs in.
2. The tiles show `Participants` with supplier/factory counts, `Suppliers n/61`, `Factories n/129` and `Pending approvals`, matching the Task 12 registrations.
3. **Participants** tab: search `aspire` narrows the rows, and the side chips filter them. The pending Rainbow Knit link shows a `pending` badge.
4. **Factories** tab: the `Full` chip shows Aspire as `2/2 Full`, and `Missing` lists untouched factories.
5. **Edit** a participant: the dialog shows the pre-filled form. Change the phone and save. The dialog closes and the table shows the new phone. Trying to add a full factory shows it as `(full)` in the picker.
6. **Delete** a participant: the dialog names the organisations whose seats are freed. After confirming, the seat counts drop.
7. **Pending new orgs**: **Merge into…** Aspire (already 2/2) shows the `MERGE_OVER_LIMIT` message with **Merge anyway**. **Cancel**, then **Approve** another pending organisation instead. It disappears from Pending and appears in Factories with a `New` tag.
8. **Export to Excel** downloads `registrations-YYYY-MM-DD-HHmm.xlsx`. Opened in Excel, it has the 7 sheets with frozen, filterable headers, and the numbers match the tiles.
9. **Logout** returns to login. Reloading `/admin` still shows login.
10. At 375px width the page has no horizontal page scroll. Tables scroll inside their box.

- [ ] **Step 9: Run all tests and commit**

Run: `npm test`
Expected: PASS (unit, API and DB tests).

```bash
git add public/shared/admin-filters.js public/admin.html public/js/admin.js public/styles.css tests/unit/admin-filters.test.js
git commit -m "feat: add admin dashboard page" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

### Task 14: README and production deployment

**Files:**
- Create: `README.md`
- No application code changes.

**Interfaces:**
- Consumes: everything above.
- Produces: a live Vercel URL backed by a production Supabase project holding the imported list.

Several steps below create accounts, projects or public URLs. Those steps are outward-facing: **ask the user before each one** and do not enter passwords or keys into web forms for them. The user pastes secrets into the Supabase and Vercel dashboards themselves.

- [ ] **Step 1: Write `README.md`**

````markdown
# Primark Event Registration

Public registration form (max 2 people per supplier / factory per side) and an admin dashboard with Excel export.
Design: `docs/superpowers/specs/2026-09-17-event-registration-design.md`.

## Stack
Express 5 on Vercel (`server.js`), plain HTML/JS in `public/`, Supabase Postgres (`supabase/migrations/`).

## Environment variables
| Name | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (server only) |
| `ADMIN_PASSWORD` | Shared admin password |
| `SESSION_SECRET` | 32+ random characters for signing the admin cookie |
| `EVENT_TITLE` | Title shown on the form |

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Local development
```bash
npm install
cp .env.example .env      # fill in values (use the TEST project locally)
npm run dev               # http://localhost:3000 and http://localhost:3000/admin
```

## Tests
```bash
npm run test:unit         # no database needed
npm test                  # everything; needs .env.test pointing at the TEST project (data is wiped)
```

## Database
Apply `supabase/migrations/001_schema.sql`, `002_register.sql`, `003_admin_functions.sql` in order
(Supabase SQL Editor or the Supabase CLI/MCP).

## Import the supplier/factory list
Sheet `Assignments` with headers `Supplier` and `Factory` in A1:B1. Safe to re-run.
```bash
node --env-file=.env.production scripts/import-orgs.js "path/to/Assignments.xlsx"
```

## Deploy
Import the GitHub repo into Vercel (Express is detected automatically), add the environment variables, deploy.
`vercel.json` pins the function region to `sin1` and serves `/admin` from `public/admin.html`.
````

- [ ] **Step 2: Commit the README**

```bash
git add README.md
git commit -m "docs: add README with setup, test and deploy steps" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Push to a private GitHub repository (ask first)**

Ask the user for the repository name and owner, and for approval to create it. Then:
```bash
gh repo create <owner>/primark-event-registration --private --source . --push
```
Expected: the repo exists with `main` pushed. Check that no `.env*` file except the two examples was committed:
```bash
git ls-files | grep -E '^\.env'
```
Expected output: exactly `.env.example` and `.env.test.example`.

- [ ] **Step 4: Create and migrate the production Supabase project (ask first)**

The user creates, or approves creating, a project named `primark-event-registration` in `ap-southeast-1`. Apply `001_schema.sql`, `002_register.sql` and `003_admin_functions.sql` **in that order**, using the SQL Editor or MCP `apply_migration` against the **production** project id.

Then run the Supabase security advisor (MCP `get_advisors` with `type: "security"`, or Dashboard → Advisors).
Expected: no "RLS disabled" and no "function search_path mutable" findings for these objects. Fix any finding with a new migration file (`004_…sql`) before continuing.

- [ ] **Step 5: Import the real list into production**

The user fills `.env.production` locally (git-ignored by `.env.*`) with the production URL and secret key, plus placeholder values for `ADMIN_PASSWORD`, `SESSION_SECRET` and `EVENT_TITLE`. `loadConfig` requires all five, and `SESSION_SECRET` must still be at least 32 characters. The import script only uses the Supabase values.

If the user supplied full names for the 3 cut-off factories (spec §13), they edit the Excel first.
```bash
node --env-file=.env.production scripts/import-orgs.js "C:/Users/Shoaib/Downloads/Assignments (3).xlsx"
```
Expected: `Read 61 suppliers and 129 factories; inserted 190 new organisations (0 already existed).`

- [ ] **Step 6: Deploy on Vercel (the user does this in the Vercel dashboard)**

1. **Add New → Project** → import the GitHub repo. The framework preset should read **Express**.
2. Add Production environment variables:
   - `SUPABASE_URL` and `SUPABASE_SECRET_KEY` for the production project.
   - A strong `ADMIN_PASSWORD`.
   - `SESSION_SECRET` from the README command.
   - The real `EVENT_TITLE`.
3. Deploy. In the deployment's **Functions** tab, confirm the region is `sin1`.

- [ ] **Step 7: Smoke-test the live deployment**

Replace `<url>` with the deployment URL:
```bash
curl -s "https://<url>/api/organisations" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(d.event_title, d.organisations.length)})"
curl -s -o /dev/null -w "%{http_code}\n" "https://<url>/api/admin/data"
curl -s -o /dev/null -w "%{http_code}\n" "https://<url>/admin"
```
Expected: `<EVENT_TITLE> 190`, then `401`, then `200`.

Then in the browser:
1. `https://<url>/`: register `Smoke Test` / `smoke-test@example.com`, with one supplier and one factory.
2. `https://<url>/admin`: log in and check that Participants = 1.
3. **Export to Excel**: the file opens with 7 sheets.
4. Delete `Smoke Test` so production starts empty. Participants = 0.

- [ ] **Step 8: Report to the user**

Give the user:
- the live URLs (`/` and `/admin`)
- where to change `EVENT_TITLE` and `ADMIN_PASSWORD` (Vercel → Settings → Environment Variables, then redeploy)
- the open items from spec §13 that are still unresolved
