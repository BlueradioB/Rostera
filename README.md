# Rostera

Rostera is a rose-themed roster dashboard for visualizing how people, skills, team assignments, and growth aspirations fit together.

## Run locally

Rostera uses Node.js 22.13 or newer and SQLite (built into Node). Install the development tools and start the app:

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:4173>. The first run creates `data/rostera.sqlite` and seeds a sample roster. Data is stored locally and survives restarts. Set `PORT`, `HOST`, or `ROSTERA_DATABASE` to change the bind port, network interface, or database file.

The responsive dashboard includes a corporate/fantasy theme switch, team skill coverage, roster search and filters, persistent team moves, team creation/editing, person skill and growth-aspiration management, and work creation/editing/reassignment/completion. Accounts use email and password sign-in; passwords are stored as scrypt hashes, and opaque session tokens are stored hashed in SQLite. New accounts own a workspace, and the first account claims the migrated Northstar Studio workspace and its existing roster. Passwords must be at least 12 characters.

Owners can create additional workspaces and single-use invitation links that expire after seven days. Invitees can create an account from the link or sign in to an existing account to join. Workspace roster data is isolated. Members have read-only access; only owners can change teams, people, assignments, workspace settings, or invitations. The application only serves its local API on `127.0.0.1` by default. Set `NODE_ENV=production` behind HTTPS so session cookies use the `Secure` attribute, and set `ROSTERA_PUBLIC_URL` to the trusted site origin when running behind a proxy. The wordmark and rose favicon live in `assets/`.

## Migrations and backups

SQLite schema changes run as ordered, transactional migrations tracked in `schema_migrations`. Existing single-workspace databases are upgraded in place, with roster records retained. Database files and backup directories are restricted to the current OS user.

The local server creates a consistent SQLite backup at startup and once per day, retaining the seven newest snapshots in `data/backups/`. Set `ROSTERA_BACKUP_DIRECTORY` or `ROSTERA_BACKUP_INTERVAL_MS` to customize the location or cadence. Create a manual backup with `npm run backup`. Local snapshots live beside the database and are not disaster recovery; copy them to separate protected storage.

## Deployment direction

The production path is **Supabase Auth + Postgres with row-level security, hosted on Vercel**. The Supabase API is implemented, but the migration has not been applied to a live project and the production flows have not yet been verified. Keep the SQLite server (`npm run dev`) for local SQLite development; it is not the production Vercel data store.

### Set up Supabase

1. Copy `.env.example` to `.env.local` and set the project URL and **publishable** key. These same two values are needed in Vercel's Development, Preview, and Production environments. Never put a Supabase secret or service-role key in a `NEXT_PUBLIC_` variable or browser code.
2. Apply the new schema and RLS policies to the project. With the Supabase CLI installed and authenticated, link this repository and push the migration:

   ```sh
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

   This is a new schema migration; review it before applying if the project already contains application tables. The SQL smoke test is in `supabase/tests/rls_smoke.test.sql`; `npx supabase test db` runs it against a local Supabase test database (Docker required).
3. In Supabase Auth settings, set the Site URL to the production site and add the callback URL `/api/auth/callback` for the production, preview, and local Vercel development origins. Add `http://localhost:3000/api/auth/callback` for local development. Enable email confirmation as desired.

### Deploy to Vercel

Import the repository into Vercel and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `ROSTERA_PUBLIC_URL` for each environment. `ROSTERA_PUBLIC_URL` should be the canonical origin for that environment. Deploy a Preview first and verify signup/email confirmation, login/logout, workspace creation and switching, invitations, member read-only access, and roster/work CRUD before promoting it to Production.

Run `npm run dev:vercel` to exercise the Vercel API locally against the configured Supabase project. Keep `.env.local` and Vercel's local configuration out of Git; they are ignored.

Configure Supabase's managed backups/PITR appropriate to the project plan and verify a restore procedure before relying on production data. The local SQLite backup job does not back up Supabase.

## API

The local JSON API exposes public `GET /api/health`, `GET /api/auth/me`, `POST /api/auth/register`, `POST /api/auth/login`, and `POST /api/auth/logout` endpoints. Authenticated workspace and invitation endpoints include `GET`/`POST /api/workspaces`, `POST /api/workspaces/switch`, `PATCH /api/workspaces/current`, and `GET`/`POST /api/invitations` with `POST /api/invitations/redeem`.

Authenticated roster endpoints include:

- `GET /api/health` and `GET /api/dashboard`
- `GET`, `POST`, `PATCH`, and `DELETE` on `/api/teams` and `/api/teams/:id`
- `GET`, `POST`, `PATCH`, and `DELETE` on `/api/people` and `/api/people/:id`
- `GET`, `POST`, `PATCH`, and `DELETE` on `/api/assignments` and `/api/assignments/:id`

People include team assignments, skills, growth aspirations, bloom ratings, and current work. Assignments can be unassigned, assigned to a person, or completed. State-changing API requests are same-origin checked, and session cookies are HttpOnly and SameSite=Strict.

Run `npm test` to type-check the app and exercise API, migration, authorization, and backup behavior against temporary SQLite databases. Run `npm run test:e2e` for browser-level registration and roster workflows; install Chromium first with `npx playwright install chromium`.
