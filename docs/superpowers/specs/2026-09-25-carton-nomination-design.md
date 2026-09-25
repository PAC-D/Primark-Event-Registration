# Carton Nomination Program Update: Design

Date: 2026-09-25
Status: Approved in brainstorming (questions answered 2026-09-25)
Supersedes event details and seat rules in `2026-09-17-event-registration-design.md` where they conflict.

## 1. Goal

Rebrand the registration app for the **Primark Carton Nomination Program** — subtitle **Bangladesh Origin**, **Nov 04, 2026, 9:00 AM – 3:30 PM (GMT+6)**, Face-to-Face — and change how attendees identify themselves:

- Seat limits become per kind: **supplier 2, factory 1**, charged only on the attending-from side (unchanged seat model).
- Supplier/factory **codes come from the data**, never typed by the attendee and never shown in the form.
- New attending-from option **"Other"** (no seats, no org links): organisation picked from a fixed dropdown of 10 names, with a final `Other` choice that reveals a free-text input.
- Attendee info gains **designation** (required) and **photo** (optional, JPG/PNG, ≤ 1 MB), stored and shown to admins only.
- Registration form groups attendee fields into their own **sub-card**; the "+ Not in the list" flow is **removed** — anyone not in the lists registers as Other.
- The blue header band is removed; the header blends into the page background.

Production is pre-launch (no real registrations yet), so the lists may be refreshed wholesale.

## 2. Decisions (from Q&A 2026-09-25)

| Topic | Decision |
|---|---|
| Selection rule | The side matching "attending from" requires ≥ 1 selection; the other side is optional (0–10). Every supplier/factory registration is therefore charged to ≥ 1 seat, so limits always hold. |
| Photo storage | **Private** Supabase Storage bucket `attendee-photos`, all access through the server with the service key. Admins view photos via an Express proxy route. No anon key, no storage policies, no public URLs. |
| Upload flow | Browser posts the file to `POST /api/photos` first; the registration JSON carries only the returned `photo_path`. An abandoned upload leaves a harmless orphan object. |
| "Not in the list" orgs | **Removed** from the form. Unlisted attendees use "Other". Pending-org admin tooling (approve/merge) stays for existing data. |
| Lists source of truth | `scripts/data/suppliers.psv` and `scripts/data/factories.psv` (pipe-delimited `code|name` — names contain commas, so CSV would need quoting) committed to the repo; the import script reads them (the old xlsx flow is retired). |
| Event details | Header shows title (H1), subtitle (from `EVENT_TITLE`), and a hardcoded details line: `Nov 04, 2026 · 9:00 AM – 3:30 PM (GMT+6) · Face-to-Face`. |
| Photos in Excel | Not embedded; Participants sheet gets a `Photo (Y/N)` column. |
| Client-side compression | Not done (spec caps at 1 MB with a clear error message). Optional follow-up. |

## 3. Data model — migration `005_carton_nomination.sql`

```sql
organisations
  + code  text                      -- from the new lists; null for legacy/attendee-sourced rows

attendees
  + designation        text not null default ''   -- see note
  + organisation_name  text          -- set only when from_type = 'other'
  + photo_path         text          -- storage object path in bucket attendee-photos
  from_type check extended to ('supplier','factory','other')
```

`designation` is mandatory for **new** registrations (enforced in the payload validator and `prepare_registration`). Add it as `default ''` then tighten-related validation in code, so existing rows don't break the migration. Admin edits require it too.

Bucket (created idempotently in the migration):

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attendee-photos', 'attendee-photos', false, 1048576, '{image/jpeg,image/png}')
on conflict (id) do nothing;
```

Only `service_role` ever touches the bucket, so no storage RLS policies are needed.

### Seat rule (revised)

`SEAT_LIMITS = { supplier: 2, factory: 1 }` in `public/shared/constants.js`; DB functions hardcode the same two numbers (comment in constants.js still says "change both together"). `org_status.seats_used` is unchanged (count of links where `from_type = kind`); "full" is evaluated per kind everywhere it's used.

## 4. Database functions (rewritten in 005)

`private.prepare_registration(p jsonb, p_exclude_attendee uuid, p_allow_pending boolean)`:

1. `from_type` must be `supplier|factory|other`.
2. `name`, `email`, `phone`, `designation` non-empty → else `VALIDATION`.
3. `from_type = 'other'`: `orgs` must be an empty array, `organisation_name` 2–150 required; no seat checks, returns `[]`.
4. Otherwise: `orgs` array of `{kind, org_id}` only. Require 1–10 entries of the from-kind and 0–10 of the other kind; every `org_id` must exist with matching `kind` (`approved`, or pending when `p_allow_pending` — admin edits only).
5. **Code is resolved from `organisations.code`** (never from the payload); falls back to `''` for code-less legacy orgs.
6. Dedup org ids, lock from-kind orgs in id order (`FOR NO KEY UPDATE`), seat check against the per-kind limit → `SEAT_FULL` with `{side, orgs}`.

`register_attendee`, `update_attendee` write `designation`, `organisation_name` (null unless other), `from_type`, and `photo_path`. The DB functions additionally check `photo_path` against the shape `/api/photos` produces (`^[0-9a-f-]{36}\.(jpg|png)$`) and raise `VALIDATION` otherwise; real type/size enforcement lives in the `/api/photos` route and the bucket settings.

`merge_org`: over-limit threshold = limit of the target's kind.

`register_attendee` / `update_attendee` reject a malformed `photo_path` with `VALIDATION` (only values produced by `/api/photos` should ever match). Old photos are cleaned up in the **route** layer (storage is outside the DB transaction): on update/delete the route reads the previous `photo_path` first, then best-effort removes the object afterwards; failures are logged, never fatal.

## 5. Lists & import

- `scripts/data/suppliers.psv` (80 rows) and `scripts/data/factories.psv` (168 rows), one `code|name` per line, names exactly as provided. Pipe-delimited because several names contain commas.
- `src/services/import.js` → `readOrganisationLists(dir)` parses both files; `importOrganisations(db, orgs)` upserts on `(kind, match_key)` setting `name` and `code`, then deletes `source='list'` rows absent from the files **that have no attendee links** (guard even pre-launch).
- `scripts/import-orgs.js` keeps its name/entry point; file path argument becomes optional (defaults to the repo's `scripts/data`).
- Migration 005 contains **no org data** — deploy steps: apply 005, run `npm run import-orgs`.

## 6. API

| Route | Change |
|---|---|
| `POST /api/photos` | **New, public.** `express.raw` with type allowlist `image/jpeg`\|`image/png` and `limit: '1mb'`; magic-byte check (`FF D8 FF` / `89 50 4E 47`); uploads via service key to `attendee-photos/<uuid>.<ext>`; returns `{ path }`. Failures: `VALIDATION` (type/size) or `DB_UNAVAILABLE`. |
| `POST /api/register` | Payload becomes `{ from_type, name, designation, email, phone, photo_path?, organisation_name?, orgs: [{kind, org_id}] }`. Honeypot unchanged. |
| `PUT /api/admin/participants/:id` | Same payload; on success, deletes any replaced/removed photo object (best effort). |
| `DELETE /api/admin/participants/:id` | After delete, best-effort removes the photo object. |
| `GET /api/admin/participants/:id/photo` | **New.** Streams the image from the private bucket with its stored content type; 404 if none. |
| `GET /api/organisations` | Unchanged (codes intentionally not exposed to the public page). |

`validate.js` (shared) rules:

| Field | Rule |
|---|---|
| from_type | `supplier`, `factory` or `other` |
| name | 2–100 (unchanged) |
| designation | 2–100 |
| email, phone | unchanged |
| photo_path | optional; must match UUID+`.jpg`/`.png` |
| organisation_name | required 2–150 iff `from_type = 'other'` |
| orgs | from-kind: 1–10 of `{kind, org_id}`; other kind: 0–10; `other` from_type: must be empty |

Messages for `SEAT_FULL`/`MERGE_OVER_LIMIT` include the kind's limit: "Already full (factory limit 1): …".

## 7. Frontend

`public/shared/constants.js` gains:

```js
export const SEAT_LIMITS = { supplier: 2, factory: 1 };
export const ORGANISATION_OPTIONS = [ 'Primark Limited', 'Associated British Foods',
  'Maersk Bangladesh', 'WAC - Bangladesh', 'Uniglory Packaging Industries Limited',
  'Reflex Packaging Ltd.', 'Union Label and Accessories Limited', 'Epyllion Limited',
  'Youngshine Packtrims Limited', 'Other' ];
export const PHOTO_MAX_BYTES = 1024 * 1024;
```

`SEAT_LIMIT` is removed (all callers move to `SEAT_LIMITS`).

`registration-form.js` (shared by public form and admin edit dialog):

- Three from-options. For `supplier`/`factory` both pickers stay visible, with the from-side required (≥ 1) and the other side optional (0–10). Selecting `other` hides both pickers and shows the **Organization Name** dropdown (Tom Select) fed by `ORGANISATION_OPTIONS`; choosing `Other` in it reveals a free-text input.
- Selected org rows show name + seat hint only — **no code input** (code attached server-side).
- "Attendee information" sub-card (`.sub-card` inset panel): Name, **Designation** (required), Email, Phone, **Photo** (optional).
- Photo flow: on file selection the client checks type (`image/jpeg`/`image/png`) and size (≤ 1 MB) and shows *"Please choose a JPG or PNG image under 1 MB."*; valid files upload immediately to `/api/photos`, then a thumbnail preview (with a remove button) is shown and `photo_path` goes into the submit payload. Admin edit shows the existing photo (via the proxy route) with replace/remove.
- Confirmation lists name, designation, from, and the selected organisation **names only** — codes are never sent to the public page, so the confirmation drops the per-org codes it used to show. For `other`, the organisation name is shown instead.

`form-logic.js`: `buildPayload` drops codes/other_name, adds `designation`, `photo_path`, `organisation_name`; `pickerOptions`/`seatInfo` use `SEAT_LIMITS`.

`index.html` / `admin.html` headers: H1 = "Primark Carton Nomination Program", subtitle = `EVENT_TITLE` ("Bangladesh Origin" in env examples — **update the deployed env var**), details line "Nov 04, 2026 · 9:00 AM – 3:30 PM (GMT+6) · Face-to-Face". Intro copy: "Each supplier can register up to 2 people, each factory 1 person." `<title>` and `theme-color` (`#eaf1fb`) updated.

**Header un-banding** (`styles.css`): `.brand-band` loses its gradient and becomes transparent (page gradient/blobs show through — no band, border or color break); text flips from white to `--navy`/`--ink`; `.page` overlap (`-64px`) replaced with normal flow margin; mobile rules adjusted.

## 8. Admin dashboard & export

- Participants: columns/cards gain Designation, Organisation (other attendees), photo thumbnail (click → full image in new tab via proxy). Side filter chips gain `Other`.
- Seat displays parameterised (`n/2` suppliers, `n/1` factories); `registrationStatus({kind})` uses `SEAT_LIMITS`; summary gains `participants.other`; charts treat `other` as a third segment.
- Export (`services/export.js`): Participants sheet columns `Designation`, `Organisation (other)`, `Photo (Y/N)`; Summary gains "Participants from other orgs"; `SIDE` map gains `other`.

## 9. Tests

- **Unit:** validate.js new rules & boundaries; form-logic per-kind seat hints; photo magic-byte helper; constants sanity (10 org options, codes non-empty in CSVs — data test); export/dashboard builders incl. `other` and per-kind "full".
- **API (supertest + fake db):** `/api/photos` accepts JPEG/PNG ≤ 1 MB, rejects wrong type, > 1 MB, spoofed content-type; register/update validation incl. other-flow; photo route 401 → admin 200; replaced-photo cleanup call.
- **DB (needs 005 applied to the test project):** seat limits 2 vs 1 incl. concurrency; from-kind requirement; server-side code resolution (payload code ignored); other-flow persists `organisation_name`; designation required by `prepare_registration`; per-kind merge limit; import round-trip from the CSVs.
- **Import unit tests** switch to CSV fixtures.

## 10. Rollout

1. Apply `005_carton_nomination.sql` to the **test** project; run the full suite.
2. Apply 005 to production, run `npm run import-orgs -- <dir>` (defaults to `scripts/data`).
3. Update `EVENT_TITLE=Bangladesh Origin` in Vercel (Production + Preview); deploy.
4. Smoke-test: register from supplier, factory (2nd factory person must fail), and Other; check the admin dashboard photo thumbnail and the Excel export.
5. Add a Vercel Firewall rate limit for `POST /api/photos` (e.g. 10/min/IP) alongside the existing `/api/register` rule — the endpoint is public, so this caps junk-photo uploads.

## 11. Out of scope / follow-ups

- Client-side image compression (revisit if 1 MB proves tight for phone photos).
- No emails, no attendee self-service, no embedded photos in Excel.
