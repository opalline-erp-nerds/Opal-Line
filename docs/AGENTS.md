# AGENTS.md

Operating guide for an AI agent (or a new contributor) working in this
repository. It assumes you can read code but does not assume you know this
project.

**Read this before your first change.** Most of the mistakes that happen here
are not coding mistakes — they are "did not know the app runs on loopback with
its own database" mistakes.

---

## 1. What this repository is

Opal Line Billing — a jewellery-billing ERP for silver retailers. React +
Vite frontend, Express + Drizzle + PostgreSQL backend, packaged as a signed
Windows desktop app (Electron) and also runnable as a web stack.

- Product overview: [PRD.md](./PRD.md)
- Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Conventions: [CODE_STYLE.md](./CODE_STYLE.md)
- UI rules: [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)
- Security model: [SECURITY.md](./SECURITY.md)
- Tests: [TESTING.md](./TESTING.md)

---

## 2. Ground rules

1. **Never weaken a check to make a test pass.** Fix the cause. If a guard is
   correct and a test is wrong, fix the test — and say so in the commit.
2. **Never commit a credential.** `npm run scan:secrets` runs in CI over the
   working tree *and* the whole git history. If it fires on a real value,
   rotate it — deleting the commit does not help on a public repository.
3. **Never write to a real database.** The desktop app's cluster is on
   `47193` (`opal_line`), the dev stack's on `47194` (`opal_line_dev`). Both
   hold shop data. Use a scratch database.
4. **Never reorder the middleware in `backend/src/index.ts`.** The order *is*
   the security contract.
5. **Never bypass the permission model.** A new endpoint without
   `requirePermission(...)` is a vulnerability.
6. **Comments explain the why.** A comment that restates the code is noise; a
   comment that records a past bug is the most valuable line in the file.
7. **Report what you actually ran.** Say "typecheck and unit tests pass" — not
   "it works". Distinguish *read*, *typechecked* and *executed*.

---

## 3. Setup

```bash
npm ci                # installs both workspaces (hoisted to the root)
npm run dev           # provisions a dev PostgreSQL on 47194, starts API + UI
```

`npm run dev` on its first run provisions a **dev-only** PostgreSQL cluster
and writes `backend/.env`. Nothing external is needed.

**Verify the stack is up:**

```bash
curl http://127.0.0.1:47191/api/v1/health
# → {"database":{"configured":true,"healthy":true,"latencyMs":1,...}}
```

**Login:** a fresh clone has an `admin` user with password `Opal@2026` and a
forced password change. After `npm run db:seed` the demo user is
`arjun` / `Opal@2026`. Credentials do **not** travel between machines —
every checkout bootstraps its own database.

Enable the pre-commit secret guard once per clone:

```bash
git config core.hooksPath .githooks
```

---

## 4. The commands that matter

| Command | What it does | When |
|---|---|---|
| `npm run dev` | Backend + frontend with hot reload | Day-to-day work |
| `npm run dev:server` / `npm run dev:web` | One side only | Isolating a bug |
| `npm run lint` | Frontend oxlint | Before every commit |
| `npm run lint:backend` | Backend oxlint, `--max-warnings 0` | Before every commit |
| `npm run typecheck` | Backend `tsc --noEmit` | Before every commit |
| `npm test` | Backend unit tests | Before every commit |
| `npm run build` | Frontend `tsc -b && vite build` | Before every commit |
| `npm run scan:secrets` | Credential scan | Before every push |
| `npm run test:e2e` | Playwright (needs the stack running) | UI changes |
| `npm run electron:dev` | Desktop window over the dev stack | Desktop-only behaviour |
| `npm run electron:build` | Signed NSIS installer | Release work |
| `npm run db:push` | Drizzle schema push | Schema changes in dev |
| `npm run db:generate` | Generate SQL migrations | Schema changes |

**The CI gate is exactly:** `scan:secrets` → `lint` → `lint:backend` →
`check-palette` → `typecheck` → `test` → `upgrade-path test` → `build`. A
change is not done until all of it is green locally.

---

## 5. Repository map

```
backend/src/
  index.ts              app assembly — middleware order, CSRF, static, routes
  routes/               one router per domain
  db/schema.ts          53 tables (Drizzle)
  db/bootstrap.ts       DDL + role seeding + first admin (runs every boot)
  lib/                  pure helpers with unit tests
  *.ts                  domain modules (shopify, purchases, stock, …)
frontend/src/
  pages/                63 page components (lazy-loaded)
  components/ui/        the design-system primitives
  components/           feature components
  lib/api/              typed API client
  auth/                 AuthProvider
  types/                shared types
electron/               main process, preload bridge, print, updater
e2e/                    Playwright specs
scripts/                build, packaging, audit utilities
docs/                   this documentation set
```

**Read `backend/src/index.ts` first** if you are new: it shows how the app is
assembled and where every guard sits.

---

## 6. Common tasks

### Add an API endpoint

1. Decide the module. If it is new, add it to `backend/src/rbac.ts`
   (`MODULES`) **and** `frontend/src/lib/permissions.ts` — they must agree.
2. Add the route in the matching `backend/src/routes/*.ts` with an explicit
   `requirePermission(module, action)`.
3. Validate the body with a Zod schema in `backend/src/validation.ts` and the
   `validate(schema)` middleware.
4. Handle `db === null` (`requireDb(res)`) and answer `503`, not `500`.
5. Add the client method in `frontend/src/lib/api/<domain>.ts`.
6. Add a test.

### Add a page

1. Create `frontend/src/pages/<Name>.tsx` with a **default export** (lazy
   loading needs one).
2. Add the route in `frontend/src/App.tsx` wrapped in `guarded('module', …)`.
3. Add a sidebar entry in `frontend/src/config/navigation.ts`.
4. Use `PageHeader`, `DataTable`, `EmptyState` and the format helpers.

### Change the schema

1. Edit `backend/src/db/schema.ts`.
2. `npm run db:push` for the dev database.
3. If the change needs Drizzle cannot express (triggers, partial indexes),
   add it to `backend/src/db/bootstrap.ts` — **and** make sure
   `backend/src/db/upgrade.test.ts` proves an existing install gains it.
4. `npm run db:generate` to produce the SQL migration.

### Change a design token

1. Edit `frontend/src/index.css` (light and `.dark`) and/or
   `frontend/src/theme.css` (the Tailwind mapping). **Both must agree.**
2. Run `node scripts/check-palette.mjs` — contrast is enforced in CI.
3. Tailwind 4 drops tokens it cannot find **silently**; check that
   `--primary`, `--radius` and the `.dark` block still reach the built CSS.

---

## 7. Traps

These are the ones that actually bite.

- **A stale backend holds the dev port.** A leftover `node` process on 47191
  silently serves the wrong database. Kill the listener before testing.
- **Login is rate limited** to 30 attempts / 15 minutes / IP. Repeated local
  runs produce HTTP 429. Wait, or clear the counters:
  `DELETE FROM rate_limit_hits WHERE key LIKE 'auth:%';`
- **`npm ci` deletes and reinstalls `node_modules`.** A dev server running
  from it breaks mid-install — stop `npm run dev` first. The installed
  desktop app ships its own bundled copy and is unaffected.
- **The Playwright suite logs in once**, in `e2e/global-setup.ts`. Tests must
  not log in individually.
- **Express 5 wildcards must be named**: `/{*splat}`, not `/*splat` and not
  `*`. A bare `*` throws at startup.
- **Express 5 types `req.params.*` as `string | string[]`.** Use
  `routeParam()` from `backend/src/lib/routeParams.ts`.
- **Timestamps are stored without a time zone, in IST.** Use
  `backend/src/lib/dbtime.ts`; never `new Date(column)` on a raw timestamp.
- **Zod strips unknown keys.** A field missing from the schema never reaches
  the handler — it disappears silently.
- **The session cookie is not `Secure`** (the app runs over plain HTTP on
  loopback). Do not "fix" it without changing the deployment model.
- **The master key must live in the app data dir**, not the install
  directory — Program Files is read-only, and a regenerated key permanently
  orphans every encrypted secret.
- **The dev stack and the installed app are separate.** Logging into one does
  not log you out of the other, and a dev migration never touches the desktop
  database.
- **`backend/src/index.ts` is not a dumping ground.** It is the assembly
  point. Business logic goes in a domain module.

---

## 8. Working with the git history

```bash
git diff          # review what you changed
git log --oneline -10
```

Commit style: `type(scope): summary`, lowercase, imperative — for example
`fix(purchases): bump the last digit run when recreating a purchase invoice`.

Allowed scopes: `dashboard`, `purchases`, `shopify`, `sales`, `inventory`,
`accounts`, `print`, `auth`, `desktop`, `docs`, `backend`, `frontend`.

One logical change per commit. A refactor and a behaviour change in the same
commit make the bisect useless.

---

## 9. Verifying your work

Before you report a task complete:

- [ ] `npm run lint`, `npm run lint:backend`, `npm run typecheck` — clean
- [ ] `npm test` — green
- [ ] `npm run build` — succeeds
- [ ] The change was **exercised**, not just compiled. Open the screen, call
      the endpoint, click the button. A green build is not evidence.
- [ ] For UI work: `npm run test:e2e` (or the relevant spec)
- [ ] For schema work: the upgrade-path test
- [ ] For colour work: `node scripts/check-palette.mjs`
- [ ] `npm run scan:secrets` — clean
- [ ] Report honestly what you ran, what you only typechecked, and what you
      only read

---

## 10. When you are stuck

1. **Read the code near the failure**, including the comments — they usually
   record the past bug that motivated the current shape.
2. **Search for the behaviour, not the string.** `code_search` for the
   function name, not for a message you half-remember.
3. **Check `docs/CONFIGURATION.md`** for the configuration knob you are
   looking for; most "the app ignores my setting" problems are a missing env
   var or a stale `.env`.
4. **Check `docs/DEVELOPING.md`** for the dependency-major migration notes
   (Express 5, Tailwind 4, TypeScript 7, dotenv 18) — those explain several
   confusing type errors.
5. **Look at `progress.md`** at the repository root for work in flight and the
   owner's decisions about it.

---

## 11. Reference

| Need | Document |
|---|---|
| What the product must do | [PRD.md](./PRD.md) |
| How it is built | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| How to write code here | [CODE_STYLE.md](./CODE_STYLE.md) |
| How to style the UI | [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) |
| The security model | [SECURITY.md](./SECURITY.md) |
| How to test | [TESTING.md](./TESTING.md) |
| Every configuration knob | [CONFIGURATION.md](./CONFIGURATION.md) |
| Setup, CI, releases, dependency migrations | [DEVELOPING.md](./DEVELOPING.md) |
| Production deployment | [DEPLOYMENT.md](../DEPLOYMENT.md) |
| Planned work | [ROADMAP.md](../ROADMAP.md) |
