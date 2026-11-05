# Opal Line ERP — Deployment Guide

> **Shipping the desktop app to end users?** The signed Windows installer
> needs no Node.js, no PostgreSQL and no admin rights on the target machine —
> see **[README → Install the desktop app](README.md#install-the-desktop-app-windows-installer)**
> for the user-facing install guide, and the reserved **47191–47198 port map**
> in [README → Ports](README.md#ports).

## Hosted mode (Render + Supabase)

Staging is one Render web service (`render.yaml`, environment `staging`). The API serves the built UI, so the browser stays on one origin. PostgreSQL is an external Supabase project. Do not point this at a database that has real orders — use a scratch project. Do not run `npm run db:seed` there; that script loads demo users. A fresh database gets username `admin` from bootstrap, with `SEED_ADMIN_PASSWORD`, and forces a password change at first login. When `HOST` is not loopback the process refuses to start without a 64-hex `ENCRYPTION_KEY` and a `CSRF_SECRET`, and it refuses to create that admin without `SEED_ADMIN_PASSWORD`. The password is not printed. The desktop app leaves `HOST` unset, so it still binds to `127.0.0.1`, still uses its default first password, and still prints that password once.

Product images stay on local disk unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set. Then new images go to the public Storage bucket `SUPABASE_STORAGE_BUCKET` (default `product-images`). Daily backups already upload to any S3-compatible bucket when `BACKUP_OFFSITE_ENDPOINT`, `BACKUP_OFFSITE_BUCKET`, `BACKUP_OFFSITE_KEY_ID`, and `BACKUP_OFFSITE_SECRET` are set. Supabase shows that S3 endpoint and those keys under Storage → S3 Access Keys. Leave both groups empty until the buckets exist.

Leave hosted variables unset on a desktop machine. The desktop app keeps binding to `127.0.0.1` and using its own data folder.

### Build and start

From the repo root, with Node 20:

```bash
npm ci --include=dev
npm run build -w frontend
```

`tsx` is a backend devDependency, so the install must include devDependencies. Do not set `VITE_API_BASE` for this one-origin layout. The client then calls relative `/api/v1` on the same host.

```bash
# Render sets PORT. HOST must be public; the desktop default is loopback.
# cwd of `npm run start -w backend` is backend/, so the UI path is one level up.
HOST=0.0.0.0 \
TRUST_PROXY=1 \
NODE_ENV=production \
FRONTEND_DIST=../frontend/dist \
DATABASE_URL='postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require' \
npm run start:server
```

Health check: `GET /api/v1/health`.

The same image is `Dockerfile` (context = repo root, container port **4000**). Local Docker still publishes that as host port **47196** via `docker-compose.yml`. Render’s blueprint uses the Node build above, not the Dockerfile.

### One origin

`backend/src/index.ts` serves `FRONTEND_DIST` when that folder contains `index.html`, then falls back to `frontend/dist` next to the repo root (`join(__dirname, '..', '..', 'frontend', 'dist')` while running `tsx src/index.ts`). Non-API routes get `index.html`. `/api/` and `/uploads` stay on that same host. Set `FRONTEND_ORIGIN` only when the UI moves to a different origin.

### Supabase connection

Use the **session pooler** (host `*.pooler.supabase.com`, port **5432**) or the **direct** host (`db.<ref>.supabase.co`, port **5432**), with `sslmode=require`. Both keep a session, which this process needs: `postgres.js` prepares statements by default, and `backend/src/db/client.ts` calls `client.listen('drizzle')`.

Do **not** use the transaction pooler (port **6543**). Prepared statements and `LISTEN` fail there. The direct host is often IPv6-only; Render’s IPv4-only instances need the session pooler or Supabase’s IPv4 add-on. That network limit was not tested from this repo.

Run **one** instance. The process starts backup, sync, mail, and rate timers in memory; a second instance runs them twice.

### Ports to leave alone

| Port | Keep it for |
|---|---|
| **47191** | Dev API |
| **47192** | Installed desktop API |
| **47193** | Desktop bundled Postgres |
| **47194** | Dev bundled Postgres |
| **47195** | Vite |
| **47196 / 47197 / 47198** | Local Docker host mappings (API, nginx, Postgres) |

Render assigns `PORT` (often 10000). Do not set `PORT` to anything in 47191–47198 on the hosted service. Shopify webhooks go to `https://<PUBLIC_BASE_URL>/api/v1/webhooks/shopify` (one route, topic in the header). API version **2025-10**.

Copy `backend/.env.example.hosted` into the Render environment. It has placeholders only.

## Prerequisites

- **Node.js** 20 LTS

- **PostgreSQL** 14+ (tested with 17)
- **npm** 9+ (or pnpm/yarn)
- **Shopify** store with Admin API access token

## 1. Environment Setup

### Backend `.env`

Copy `backend/.env.example` to `backend/.env` and fill in:

```env
# Server
PORT=47191

# Database
DATABASE_URL=postgresql://postgres:REDACTED@localhost:5432/opal_line

# Encryption (auto-generated on first run if empty)
ENCRYPTION_KEY=

# Shopify
SHOPIFY_STORE_URL=https://your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx
SHOPIFY_API_VERSION=2025-10

# Backup
BACKUP_DIR=./backups

# Email notifications (optional — Resend.com)
RESEND_API_KEY=re_xxxxxxxxxxxxx
NOTIFICATION_EMAIL=alerts@yourdomain.com
EMAIL_FROM=Opal Line <notifications@yourdomain.com>

# Silver rate API (optional)
SILVER_RATE_API_URL=https://api.metals.dev/v1/latest?api_key=YOUR_KEY
SILVER_RATE_API_KEY=
```

### Frontend `.env`

```env
VITE_API_BASE=http://localhost:47196/api/v1
```

## 2. Database Setup

```bash
# Create database
createdb opal_line

# Optional schema push. Server boot also runs the idempotent bootstrap.
cd backend
npx drizzle-kit push
```

A fresh database creates username `admin` on boot (`SEED_ADMIN_PASSWORD`, or the desktop default) and requires a password change. `npm run db:seed` is demo data (user `arjun`) for a local scratch database only — do not run it on the hosted database.

## 3. Start Development

```bash
# From project root (starts both backend + frontend)
npm run dev

# Or separately:
cd backend && npm run dev   # :47191
cd frontend && npm run dev  # :47195
```

The full dev/desktop/Docker port assignments live in
[README → Ports](README.md#ports).

## 4. Production Build

### Backend

The backend runs directly with `tsx` or can be compiled:

```bash
cd backend
npx tsc --noEmit  # Type check
node --import tsx src/index.ts  # Or use pm2/nodemon
```

### Frontend

```bash
cd frontend
npm run build     # Outputs to frontend/dist/
npm run preview   # Preview production build
```

### Serve Frontend

For production, serve `frontend/dist/` with nginx or a CDN:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Frontend
    location / {
        root /path/to/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:47191;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 5. Process Management (PM2)

```bash
# Install PM2 globally
npm install -g pm2

# Start backend
cd backend
pm2 start "node --import tsx src/index.ts" --name opal-backend

# Save process list
pm2 save
pm2 startup
```

## 6. SSL/HTTPS

Use Certbot with nginx:

```bash
sudo certbot --nginx -d yourdomain.com
```

## 7. Shopify Webhook Setup

1. Set `PUBLIC_BASE_URL` to the public https origin (no trailing slash) and `SHOPIFY_WEBHOOK_SECRET`.
2. On startup the server registers topics at `https://<PUBLIC_BASE_URL>/api/v1/webhooks/shopify`. The topic arrives in the `X-Shopify-Topic` header. There is no per-topic path.
3. API version is `SHOPIFY_API_VERSION` (default **2025-10**).

## 8. Backups

### Auto-Backup

Runs daily at **7:00 PM IST** (configurable in `backend/src/autoBackup.ts`):
- Full backup of all tables
- Auto-prunes to keep last 15 backups
- Pre-restore safety backups auto-deleted after 7 days

### Manual Backup

Via API:
```bash
# Export full backup
curl -H "Cookie: session=xxx" http://localhost:47191/api/v1/backup/export?type=full

# Export encrypted
curl -H "Cookie: session=xxx" http://localhost:47191/api/v1/backup/export-encrypted?type=full
```

Via UI: **Settings → Backup & Restore → Full Backup**

## 9. Email Notifications

Requires a [Resend](https://resend.com) account (free tier: 100 emails/day):

1. Sign up at resend.com
2. Get your API key
3. Add to `.env`:
   ```
   RESEND_API_KEY=re_xxxxx
   NOTIFICATION_EMAIL=you@yourdomain.com
   ```
4. Test: **Backup & Restore → Email Notifications → Send Test Email**

### Automatic Notifications

- **Backup complete**: Sent after each daily auto-backup
- **Low stock alert**: Sent when products fall below reorder level
- **Daily summary**: Available via API or UI button

## 10. Monitoring

### Health Check

```bash
curl http://localhost:47191/api/v1/health
```

For database + Shopify sync verification commands (authenticated
`/shopify/status` and `/shopify/sync` calls with expected responses), see
**[README → Verify database & Shopify sync](README.md#verify-database--shopify-sync)**.

### Logs

```bash
# PM2 logs
pm2 logs opal-backend

# Or tail the log file
tail -f backend-run.log
```

### Activity Trail

All user actions are logged in `activity_logs`:
- Login/logout
- CRUD operations
- Backup/restore
- Shopify sync

## 11. Security Checklist

- [ ] Change default admin password
- [ ] Set strong `ENCRYPTION_KEY` (auto-generated if empty)
- [ ] Use HTTPS in production
- [ ] Set `SHOPIFY_WEBHOOK_SECRET` for webhook verification
- [ ] Restrict database access to localhost only
- [ ] Enable rate limiting (built-in on auth endpoints)
- [ ] Review RBAC roles and permissions
- [ ] Set `NOTIFICATION_EMAIL` for alerts

## 12. Troubleshooting

| Issue | Solution |
|---|---|
| `password authentication failed` | Check `DATABASE_URL` password matches PostgreSQL |
| `EADDRINUSE: port 47191` | Kill existing process: `taskkill /PID <pid> /F` |
| Shopify sync fails | Check `SHOPIFY_ACCESS_TOKEN` and store URL |
| Email not sending | Verify `RESEND_API_KEY` and check spam folder |
| Backup restore fails | Ensure backup file is valid JSON, check disk space |
| Silver rate not updating | Set `SILVER_RATE_API_URL` in `.env` |

## 13. Windows Desktop Releases (signed installer)

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed
to the **Opal-Line** repo:

```bash
git tag -a v1.0.2 -m "Release v1.0.2"
git push origin v1.0.2
```

The workflow lints/tests, imports the code-signing cert, builds the NSIS
installer (frontend + bundled backend + portable PostgreSQL), verifies the
Authenticode signature, and attaches `Opal.Line.Billing-Setup-<ver>.exe` +
`.blockmap` to a GitHub Release. Builds take ~20-25 min.

Before attaching an installer to a release, run the committed smoke test
(silent install, extracted-tree + signature checks, app boot, PG 47193 /
backend 47192 probes):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test-install.ps1 -StopAtEnd
```

CI goes further on every push (the `desktop-e2e` job in
`.github/workflows/ci.yml`): it builds the signed installer, silent-installs
it, boots the app and runs the full Playwright suite against the installed
backend using the generated first-run admin credentials. The first-run
bootstrap has also been verified on a clean machine (install dir, `%APPDATA%`
data and uninstall keys wiped first): bundled PostgreSQL initializes, the
schema bootstraps, and the generated admin can log in.

Note: NSIS remembers the last chosen install directory from earlier runs — if
the smoke test fails on path checks, uninstall via the existing
*Uninstall Opal Line Billing* entry first, then re-run. End-user install steps
are documented in [README → Install the desktop app](README.md#install-the-desktop-app-windows-installer).

### One-time setup: signing certificate

The installer must be signed with a cert whose subject contains
`Opal Line Billing` (enforced by `signtoolOptions` in
`electron/electron-builder.yml`; a missing cert fails the build). From the
machine that has the cert:

```powershell
Export-PfxCertificate -Cert Cert:\CurrentUser\My\<thumbprint> `
  -FilePath code-signing.pfx -Password (ConvertTo-SecureString '' -AsPlainText -Force)
# Set the repo secret (uses scripts/set-gh-secret.mjs when gh CLI is absent):
GH_TOKEN=<token> node scripts/set-gh-secret.mjs WIN_SIGNING_PFX_B64 \
  <(base64 -w0 code-signing.pfx)
```

### Hard-won gotchas

- **Never import the cert into `Cert:\CurrentUser\Root` on the runner.** Both
  `Import-Certificate` and `certutil -user -addstore Root` raise a
  confirmation dialog that nobody can click on a headless runner — the job
  hangs silently. The workflow uses the **machine** Root/TrustedPublisher
  stores (`certutil -f -addstore`), which never prompt because GH runners are
  elevated.
- The job has `timeout-minutes: 90` so any hang fails fast instead of
  burning GitHub's 6-hour default.
- `publish: null` in electron-builder.yml stops electron-builder from trying
  to auto-publish (it fails without a `GH_TOKEN`); the workflow attaches
  assets to the Release itself.

### Auto-update handoff gotchas

The in-app updater (`installUpdateAndRestart` in `electron/main.ts`) quits the
app and runs the verified NSIS installer silently. Two environment quirks made
every automatic update fail until they were understood:

- **Pin the install directory with `/D`.** A bare `installer.exe /S` installs
  wherever NSIS defaults (or wherever a stale registration points), which can be
  `C:\Program Files` even when the app runs from a per-user path. The running
  copy then never changes and a second copy appears. Always pass
  `/D=<dir of the running exe>`, built as a raw argument line (`ProcessStartInfo`
  with `Arguments = '/S /D=' + $dir`) because NSIS requires `/D` to be the last,
  unquoted argument. The handoff also confirms the installed version actually
  changed before relaunching.
- **Detach `cmd.exe`, never `powershell.exe`.** A detached `powershell.exe`
  child never actually starts in this environment — it exits without running a
  line, so the handoff silently dies. A detached `cmd.exe` both survives
  `app.quit()` and runs a foreground PowerShell child that always executes. The
  fix is to spawn `cmd.exe /c powershell -EncodedCommand <base64>` detached.
- **Bootstrapping:** the first release that contains an updater fix must be
  installed **once manually** (`installer.exe /S`). A broken updater cannot
  upgrade itself, because the *running* app is what executes the handoff. Only
  after a fixed version is installed are subsequent updates truly zero-click.
- Installer steps are appended to `app.log` as `[installer]` lines; check there
  first when an update appears to do nothing.

### Verify a release locally

```powershell
# Download the asset from the GitHub Release, then:
Get-AuthenticodeSignature .\Opal.Line.Billing-Setup-1.0.1.exe
# Status should be Valid (or NotTrusted with our thumbprint — intact signature)

# Full smoke test (silent install + boot check of PostgreSQL & API):
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/smoke-test-install.ps1 -SetupPath .\Opal.Line.Billing-Setup-1.0.1.exe
```

### Local installer build (no CI)

```bash
npm run electron:build   # outputs dist-electron/*Setup-*.exe
```

## Port Allocation

Opal Line uses a dedicated port block so it never collides with common
software (databases, dev servers, other ERPs) on end-user machines:

| Port | Used by |
|---|---|
| **47191** | Backend API — development (`backend/.env` `PORT`) |
| **47192** | Backend API — installed desktop app (Electron child process) |
| **47193** | Bundled portable PostgreSQL — installed app only |
| **47195** | Vite dev server (`npm run dev:web`) |
| **47196** | Docker host mapping → backend container (:4000) |
| **47197** | Docker host mapping → nginx frontend container (:80) |
| **47198** | Docker host mapping → postgres container (:5432) |

Notes:
- The installed app and dev backend can run **simultaneously** (47192 vs
  47191); they must not share a database unless pointed at different names.
- Docker host mappings avoid the standard 5432/80 so `docker compose up`
  cannot clash with a locally installed PostgreSQL or IIS/nginx.
- The container-internal ports stay standard (4000, 80, 5432) — only the
  host-side mappings above changed.

## Architecture

```
opal_line/
├── backend/
│   ├── src/
│   │   ├── index.ts          # Express server, route mounting
│   │   ├── routes/
│   │   │   ├── auth.ts       # Login, logout, password reset
│   │   │   ├── db.ts         # Generic CRUD for all entities
│   │   │   ├── backup.ts     # Backup/restore/export/cleanup
│   │   │   ├── dashboard.ts  # KPIs, charts, analytics
│   │   │   ├── rbac.ts       # Role-based access control
│   │   │   └── dashboard.ts  # Profit analytics, reports
│   │   ├── shopify.ts        # Shopify sync engine
│   │   ├── autoBackup.ts     # Daily backup scheduler
│   │   ├── silverRateScheduler.ts  # Silver rate auto-update
│   │   ├── notifications.ts  # Email via Resend
│   │   ├── sessions.ts       # Session management
│   │   ├── rbac.ts           # Permission engine
│   │   └── db/
│   │       ├── schema.ts     # Drizzle ORM schema
│   │       ├── client.ts     # Database connection
│   │       └── seed.ts       # Initial data seeder
│   └── backups/              # Backup files (git-ignored)
├── frontend/
│   ├── src/
│   │   ├── pages/            # All UI pages
│   │   ├── components/       # Shared components
│   │   ├── lib/api.ts        # API client
│   │   └── auth/             # Auth context
│   └── dist/                 # Production build output
└── playwright-audit.mjs      # E2E security tests
```
