# Primark Carton Nomination Program — Registration

Public registration form (max 2 people per supplier, 1 per factory, per attending-from side) and an admin dashboard with Excel export.
Design: `docs/superpowers/specs/2026-09-17-event-registration-design.md`, updated by `2026-09-25-carton-nomination-design.md`.

## Stack
Express 5 on a Node host (Amazon Lightsail, Ubuntu) via `server.js`, plain HTML/JS in `public/`, Supabase Postgres + Storage (`supabase/migrations/`).

## Environment variables
| Name | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (server only) |
| `ADMIN_PASSWORD` | Shared admin password |
| `SESSION_SECRET` | 32+ random characters for signing the admin cookie |
| `EVENT_TITLE` | Subtitle shown under the event title (set to `Bangladesh Origin`) |
| `POWER_AUTOMATE_WEBHOOK_URL` | Optional. Power Automate HTTP trigger URL for attendee confirmation emails (see below). Empty = no emails. |

## Email confirmations (optional)

Set `POWER_AUTOMATE_WEBHOOK_URL` to a Power Automate **"When an HTTP request is received"** trigger URL and every
successful registration posts a JSON payload to it. Build the flow to send the confirmation email with Outlook's
**"Send an email (V2)"** action:

- To: `email` · Subject: e.g. `You're registered — Primark Carton Nomination Program`
- Body fields available: `name`, `email`, `phone`, `designation`, `from_type` (supplier/factory/other),
  `organisation_name` (set for Other), `organisations` (array of selected supplier/factory names),
  `event_name`, `event_subtitle`, `event_date`, `event_time`.

Notes:
- The send is **best effort**: if the webhook is down or slow the registration still succeeds (6 s timeout, warning in the log).
- The HTTP trigger is a Premium connector — the flow owner needs a Power Automate Premium licence.
- Leave the variable empty to disable emails entirely (default).

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
Apply `supabase/migrations/001_schema.sql`, `002_register.sql`, `003_admin_functions.sql`, `004_hardening.sql`, `005_carton_nomination.sql` in order
(Supabase SQL Editor or the Supabase CLI/MCP).
Put any future database change in a new numbered migration file (`006_...sql`); never edit a migration that has already been applied.
Migration `005` also creates the private `attendee-photos` storage bucket (1 MB, JPEG/PNG only) — only the server's secret key can touch it.

## Import the supplier/factory lists
The canonical lists live in the repo: `scripts/data/suppliers.psv` and `scripts/data/factories.psv`,
pipe-delimited `code|name` lines (names contain commas, so not CSV). Edit those files, then re-run — it is safe.
```bash
node --env-file=.env.production scripts/import-orgs.js            # defaults to scripts/data
node --env-file=.env.production scripts/import-orgs.js "dir"      # or a custom directory
```
The import inserts new organisations, refreshes the codes of existing list organisations, and prunes
list organisations that left the files unless an attendee is still linked to them.
`.env.production` must contain all five environment variables (the config loader requires them), although the
import only uses the Supabase values.

## Deploy (Amazon Lightsail, Ubuntu)

1. Install Node 24 (NodeSource or nvm), clone the repo, `npm ci`.
2. `cp .env.example .env`, fill in the values against the **production** Supabase project.
3. Apply all migrations (see Database below) and run `npm run import-orgs`.
4. Run the server as a systemd unit (`/etc/systemd/system/primark-registration.service`):

```ini
[Unit]
Description=Primark Carton Nomination registration
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

`systemctl enable --now primark-registration`. The process serves everything (API + `public/`) on port 3000.

5. Put nginx in front for HTTPS (`certbot --nginx`) and rate-limit the public endpoints:

```nginx
limit_req_zone $binary_remote_addr zone=register:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=photos:10m  rate=10r/m;
limit_req_zone $binary_remote_addr zone=admin:10m   rate=10r/m;

server {
  location /api/register     { limit_req zone=register burst=10 nodelay; proxy_pass http://127.0.0.1:3000; }
  location /api/photos       { limit_req zone=photos   burst=5  nodelay; proxy_pass http://127.0.0.1:3000; }
  location /api/admin/login  { limit_req zone=admin     burst=3  nodelay; proxy_pass http://127.0.0.1:3000; }
  location /                  { proxy_pass http://127.0.0.1:3000; }
}
```

Notes:
- Photos uploaded through `/api/photos` but never submitted with a registration are deleted by a background sweeper in the server process (every 15 minutes, after 2 hours) — no cron job needed.
- Free Supabase projects pause after a period of inactivity. Keep the production project active (or on a paid plan) for the whole registration period.

### Before sharing the link
- Use a long random `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env` (HTTPS via nginx makes the admin cookie `Secure`).
- While registration is open, check the dashboard daily and delete obvious spam.
