# Primark Event Registration

Registration and administration software for the Primark Carton Nomination Program. The current application collects attendee details, enforces supplier/factory seat limits, stores optional photos, provides an admin dashboard, and exports registration data to Excel.

This document covers two distinct states:

- **Current system** — functionality implemented in this repository.
- **Planned check-in system** — identity cards, QR verification, daily attendance, and offline operation. This functionality is not implemented yet.

## Current status

### Implemented

- Public registration for supplier, factory, and other attendees.
- Maximum two attendees charged to each supplier and one to each factory.
- Required contact details and designation; optional JPEG/PNG photo up to 1 MiB.
- Duplicate-email prevention and transactional seat enforcement.
- Admin dashboard, charts, filters, editing, deletion, and Excel export.
- Pending organisation approval and merge operations.
- Optional confirmation email through a Power Automate webhook.
- Canonical supplier/factory import.
- Maintenance mode and abandoned-photo cleanup.
- Unit, API, and database tests.

### Not implemented

- Event/event-day database records.
- Printable identity cards or QR credentials.
- Check-in and per-day attendance.
- Scanner-specific permissions.
- Offline roster, scanning, or synchronization.
- Installable Progressive Web App.

## Architecture

The application is an API-driven modular monolith. This remains the recommended architecture for attendance work; microservices are unnecessary.

```text
Public registration page ─┐
Admin dashboard ──────────┼──► Node.js 24 / Express 5 ───► Supabase PostgreSQL
Future scanner PWA ───────┘                └─────────────► Supabase Storage
```

Express is the only Supabase client. The browser never receives the secret key. PostgreSQL functions handle multi-step registration and admin changes transactionally.

| Layer | Technology |
|---|---|
| Runtime/API | Node.js 24, Express 5 |
| Frontend | Plain HTML, CSS, JavaScript modules |
| Database/storage | Supabase PostgreSQL and private Storage |
| Database client | `@supabase/supabase-js` |
| Export | ExcelJS |
| Tests | Node test runner, Supertest |
| Optional email | Power Automate webhook |

There is no frontend build step. Current pages load some libraries/fonts from CDNs; the future offline scanner must bundle every runtime asset locally.

## Repository structure

```text
public/
  index.html                 Public registration
  admin.html                 Admin dashboard
  maintenance.html           Maintenance page
  styles.css                 Shared styles
  brand/                     Logos and icons
  js/                        Page controllers, forms, charts, API helper
  shared/                    Validation, constants, filters, form/chart logic
src/
  create-app.js              Express composition and error boundary
  config.js                  Environment validation
  db.js                      Supabase/query helpers
  auth.js                    Admin cookie signing/verification
  errors.js                  Stable API error mapping
  routes/                    Public, photo, and admin endpoints
  services/                  Dashboard, export, import, notification, photos
supabase/migrations/         Ordered migrations 001–005
scripts/
  import-orgs.js             Organisation import entry point
  data/*.psv                 Canonical supplier/factory data
tests/
  unit/                      Dependency-free/service tests
  api/                       Express endpoint tests
  db/                        Disposable-Supabase tests
  helpers/                   Fakes and fixtures
server.js                    Runtime entry point
Dockerfile
docker-compose.yml
```

## Current application flows

### Registration

1. Browser downloads the approved organisation catalogue.
2. Attendee completes contact, designation, type, and organisation fields.
3. An optional photo is uploaded first; the API checks MIME type, binary signature, and size.
4. Shared validation runs in browser and server.
5. Express calls `public.register_attendee`.
6. PostgreSQL validates organisations, locks affected rows, checks capacity, and inserts the attendee and links in one transaction.
7. API returns the attendee UUID.
8. Confirmation data is optionally sent to Power Automate. Notification failure never rolls back registration.

### Seat accounting

A relationship consumes a seat only when the attendee's `from_type` matches the organisation's `kind`.

| Attendee type | Requirement | Seat limit |
|---|---|---:|
| Supplier | At least one supplier | 2 per supplier |
| Factory | At least one factory | 1 per factory |
| Other | No supplier/factory links | None |

Organisation rows are locked in stable ID order before capacity checks, preventing concurrent requests from both taking the last seat.

### Admin

Authenticated administrators can view summaries, filter participants, edit/delete attendees, view private photos, approve/merge organisations, and export Excel data.

### Photos

- Private bucket: `attendee-photos`.
- JPEG/PNG only, maximum 1 MiB.
- Random UUID object names.
- Unattached uploads are removed after two hours by the standalone Node worker.
- Replaced/deleted photos are removed on a best-effort basis after database success.
- The cleanup worker does not run when `VERCEL` is set.

## Current database model

```text
organisations 1 ─────< attendee_orgs >───── 1 attendees
```

### `public.organisations`

Supplier/factory catalogue: bigint identity `id`, `kind`, display `name`, normalized generated `match_key`, source-list `code`, `source`, `status`, and timestamp.

### `public.attendees`

Current event attendee/registration: UUID `id`, name, email, phone, designation, `from_type`, optional other `organisation_name`, optional `photo_path`, and timestamps.

Email is globally unique today. This suits one event but must become event-scoped before recurring events are supported.

### `public.attendee_orgs`

Many-to-many attendee/organisation links. `(attendee_id, org_id)` is the primary key; `code` snapshots the organisation code at registration time.

### `public.org_status`

Security-invoker view calculating seat use and link count.

### Permissions and migrations

RLS is enabled. `anon` and `authenticated` have no application-table access; only `service_role` receives table/RPC permissions.

Apply migrations numerically. Never edit an applied migration. Every database change must use a new migration, beginning with `006_...sql`.

## Current HTTP API

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/organisations` | Approved catalogue and full-seat registrants |
| `POST` | `/api/photos` | Upload validated JPEG/PNG |
| `POST` | `/api/register` | Validate and register attendee |

For full organisations, the public catalogue exposes only registrant name/designation by design.

### Authentication and admin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/login` | Start signed admin session |
| `POST` | `/api/admin/logout` | Clear session |
| `GET` | `/api/admin/data` | Dashboard data |
| `GET` | `/api/admin/export` | Excel export |
| `GET` | `/api/admin/participants/:id/photo` | Private photo |
| `PUT` | `/api/admin/participants/:id` | Update participant |
| `DELETE` | `/api/admin/participants/:id` | Delete participant |
| `POST` | `/api/admin/organisations/:id/approve` | Approve pending organisation |
| `POST` | `/api/admin/organisations/:id/merge` | Merge pending organisation |

Admin cookies are HTTP-only, `SameSite=Strict`, valid for 12 hours, and `Secure` in production.

## Configuration

Copy `.env.example` to `.env`.

| Variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Server-only secret key |
| `ADMIN_PASSWORD` | Yes | Shared admin password |
| `SESSION_SECRET` | Yes | At least 32 characters; signs cookies |
| `EVENT_TITLE` | Yes | Interface event subtitle |
| `MAINTENANCE_MODE` | No | `true/1/yes/on` enables maintenance |
| `POWER_AUTOMATE_WEBHOOK_URL` | No | Confirmation webhook |
| `PORT` | No | HTTP port; default 3000 |
| `NODE_ENV` | No | Set to `production` behind HTTPS |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The current event configuration is fragmented: subtitle comes from `EVENT_TITLE`; notification name/date/time are constants in `src/services/notify.js`; timezone is in `public/shared/constants.js`. Planned event tables will replace these scattered values.

Never commit `.env`, secret keys, webhook URLs, database exports, or attendee data.

## Local development

Requirements: Node.js 24, a development Supabase project, and migrations `001–005`.

```bash
npm install
cp .env.example .env
# Fill in .env
npm run dev
```

- Registration: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`
- Maintenance: `http://localhost:3000/maintenance`

```bash
npm run dev
npm start
npm run test:unit
npm test
npm run import-orgs
npm run backup
```

## Recovery backups

`npm run backup` creates a timestamped directory under `backups/` containing:

- `database.sql` with the ordered migrations, application rows, and identity-sequence repair.
- Every object from the private `attendee-photos` bucket, preserving its object path.
- `manifest.json` with the source host, migration list, row counts, object count, sizes, and SHA-256 hashes.
- `checksums.sha256` for verifying the complete bundle after copying it elsewhere.

The command fails if an attendee references a photo that is absent from Storage. Backup directories and legacy `db-*.sql` exports are ignored by Git and Docker. They still contain personal data and are not encrypted; move completed bundles to encrypted storage outside the repository.

```bash
npm run backup
npm run backup:verify -- "backups/backup-2026-10-13T12-00-00Z"
```

Restore only into a new, empty Supabase project:

1. Verify the bundle with `npm run backup:verify -- "path/to/backup"`.
2. Run `database.sql` in the new project's SQL editor.
3. Point `.env` at the new project and run `npm run restore:storage -- "path/to/backup"`.
4. Compare database row counts and Storage object count with `manifest.json`.
5. Run the registration, admin, photo, edit, delete, and export smoke tests.

Storage restore refuses to target the source Supabase hostname and does not overwrite existing objects. This is deliberate: an object collision means the target is not empty or the restore has already been partially attempted and should be inspected before continuing.

## Testing

```bash
npm run test:unit
```

Full suite:

```bash
npm test
```

The full suite requires `.env.test` pointing only at a disposable test Supabase project with `ALLOW_DB_WIPE=yes`. Database tests can delete all application data. Never target production.

Tests cover validation, authentication, concurrent registration/capacity, database functions, admin operations, import/export, dashboard data, photos, cleanup, notifications, and maintenance mode.

## Organisation import

Canonical files are `scripts/data/suppliers.psv` and `scripts/data/factories.psv`, with `code|name` lines.

```bash
node --env-file=.env.production scripts/import-orgs.js
node --env-file=.env.production scripts/import-orgs.js "path/to/data"
```

The import inserts new list organisations, refreshes codes, preserves attendee-created pending rows, and removes stale list organisations only when no attendee links to them.

## Deployment

### Node/Linux

1. Install Node 24, clone, and run `npm ci`.
2. Create production `.env`.
3. Apply all migrations and import organisations.
4. Run behind HTTPS using systemd and nginx or equivalent.

```ini
[Unit]
Description=Primark Event Registration
After=network.target

[Service]
WorkingDirectory=/opt/primark-registration
ExecStart=/usr/bin/node --env-file=.env server.js
Environment=NODE_ENV=production
Restart=always
User=primark

[Install]
WantedBy=multi-user.target
```

Rate-limit registration, photo upload, and login. Keep the Supabase project active throughout registration/event operation.

### Docker

```bash
docker compose build
docker compose up -d
```

Compose exposes port 3000, loads `.env`, limits memory, and includes a health check. It omits production mode for plain-HTTP local use because browsers reject `Secure` cookies without HTTPS.

### Production checklist

- Dedicated production Supabase project.
- Strong random admin/session secrets.
- HTTPS and endpoint rate limits.
- Photo cleanup worker running.
- Registration/photo/export smoke tests completed.
- Database **and Storage** backups created and restore-tested.
- Backups kept encrypted outside Git.

## Security and privacy

Current protections include server-only Supabase access, RLS, transactions, dual validation, signed HTTP-only cookies, timing-safe password comparison, photo signature/size checks, private photo access, bounded bodies, and a bot honeypot.

Current limitations:

- One shared admin password instead of individual accounts.
- No separation between administrators and future scanner staff.
- Public full-organisation output includes attendee name/designation.
- Current UI uses external CDN assets and is not fully offline.
- SQL exports contain personal data in clear text.

The scanner must use a separate role/device session that cannot edit/delete registrations or export private data.

## Database backup review

`db-2026-10-12T23-04-33-720Z.sql` was reviewed on October 13, 2026.

### Finding

It is a genuine project-specific **logical SQL export**, not a standard full `pg_dump`. Its header says it was produced by the former `scripts/backup-db.js` on October 12, 2026. That exact legacy generator is absent; the repository now has replacement backup and verification tooling described above.

Evidence that it belongs to this project:

- Migrations `001–005` are embedded exactly after newline normalization.
- Expected tables, view, functions, permissions, and Storage bucket configuration exist.
- It exports 248 organisations, 94 attendees, and 149 attendee-organisation links.
- Schema and data are wrapped in one transaction.

The file contains production-like names, emails, telephone numbers, links, and photo paths. `db-*.sql` is now ignored by `.gitignore`; do not force-add it.

### Missing from the export

- Supabase Storage file content.
- Environment variables/secrets and webhook configuration.
- Host, nginx, and systemd configuration.
- Supabase platform-wide schemas/settings.
- The backup-generator script needed to reproduce the export.

Thirty-four attendee rows reference photos, but the image objects are absent. SQL-only restoration therefore leaves broken photo references. This application does not currently use Supabase Auth, so missing Auth users are not an application-data gap.

### Identity-sequence defect

The export inserts explicit organisation IDs `6263–6510` with `OVERRIDING SYSTEM VALUE` but never resets the identity sequence. Run after restoring data:

```sql
select setval(
  pg_get_serial_sequence('public.organisations', 'id'),
  (select max(id) from public.organisations),
  true
);
```

Without this, generated IDs start from the new project's initial sequence state. It may not fail immediately because restored IDs are high, but it is not a faithful/safe restoration.

### Verdict

| Question | Verdict |
|---|---|
| Is it from this application? | Yes |
| Application schema included? | Yes, migrations `001–005` exactly |
| Relational data included? | Yes |
| Usable on an empty Supabase project? | Mostly, after sequence correction |
| Complete production backup? | **No** |
| Photos restored? | **No** |
| Safe to commit? | **No** |

Call it a **database logical export**, not a complete disaster-recovery backup.

### Required complete backup

Store together, encrypted:

1. PostgreSQL application schema/data.
2. Correct identity-sequence state.
3. Every `attendee-photos` object with original path/type.
4. Manifest with source, generation time, row/object counts, and checksums.
5. Secure configuration backup stored separately from attendee SQL.
6. Documented, tested restore instructions.

### Restore procedure for this snapshot

Use a new empty Supabase project; the script is not safe for an existing populated project.

1. Run the SQL export.
2. Reset the organisation identity sequence using the SQL above.
3. Restore Storage files under their original paths.
4. Verify 248 organisations, 94 attendees, and 149 links.
5. Verify every non-null `photo_path` exists.
6. Configure application environment variables.
7. Test registration, admin login, photo access, edits, deletion, and export.
8. Create a new registration and verify future generated IDs.

A backup is reliable only after a separate-project restore rehearsal succeeds.

## Planned identity-card and attendance system

### Objective

For every confirmed registration:

1. Generate a printable identity card.
2. Place an opaque QR credential on it.
3. Verify registration validity for the selected event.
4. Record attendance once per selected event day.
5. Identify repeat scans clearly.
6. Continue during internet outages.
7. Synchronize safely afterward.

### Approach

Keep one Express service and one Supabase project. Add typed tables and modules for events, cards, credentials, check-in, and offline synchronization. Do not create microservices or a generic key/value settings system.

```text
Admin/card UI ─────────────┐
Online scanner ────────────┼──► Express API ───► PostgreSQL/Storage
Offline scanner PWA ───────┘        ▲
  ├─ cached application             │ sync
  ├─ IndexedDB roster               │
  └─ IndexedDB outbox ──────────────┘
```

## Planned database model

Recommended reusable structure:

```text
people ──< event_registrations >── events ──< event_days
                    │
                    ├──< registration_orgs >── organisations
                    ├── registration_credentials
                    └──< attendance >── event_days
```

### Core tables

```text
events
  id, name, subtitle, timezone, starts_at, ends_at
  status (draft/open/closed/archived), timestamps

event_days
  id, event_id, event_date, label
  check_in_opens_at, check_in_closes_at
  unique(event_id, event_date)

people
  id, name, email, phone, timestamps

event_registrations
  id, event_id, person_id, designation, from_type
  organisation_name, photo_path
  status (confirmed/cancelled/revoked), timestamps
  unique(event_id, person_id)

registration_credentials
  registration_id primary key
  token_hash unique, status (active/revoked)
  issued_at, rotated_at

attendance
  id, registration_id, event_day_id
  first_scanned_at, scanned_at_device, received_at
  device_id, scan_id unique, source (online/offline)
  unique(registration_id, event_day_id)
```

The unique attendance constraint is the authoritative duplicate guard. The scanner selects an `event_day_id`; do not determine the day solely from an offline device clock.

Existing attendees should be backfilled into people/registrations for the current event, and `attendee_orgs` into registration relationships. Verify counts before retiring old structures.

## QR credential design

Use a versioned opaque token:

```text
ER1.<base64url cryptographically-random value>
```

Requirements:

- At least 128 random bits.
- Encode no name, email, phone, organisation, or photo URL.
- Encode no API/Supabase secret.
- Store only `SHA-256(raw token)` in database/offline roster.
- Support revoke and rotate without changing registration ID.
- Print a short manual fallback code.

Do not use only the attendee UUID: it is permanent and cannot be independently rotated after a lost/copied card.

A printed QR can be copied. Online duplicate detection helps but does not prove identity; cards should show name/photo for visual comparison.

## Identity-card generation

Start with protected printable HTML rather than server PDF generation.

- Recommended size: `85.6mm × 54mm`.
- Support single-card and A4-grid print CSS.
- Include event, photo, name, designation, organisation, QR, fallback code.
- Exclude email/phone by default.
- Generate QR SVG locally with a bundled library; never send credentials to a public QR website.
- Browser print-to-PDF is sufficient initially. Add dedicated PDF generation only for a print-vendor requirement.

Suggested routes:

```text
GET  /admin/cards?event_id=...
GET  /api/admin/cards-data?event_id=...
POST /api/admin/registrations/:id/credential/rotate
```

## Online check-in flow

1. Staff signs in with scanner-only permission.
2. Select event/day.
3. Scan QR and submit credential, day, device ID, client `scan_id`, and device time.
4. Express hashes credential and calls one transactional database function.
5. Database validates credential/registration/event/day and inserts attendance.
6. API returns display details and a stable status.

| Status | Meaning |
|---|---|
| `CHECKED_IN` | Valid; attendance recorded now |
| `ALREADY_CHECKED_IN` | Valid; already attended that day |
| `INVALID` | Unknown credential |
| `REVOKED` | Credential/registration disabled |
| `WRONG_EVENT` | Registration belongs elsewhere |
| `OUTSIDE_CHECKIN_WINDOW` | Selected day is not open |

Database uniqueness—not browser state—prevents online duplicates.

## Offline check-in flow

Build an installable PWA:

- Service worker caches scanner HTML/CSS/JS/fonts/icons/QR library.
- IndexedDB stores a minimized roster and pending outbox.
- UI always shows connectivity, roster version/age, device ID, and unsynchronized count.

### Device preparation

While online: install/open scanner, authenticate, choose event/day, select **Prepare for offline use**, verify roster count/version/time, then test valid and invalid QRs in airplane mode.

Minimized roster:

```text
token_hash, registration_id, status
display name, designation, organisation
small photo thumbnail (optional)
event_id, event_day_id, roster_version
```

Avoid email/phone unless manual-search requirements justify them.

### Offline scan

1. Hash scanned credential locally.
2. Match the hash in IndexedDB.
3. Validate status/event/day and check local prior scans.
4. Show result immediately.
5. Save an outbox item with client-generated UUID `scan_id`, selected day, device time, and device ID.
6. Synchronize automatically on reconnect.

The sync API accepts bounded batches and is idempotent by `scan_id`. Each item becomes accepted, already checked in, rejected with reason, or retained for retry. Never silently discard rejected/unresolved records.

### Offline limitations

- A device only knows its downloaded snapshot; later revocation may appear valid.
- Independent offline phones cannot see one another's scans.
- A copied QR may be accepted at separate offline gates.
- Server constraints reconcile duplicates after sync but cannot undo physical entry.
- Clearing browser storage can remove the roster/outbox.
- A new device must download data before going offline.

For strict outage-time duplicate prevention, use one scanner or a local-LAN server on a laptop/Raspberry Pi. Multiple independent offline scanners provide resilience, not global real-time coordination.

## Planned API

Scanner users may download permitted rosters, verify/check in, sync, and perform limited search. They must not edit/delete registrations or export data.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/check-in/login` | Scanner session |
| `POST` | `/api/check-in/logout` | End session |
| `GET` | `/api/check-in/events` | Permitted events/days |
| `GET` | `/api/check-in/bootstrap` | Event/day/version configuration |
| `GET` | `/api/check-in/offline-roster` | Minimized offline dataset |
| `POST` | `/api/check-in/scan` | Online check-in |
| `POST` | `/api/check-in/sync` | Idempotent offline batch |
| `GET` | `/api/check-in/search` | Manual fallback |

Example request:

```json
{
  "credential": "ER1.example-opaque-value",
  "event_day_id": "6ad69e3a-33fc-4ca8-940d-acde76f22f40",
  "scan_id": "55dc641d-8b95-4856-a577-bc823a1344e9",
  "device_id": "gate-a-01",
  "scanned_at_device": "2026-11-04T09:13:22+06:00"
}
```

## Implementation roadmap

### Phase 0 — Recovery first

- Implemented: repeatable database and Storage backup tooling.
- Implemented: sequence repair, manifest, row/object counts, and SHA-256 checksums.
- Implemented: generated database exports and backup bundles are ignored by Git and Docker.
- Remaining operational step: rehearse a complete restore in a separate Supabase project.
- Rehearse restoration in a separate project.

Complete this before production schema changes.

### Phase 1 — Event-ready data

- Migration `006`: events, days, registrations, credentials, attendance.
- Backfill current event/attendees with count checks.
- Centralize event metadata.
- Add transactional credential/check-in functions and indexes.

### Phase 2 — Cards and online scanning (minimum useful release)

- Bundle QR library.
- Printable card UI and credential rotate/revoke.
- Scanner-only authentication.
- Camera scanner plus manual fallback.
- Online transaction and daily attendance dashboard/export.

### Phase 3 — Offline scanner

- Manifest, service worker, local assets.
- IndexedDB roster/outbox and versioning.
- Batch synchronization/conflict display.
- Airplane-mode, restart, reconnect, and multi-device testing.

### Phase 4 — Operational hardening

- Individual staff/device accounts and audit log.
- Lost-card workflow, monitoring, load test, full rehearsal.
- Incident, support, backup, and retention procedures.

Future options only when required: local LAN hub, native scanner, print-vendor PDF batches, multi-tenant ownership, or badge-printer integration.

## Acceptance criteria

### Cards

- One active credential per confirmed registration.
- No personal contact data encoded.
- Reissue invalidates old QR.
- Correct physical print size and reliable scanning.

### Online

- First valid scan records selected-day attendance.
- Repeat returns `ALREADY_CHECKED_IN` without another row.
- Same person can attend separate days once each.
- Invalid/revoked/cancelled/wrong-event codes fail.
- Concurrent scans cannot duplicate attendance.
- Scanner role cannot use admin mutations/exports.

### Offline

- Prepared device works after reload/restart in airplane mode.
- Valid, invalid, and local-repeat scans are distinguishable.
- Pending records survive restart.
- Reconnect processes each `scan_id` at most once.
- Conflicts/revocations remain visible for review.
- Roster age and unsynchronized count are always visible.

### Recovery

- Database and Storage restore successfully into a separate project.
- Row/object counts and checksums match a manifest.
- No backup/attendee data is committed.
- Event staff complete an airplane-mode rehearsal.

---

**Design rule:** the database is authoritative online; a versioned roster snapshot and idempotent outbox provide controlled continuity offline.
