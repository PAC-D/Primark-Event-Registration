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
Apply `supabase/migrations/001_schema.sql`, `002_register.sql`, `003_admin_functions.sql`, `004_hardening.sql` in order
(Supabase SQL Editor or the Supabase CLI/MCP).
Put any future database change in a new numbered migration file (`005_...sql`); never edit a migration that has already been applied.

## Import the supplier/factory list
Sheet `Assignments` with headers `Supplier` and `Factory` in A1:B1. Safe to re-run.
```bash
node --env-file=.env.production scripts/import-orgs.js "path/to/Assignments.xlsx"
```
`.env.production` must contain all five environment variables (the config loader requires them), although the
import only uses the Supabase values.

## Deploy
Import the GitHub repo into Vercel (Express is detected automatically), add the environment variables for both
**Production** and **Preview**, deploy. `package.json` pins Node `24.x`.
`vercel.json` pins the function region to `sin1`, serves `/admin` from `public/admin.html` and adds basic security headers.

Free Supabase projects pause after a period of inactivity. Keep the production project active (or on a paid plan)
for the whole registration period.

### Before sharing the link
- In the Vercel dashboard (Firewall), add rate-limit rules:
  - `POST /api/register`: generous, because many people at one factory can share an IP address (e.g. 30 requests per minute per IP).
  - `POST /api/admin/login`: strict (e.g. 10 requests per minute per IP).
- Use a long random `ADMIN_PASSWORD`.
- While registration is open, check the dashboard daily and delete obvious spam.
