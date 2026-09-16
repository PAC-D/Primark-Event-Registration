# Primark Event Registration: Design

Date: 2026-09-17
Status: Approved in brainstorming, awaiting spec review

## 1. Goal

A public registration form for a Primark supplier and factory event, plus a password-protected admin dashboard. Each supplier and each factory may send at most **2 people**. Admins track who has registered, which organisations are missing, approve new organisations typed in by attendees, and export everything to Excel.

## 2. Decisions

| Topic | Decision |
|---|---|
| Seat limit | Per organisation the attendee is **from**. A "from supplier" attendee uses a seat at each supplier they select; a "from factory" attendee uses a seat at each factory they select. Selections on the other side are recorded but use no seats. |
| Multi-select | Suppliers and factories are both multi-select, with at least 1 of each required. A person selecting 3 factories as "from factory" uses 1 seat at each of the 3 factories but counts as **1 participant**. |
| Codes | Supplier and factory are chosen from dropdowns built from the Excel list. The attendee **types the code** for every selected organisation. Codes are stored per selection and not checked against any list. |
| "Other" organisations | An attendee can type a new organisation name. It is saved as **pending** and hidden from dropdowns until an admin **approves** it or **merges** it into an existing organisation. |
| Admin login | One shared password (`ADMIN_PASSWORD`) held only on the server. |
| Changes and cancellations | Admins edit or delete registrations on the dashboard. Attendees cannot edit their own registration. |
| Stack | Express API plus plain HTML/CSS/JS pages (no build step) on **Vercel**, with **Supabase Postgres**. |
| Export | The admin panel exports all dashboard data (summary, participants, status tables, missing, pending) to one .xlsx file. |
| Testing DB | A separate free Supabase project used only for automated tests. |

## 3. Out of scope

- Confirmation or reminder emails
- Attendee self-service edit or cancel
- Live-updating dashboard (it refreshes on load or on the Refresh button)
- Multiple events or sessions
- Individual admin accounts or roles
- Opening and closing registration from the UI

## 4. Source data

`Assignments (3).xlsx`, sheet `Assignments`, has two independent columns (`Supplier`, `Factory`) with no pairing between them.

- 61 suppliers, all unique, with no codes.
- 129 factories, all unique. Most end with a code in brackets, e.g. `Aspire Garments Ltd PJT (24040)`.
- 3 factory names are cut off at 50 characters with no code: `Far East Knitting & Dyeing Industries Ltd PJT (115`, `Dhaka Garments & Washing Ltd PKA HAMS Washing & Dy`, `Comfit Composite Knit Ltd PKA Comfit Lingerie Limi`. They are imported exactly as written unless full names are provided.
- Names are imported **exactly as written**; the bracketed code stays part of the displayed name.
- The `match_key` rule (section 5.2) produces no collisions within either list. This was checked against the file.

## 5. Data model

### 5.1 Tables

```sql
organisations
  id          bigint generated always as identity primary key
  kind        text not null check (kind in ('supplier','factory'))
  name        text not null
  match_key   text generated always as (make_match_key(name)) stored
  source      text not null check (source in ('list','attendee'))
  status      text not null check (status in ('approved','pending'))
  created_at  timestamptz not null default now()
  unique (kind, match_key)

attendees
  id          uuid primary key default gen_random_uuid()
  name        text not null
  email       text not null            -- stored trimmed
  phone       text not null
  from_type   text not null check (from_type in ('supplier','factory'))
  created_at  timestamptz not null default now()
  updated_at  timestamptz not null default now()
  unique index on lower(email)

attendee_orgs
  attendee_id uuid   not null references attendees(id) on delete cascade
  org_id      bigint not null references organisations(id)
  code        text   not null
  primary key (attendee_id, org_id)
  index on (org_id)
```

Row-level security is **enabled on all three tables with no policies**, so the public `anon` role has no access. Only the server, using the Supabase secret key, reads and writes.

### 5.2 match_key

This rule is used to match "Other" names and to deduplicate imports:

1. Lower-case the name.
2. Replace `&` with ` and `.
3. Replace every character other than `a–z`, `0–9` and space with a space.
4. Split into words and drop the words `ltd` and `limited`.
5. Join the remaining words with single spaces.

Examples: `Hop Lun (H.K.) LTD.` → `hop lun h k`; `Modele De Capital Ind Ltd (Unit 2) (26088)` → `modele de capital ind unit 2 26088`.

The rule is implemented once, as the `IMMUTABLE` SQL function `make_match_key(text)`. `organisations.match_key` is a stored generated column built from it, so no application code ever computes the key. The database functions call `make_match_key` to look up typed names.

### 5.3 Seat rule

- **Seats used** at organisation O = the number of attendees linked to O whose `from_type` equals `O.kind`.
- A registration or edit is rejected if any organisation it would charge (selected, and of `kind = from_type`) already has 2 seats used, not counting the attendee being edited.
- **Participants** = the number of rows in `attendees`.

### 5.4 View: `org_status`

One row per organisation: `id, kind, name, source, status, seats_used, linked_count`, where `linked_count` counts links from either side.

## 6. Database functions (plpgsql)

Each function runs in a single transaction. Errors are raised with `RAISE EXCEPTION` using a fixed message prefix, which the API maps to responses (section 9).

### 6.1 `register_attendee(p jsonb) returns uuid`

Payload:
```json
{
  "name": "...", "email": "...", "phone": "...", "from_type": "factory",
  "orgs": [
    { "kind": "supplier", "org_id": 12, "code": "S-001" },
    { "kind": "factory",  "other_name": "Rainbow Knit Ltd", "code": "30001" }
  ]
}
```

Steps:
1. Check the payload again (enum values, at least 1 supplier and 1 factory, at most 10 of each, codes present). Errors: `VALIDATION`.
2. Resolve each entry to an org id:
   - `org_id` must exist with `status = 'approved'` and matching `kind`. Otherwise: `ORG_NOT_FOUND`.
   - `other_name`: compute `make_match_key`. If an organisation with that `(kind, match_key)` exists, whether approved or pending, use it. Otherwise `INSERT ... ON CONFLICT (kind, match_key) DO NOTHING` a new `source='attendee', status='pending'` row and select it. This is safe when two people type the same name at the same time.
3. Remove duplicate resolved org ids. If the same org appears twice, the first entry's code is kept.
4. Charged orgs = resolved orgs with `kind = from_type`. Lock them with `SELECT ... FROM organisations WHERE id = ANY(...) ORDER BY id FOR UPDATE`. The fixed order prevents deadlocks.
5. Count seats used for each charged org. If any count is 2 or more, raise `SEAT_FULL` with the list of full organisation names.
6. Insert the attendee. A unique violation on email is raised as `DUPLICATE_EMAIL`.
7. Insert the `attendee_orgs` rows and return the attendee id.

If any step fails, the whole transaction rolls back, **including any pending organisations created in step 2**.

### 6.2 `update_attendee(p_id uuid, p jsonb) returns void`

Uses the same payload and steps as `register_attendee`, with these differences:
- Raises `NOT_FOUND` if the attendee does not exist.
- `org_id` may point to an **approved or pending** organisation, because admins are trusted and a person may still be linked to a pending one.
- The seat count leaves out `p_id`'s own links.
- It updates the attendee row (`updated_at = now()`), then replaces all of that person's `attendee_orgs` rows.
- Afterwards it deletes any **pending** organisation that has no links left.

### 6.3 `delete_attendee(p_id uuid) returns void`

Deletes the attendee. Their links are removed automatically. It then deletes any pending organisation left with no links. Raises `NOT_FOUND` if the attendee does not exist.

### 6.4 `approve_org(p_id bigint) returns void`

Sets `status = 'approved'`. Raises `NOT_FOUND` if the organisation does not exist or is not pending.

### 6.5 `merge_org(p_source bigint, p_target bigint, p_allow_over_limit boolean) returns int`

1. If the source does not exist or is not pending, raise `NOT_FOUND`. If the target does not exist, is not approved, or has a different `kind`, raise `VALIDATION`.
2. Lock the target row.
3. Work out the target's seats used after the merge, counting distinct attendees of the matching side across the source and target links.
4. If that number is over 2 and `p_allow_over_limit` is false, raise `MERGE_OVER_LIMIT` with the projected count.
5. Move the source's links to the target. If a person is already linked to the target, keep the target link and drop the source link.
6. Delete the source and return the target's new seats used.

## 7. Registration form (`/`)

### 7.1 Fields, in this order

1. **You are attending from** *(required)*: Supplier / Factory.
2. **Supplier(s)** *(required, 1–10)*: a searchable picker of approved suppliers. A **"+ Not in the list? Add a new supplier"** button sits below it. (It is a button rather than a last dropdown option because the picker's search would hide such an option.)
3. **Factory(ies)** *(required, 1–10)*: the same, for factories.
4. **Attendee name** *(required)*, **Email** *(required)*, **Phone** *(required)*.
5. A hidden honeypot field named `website`.

Each selected organisation appears as a row with its name, a required **Code** box and a ✕ remove button. "Other" rows have a required **Name** box instead of a fixed name.

### 7.2 Seat hints

- The dropdown for the side matching the chosen "from" option shows `· N seat(s) left`. Organisations with 0 seats left are disabled and labelled `(full)`.
- The other side's dropdown shows every organisation with no hints.
- Changing the "from" option refreshes the hints. Any already-selected organisation that is now full is highlighted with a warning.
- Until a "from" option is chosen, both dropdowns are shown without hints.

### 7.3 Validation rules (`public/shared/validate.js`, used by browser and server)

| Field | Rule |
|---|---|
| from_type | `supplier` or `factory` |
| name | trimmed, 2–100 characters |
| email | trimmed, at most 254 characters, matches `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| phone | only digits, spaces, `+`, `-`, `(`, `)`; contains 7–15 digits |
| code | trimmed, 1–30 characters |
| other_name | trimmed, 2–150 characters |
| suppliers / factories | 1–10 entries each; each entry has exactly one of `org_id` or `other_name` |

### 7.4 Submit flow

1. The browser runs `validate()`. Any errors are shown next to the relevant fields.
2. `POST /api/register`.
3. **201:** the form is replaced by a confirmation summary (name, side, organisations with codes). No email is sent.
4. **Error:** everything the person typed stays in the form, and the message from section 9 is shown at the top. On `SEAT_FULL`, the seat hints reload.
5. If the honeypot is filled, the server returns 201 without saving anything.

### 7.5 Page setup

- A single column that works at phone width.
- Tom Select, pinned version, loaded from jsDelivr, for the searchable multi-selects.
- The event title comes from `GET /api/organisations`, which reads it from `EVENT_TITLE`.

## 8. Admin dashboard (`/admin`)

### 8.1 Login

- `POST /api/admin/login { password }`. The server hashes the given password and `ADMIN_PASSWORD` with SHA-256 and compares them with `crypto.timingSafeEqual`.
- **Success:** set the cookie `admin_session = <expiryUnixSeconds>.<hmacSha256(expiry, SESSION_SECRET)>`, with `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, plus `Secure` in production.
- **Failure:** wait 1 second, then return 401.
- `POST /api/admin/logout` clears the cookie. It needs no valid session, so an expired session can always log out.
- Every other `/api/admin/*` route checks the signature and expiry and returns 401 if either fails. `SameSite=Strict` protects against cross-site request forgery.

### 8.2 Top bar

Buttons: **Refresh**, **Export to Excel**, **Logout**.

Summary tiles:
- **Participants:** total, split into from supplier and from factory.
- **Suppliers:** registered / total, where both counts cover only organisations from the Excel list (`source='list'`). Also shows missing and full counts.
- **Factories:** the same as Suppliers.
- **Pending approvals:** the number of pending organisations.

### 8.3 Definitions

- **Registered:** an approved organisation with `linked_count ≥ 1`.
- **Missing:** an approved organisation with `linked_count = 0`.
- **Full:** `seats_used ≥ 2`. A count above 2, which only a merge can cause, is shown as `3/2` with an over-limit badge.
- An approved organisation that came from an attendee (`source='attendee'`) shows a **New** tag.

### 8.4 Tabs

- **Participants:** name, email, phone, from, suppliers with codes, factories with codes, registered at.
  - Free-text search across names, emails, phones and organisation names. Filter by side.
  - **Edit** opens a window with the registration form pre-filled; pending organisations the person is linked to are shown as-is. Saving calls `PUT`.
  - **Delete** asks for confirmation, naming the organisations that will get seats back, then calls `DELETE`.
- **Suppliers / Factories:** name, New tag, seats used (`n/2`), linked people, status badge (Missing / Registered / Full). Search box and filter chips: All · Missing · Registered · Full.
- **Pending new orgs:** kind, typed name, linked people with the codes they typed, created at.
  - **Approve**.
  - **Merge into…** opens a searchable picker of approved organisations of the same kind. If the server responds `MERGE_OVER_LIMIT`, a confirmation dialog shows the projected count and asks "Merge anyway?", then the request is resent with `allow_over_limit: true`.

### 8.5 Data loading

`GET /api/admin/data` returns `{ summary, participants, organisations, pending }` in one response. Search, filtering and tab switching all happen in the browser. After any change (edit, delete, approve, merge) the page fetches `/data` again.

### 8.6 Export

`GET /api/admin/export` returns `registrations-YYYY-MM-DD-HHmm.xlsx`. The time is in Asia/Dhaka. The file always contains **all** data, whatever filters are on screen. It is built from the same `services/dashboard.js` output as `/data`.

| Sheet | Columns / contents |
|---|---|
| Summary | Label / value rows for every top-bar number, plus the export time |
| Participants | Name, Email, Phone, From, Suppliers, Supplier codes, Factories, Factory codes, Registered at. Multiple values are joined with `; ` |
| Participant-Orgs | Name, Email, Phone, From, Org kind, Org name, Code, Uses seat (Y/N), Org status |
| Suppliers | Name, Source, Status (approved/pending), Seats used, Linked count, Registration status, People |
| Factories | Same columns as Suppliers |
| Missing | Kind, Name |
| Pending | Kind, Name, People, Codes typed, Created at |

Every sheet has a bold header row, the header frozen, filters turned on, and column widths set.

## 9. API

| Method & path | Auth | Purpose |
|---|---|---|
| GET `/api/organisations` | none | `{ event_title, organisations: [{id, kind, name, seats_used}] }`, approved organisations only |
| POST `/api/register` | none | Body as in 6.1 plus a top-level `website` honeypot field. Returns 201 `{ id }` |
| POST `/api/admin/login` | none | Section 8.1 |
| POST `/api/admin/logout` | none | Clears the session |
| GET `/api/admin/data` | cookie | Section 8.5 |
| PUT `/api/admin/participants/:id` | cookie | Body as in 6.1 |
| DELETE `/api/admin/participants/:id` | cookie | Deletes a participant |
| POST `/api/admin/organisations/:id/approve` | cookie | Approves a pending organisation |
| POST `/api/admin/organisations/:id/merge` | cookie | `{ target_id, allow_over_limit }` |
| GET `/api/admin/export` | cookie | .xlsx download |

Errors always return `{ error, message }`:

| error | HTTP | message shown |
|---|---|---|
| VALIDATION | 400 | a message for each invalid field (`fields: {name: "..."}`) |
| UNAUTHORISED | 401 | "Please log in again." |
| NOT_FOUND / ORG_NOT_FOUND | 404 | "That record no longer exists. Refresh and try again." |
| SEAT_FULL | 409 | "Already full (2 <side> attendees): <org names>. Remove them or contact the event team." |
| DUPLICATE_EMAIL | 409 | "This email is already registered. Contact the event team to change it." |
| MERGE_OVER_LIMIT | 409 | "<Target> would have <n> <side> attendees (limit 2). Merge anyway?" |
| DB_UNAVAILABLE | 503 | "Service is busy, please try again in a moment." |
| INTERNAL | 500 | "Something went wrong, please try again." |

Unexpected errors are logged in full with `console.error`, which appears in the Vercel logs. Database details are never sent to the client.

## 10. Project structure

```
server.js                  Vercel zero-config Express entry: builds the app and default-exports it;
                           when not on Vercel it also serves public/ and listens on PORT || 3000
src/
  create-app.js            express.json, cookie parsing, routes, error handler
  config.js                read and check env vars; fail fast if any are missing
  db.js                    Supabase client (secret key) + callRpc/runQuery helpers that throw AppErrors
  auth.js                  sign/verify session cookie, requireAdmin middleware
  errors.js                AppError, DB error → AppError mapping, Express error handler
  routes/public.js
  routes/admin.js
  services/dashboard.js    build { summary, participants, organisations, pending }
  services/export.js       ExcelJS workbook from dashboard data
  services/import.js       read the Excel list, insert organisations
public/
  index.html               registration page
  admin.html               admin dashboard, served at /admin via cleanUrls
  styles.css
  js/api.js  js/registration-form.js  js/register.js  js/admin.js
  shared/validate.js       ES module, no dependencies, used by browser and server
  shared/form-logic.js     seat hints, picker options, payload building, HTML escaping
  shared/admin-filters.js  dashboard search and filters
supabase/migrations/
  001_schema.sql           tables, indexes, RLS, make_match_key, org_status view
  002_register.sql         private schema, prepare_registration, register_attendee
  003_admin_functions.sql  update/delete_attendee, approve_org, merge_org
scripts/import-orgs.js     command-line wrapper around services/import.js
tests/unit  tests/api  tests/db  tests/helpers
vercel.json                region sin1, cleanUrls
.env.example  .env.test.example  .gitignore  package.json ("type": "module")
```

Vercel serves `public/` from its CDN (`express.static` is ignored there) and runs `server.js` as one function.

Dependencies: `express`, `@supabase/supabase-js`, `exceljs`, `cookie-parser`, and `supertest` for tests. Env files are loaded with Node's `--env-file` flag, so `dotenv` is not needed.

Environment variables: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_PASSWORD`, `SESSION_SECRET` (at least 32 characters), `EVENT_TITLE`.

## 11. Deployment

1. Create the Supabase production project in `ap-southeast-1` (Singapore). Apply `001`, `002` and `003` in order.
2. Run `npm run import-orgs -- "<path to xlsx>"`. It is safe to re-run.
3. Push to GitHub, import into Vercel, set the environment variables. The function region is `sin1`.
4. Smoke-test on the live URL (section 12.5).

## 12. Testing

Tests use Node's built-in test runner (`node --test`) and are written test-first. Tests that need a database use the **test Supabase project**, configured in `.env.test`. That project has the same migrations applied, and every test wipes the tables before it runs.

### 12.1 Database functions
- A "from factory" person with 3 factories uses 1 seat at each; the participant count goes up by 1.
- A supplier-side person's factory picks use no factory seats.
- The 3rd person from the same side at the same organisation gets `SEAT_FULL` naming that organisation.
- **5 registrations fired in parallel for 1 remaining seat: exactly 1 succeeds.**
- The same email in different letter case gets `DUPLICATE_EMAIL`.
- `other_name` matching an approved organisation's match_key links to that organisation, and no pending one is created.
- `other_name` matching a pending organisation reuses it, and its seat limit applies.
- A registration that fails leaves no new pending organisation behind.
- Picking the same organisation twice (by id and via "Other") creates one link.
- `update_attendee` doesn't count the person's own seats; switching `from_type` re-checks the other side.
- `delete_attendee` frees seats and removes pending organisations left with no links.
- `merge_org` removes duplicate links, returns `MERGE_OVER_LIMIT` unless allowed, and deletes the source.
- `approve_org` makes the organisation appear in `GET /api/organisations`.

### 12.2 Validation
Unit tests for every rule in 7.3, covering valid and invalid values at each boundary.

### 12.3 API (supertest)
- Admin routes return 401 without a cookie, or with a tampered or expired one.
- Login succeeds with the right password and fails with a wrong one.
- Each database error prefix maps to the status code and body in section 9.
- A filled honeypot returns 201 and saves nothing.

### 12.4 Export
Build a workbook from seeded data, read it back with ExcelJS, and check the sheet names, header rows and row counts.

### 12.5 Manual checklist before going live
- Register at phone width, including an "Other" organisation.
- Watch the seat hints change between supplier and factory.
- On the dashboard: edit, delete, approve and merge (including the over-limit warning).
- Open the exported file in Excel.

## 13. Open items (not blocking implementation)

- Event title and date text for `EVENT_TITLE`.
- Full names for the 3 cut-off factories.
- Project location: it currently sits inside OneDrive. `node_modules` is git-ignored, but OneDrive will still sync it unless it is excluded or the project moves, e.g. to `C:\dev\`.
