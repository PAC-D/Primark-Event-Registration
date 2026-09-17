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
