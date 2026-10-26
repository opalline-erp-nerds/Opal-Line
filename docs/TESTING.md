# Testing

What is tested, how to run it, and where a new test belongs.

The repository has four test layers. Each answers a different question, and
each catches a different class of bug.

| Layer | Tool | Scope | Runtime |
|---|---|---|---|
| **Unit** | `node --test` + tsx | Pure logic: pricing, ranges, lockout, crypto, RBAC merge | ~10 s |
| **Integration (DB-gated)** | `node --test` + tsx | Real PostgreSQL: schema, migrations, stock ledger | ~30 s |
| **Component** | `node --test` + tsx + React shim | Frontend rendering and helpers | ~5 s |
| **End-to-end** | Playwright | The installed app and the dev stack, in a browser | ~5–15 min |

---

## 1. Running everything

```bash
npm run lint          # frontend oxlint
npm run lint:backend  # backend oxlint --max-warnings 0
npm run typecheck     # backend tsc --noEmit
npm test              # backend unit tests
npm run build         # frontend tsc -b && vite build
npm run scan:secrets  # credential scan over the tree and the git history
```

That list **is** the CI gate (`Lint, typecheck, test, build`). CI adds two
steps the shell cannot: the palette contrast check and the upgrade-path test
(it needs a real PostgreSQL). A change is not done until all of it is green.

```bash
npm run test:e2e              # Playwright against the dev stack (needs it running)
npm run test:desktop          # Windows-only desktop behaviour tests
```

---

## 2. Unit tests (backend)

**Location** — beside the code, named `<module>.test.ts`:

```
backend/src/lockout.test.ts              backend/src/lib/dashboardRange.test.ts
backend/src/pricing.test.ts              backend/src/lib/rateSchedule.test.ts
backend/src/rbac.test.ts                 backend/src/lib/scheduledRate.test.ts
backend/src/webhooks.test.ts             backend/src/lib/scheduler.test.ts
backend/src/uploads.test.ts              backend/src/lib/seedGuard.test.ts
backend/src/stock.test.ts                backend/src/proxyTrust.test.ts
backend/src/purchases.test.ts            backend/src/recoveryPassword.test.ts
backend/src/gst.test.ts                  backend/src/db/upgrade.test.ts
backend/src/pdf.test.ts                  backend/src/orderInvoice.test.ts
backend/src/shopify.*.test.ts            backend/src/routes/dashboard*.test.ts
```

**Command** — `npm test` from the repo root runs:

```bash
node --import tsx --test --test-concurrency=1 --test-force-exit "src/**/*.test.ts"
```

(`--test-concurrency=1` because several tests touch shared state; `--test-force-exit`
because the DB client keeps a pool open.)

**What belongs here** — pure functions with no I/O:

- pricing and rate maths
- dashboard range resolution (including the IST and Monday rules)
- lockout decisions and policy normalisation
- RBAC permission merging
- webhook signature verification and replay-window logic
- upload magic-byte matching
- HTML escaping
- the trust-proxy resolver

**Rule:** if a test needs a database, it does **not** belong here — put it in
the integration layer below. If a test needs a browser, it belongs in the
e2e layer.

### Example

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideLockout, LOCKOUT_THRESHOLD } from './lockout'

test('locks the account on the threshold failure', () => {
  const now = 1_000_000
  const decision = decideLockout(LOCKOUT_THRESHOLD - 1, now - 1000, now)
  assert.equal(decision.decision, 'locked')
})
```

---

## 3. Integration tests (database-gated)

Some behaviour cannot be proven without a real PostgreSQL: DDL, migrations,
triggers, transactional stock movements. Those tests live beside the code but
**skip** when no database URL is provided, and CI runs them explicitly against
a service container.

```ts
const url = process.env.UPGRADE_TEST_DATABASE_URL
const skip = !url ? 'needs a PostgreSQL (UPGRADE_TEST_DATABASE_URL)' : false
test('…', { skip }, async () => { ... })
```

Gating variables in use:

| Variable | Used by |
|---|---|
| `UPGRADE_TEST_DATABASE_URL` | `backend/src/db/upgrade.test.ts` |
| `DASHBOARD_TEST_DATABASE_URL` | `backend/src/routes/dashboard*.test.ts` |

### The upgrade-path test

`backend/src/db/upgrade.test.ts` is the most important test in the repository.
It creates a **schema-only dump of an older install**, boots the current
bootstrap against it, and asserts that the new tables exist.

Without it, a table that only exists in the fresh-install path boots
"successfully" on an existing install and then fails at runtime — exactly the
class of bug that only shows up on a customer's machine after an update.

CI runs it as a separate step with a `postgres:16` service:

```yaml
- name: Upgrade-path test (needs PostgreSQL)
  run: node --import tsx --test --test-force-exit "src/db/upgrade.test.ts"
  working-directory: backend
  env:
    UPGRADE_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
```

### Scratch databases, never the real one

When a test needs data, use a **throwaway** database. Never point a test at
`opal_line` (the installed app) or `opal_line_dev`:

```bash
# create a scratch cluster / database, run the test, drop it
createdb opal_line_scratch
DASHBOARD_TEST_DATABASE_URL=postgres://…/opal_line_scratch npm test
dropdb opal_line_scratch
```

The desktop app's bundled cluster is on **47193**; the dev stack's on
**47194**. Both hold real shop data — do not write to them from a test.

---

## 4. Component tests (frontend)

The frontend has a small component-test suite run through a purpose-built
launcher:

```bash
npm test -w frontend
```

`frontend/scripts/test.mjs` exists because of two `tsx` limitations:

1. The `@/*` alias comes from the tsconfig `tsx` finds at the **process cwd**,
   so the child process runs with `cwd = frontend/`.
2. `tsx` only applies `jsx: react-jsx` from an auto-detected non-solution
   config; the solution-style `tsconfig.json` is ignored, so JSX would compile
   with the classic runtime. `frontend/scripts/jsx-shim.mjs` puts `React` on
   the global object to fix that.

npm scripts cannot set an environment variable portably (Windows `cmd` has no
`VAR=value cmd` syntax), which is why this is a script and not a one-liner.

**What belongs here** — rendering logic and pure helpers:

- chart formatters and value shaping
- anything that computes a value from props

**What does not belong here** — page-level behaviour that needs a real
backend. That is the e2e layer.

---

## 5. End-to-end tests (Playwright)

**Location** — `e2e/`, nine spec files, 68 tests:

| Spec | Covers |
|---|---|
| `auth-flow.spec.ts` | Sign-in, sign-out, forced password change |
| `security.spec.ts` | The largest suite — 18 tests over permissions, CSRF, lockout, uploads, backups |
| `invoice-and-products.spec.ts` | Creating an invoice, the product catalogue |
| `ui.spec.ts` | Navigation, layout, key screens |
| `features.spec.ts` | Cross-cutting features |
| `bulk-fulfilment.spec.ts` | Bulk pipeline moves and packing slips |
| `sales-order-details.spec.ts` | The sales-order detail screen |
| `recovery-login.spec.ts` | The recovery-password path |
| `port-card.spec.ts` | The System → Status port card |

**Configuration** — `playwright.config.ts`:

- `baseURL` from `E2E_BASE_URL`, default `http://127.0.0.1:47195` (the dev
  stack). Point it at `http://127.0.0.1:47192` to run against the installed
  app.
- One worker, `fullyParallel: false` — the backend rate-limits `/auth/login`
  (30 requests / 15 min / IP), so parallel authentication would fail the run.
- `storageState: 'e2e/.auth/state.json'`, produced once by the global setup.

**`e2e/global-setup.ts`** logs in **once** and saves the session cookies for
every test. Tests must never log in individually — that is what exhausts the
auth budget and makes the suite fail with HTTP 429.

The setup also clears the Postgres-backed `auth:*` rate-limit counters when a
`DATABASE_URL` (or the desktop app's `.pg-password`) is reachable, because
those counters survive restarts by design.

```bash
# against the dev stack
npm run dev            # in one terminal
npm run test:e2e       # in another

# against the installed app
E2E_BASE_URL=http://127.0.0.1:47192 E2E_PASSWORD=<generated-password> npx playwright test
```

Credentials come from `E2E_USER` / `E2E_PASSWORD` (defaults `admin` /
`Opal@2026`).

**Writing an e2e test:**

- Prefer a stable selector — `getByRole`, `getByLabel`, `getByText` — over a
  CSS class. The class names change when the design system changes.
- Wait for the thing you assert, not for a timeout.
- Do not assert on the network. Assert on what the user sees.
- One behaviour per test. A test that asserts five things fails opaquely.

---

## 6. Desktop tests

Windows-only behaviour that cannot run in the browser:

```bash
npm run test:desktop
```

Runs `node --test` over `scripts/*.test.mjs`:

| File | Covers |
|---|---|
| `quit-behavior.test.mjs` | The backend and PostgreSQL release their ports on quit |
| `log-rotation.test.mjs` | Log files are trimmed past the threshold |
| `userdata-consolidation.test.mjs` | Chromium's `userData` is consolidated into the app data dir |
| `print-flow.test.mjs` | The print/PDF bridge |
| `update-flow-harness.test.mjs` | The updater state machine |
| `update-sweep.test.mjs` | Stale update downloads are removed |
| `dev.test.mjs` | The dev-stack provisioning script |

Plus an Electron smoke run of the print chooser.

These run in the **Windows CI job**, not the Ubuntu one: `taskkill /T`,
`netstat -ano` and `findstr` do not exist on the Ubuntu runner, so a test
gated on the runner OS could never catch the regression it exists for.

---

## 7. Manual and audit scripts

Not tests, but part of the verification toolkit:

| Script | What it does |
|---|---|
| `scripts/check-palette.mjs` | WCAG AA contrast across light, dark and print — **in CI** |
| `scripts/check-links.mjs` | Cross-checks frontend API calls against backend endpoints |
| `scripts/audit-api.mjs` | Reports API surface and permission coverage |
| `scripts/playwright-audit.mjs` | Playwright-driven UI audit |
| `scripts/contrast-audit.mjs` | Contrast check outside the CI gate |
| `scripts/scan-secrets.mjs` | Credential scan over the tree and the git history — **in CI** |
| `scripts/smoke-test-install.ps1` | Silent install → boot → probe ports 47192/47193 |
| `scripts/print-chooser-smoke.mjs` | The native print chooser, under Electron |

---

## 8. What to test where — a decision guide

```mermaid
flowchart TD
  Q1{"Does it need a browser?"}
  Q1 -->|Yes| E2E["Playwright spec in e2e/"]
  Q1 -->|No| Q2{"Does it need PostgreSQL?"}
  Q2 -->|Yes| INT["Integration test<br/>DB-gated, skip without a URL"]
  Q2 -->|No| Q3{"Is it frontend rendering logic?"}
  Q3 -->|Yes| COMP["Component test<br/>frontend/src/**/*.test.tsx"]
  Q3 -->|No| UNIT["Unit test<br/>backend/src/**/*.test.ts"]
```

Work down the list and stop at the first "yes".

---

## 9. Adding a test

**Backend unit test** — beside the module:

```ts
// backend/src/lib/example.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { example } from './example'

test('example does the thing', () => {
  assert.equal(example(1), 2)
})
```

**Backend integration test** — beside the module, gated:

```ts
const url = process.env.SOME_TEST_DATABASE_URL
const skip = !url ? 'needs a PostgreSQL (SOME_TEST_DATABASE_URL)' : false

test('…', { skip }, async () => {
  const sql = postgres(url!, { max: 1 })
  try { /* … */ } finally { await sql.end({ timeout: 5 }) }
})
```

**Frontend component test** — beside the component:

```tsx
// frontend/src/components/charts/example.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatValue } from './example'

test('formats a value', () => {
  assert.equal(formatValue(10), '10')
})
```

**E2E test** — in the matching spec:

```ts
import { test, expect } from '@playwright/test'

test('creates an invoice', async ({ page }) => {
  await page.goto('/sales/invoices')
  await page.getByRole('button', { name: 'New Invoice' }).click()
  // …
  await expect(page.getByText('Invoice saved')).toBeVisible()
})
```

---

## 10. Rules

1. **A bug fix without a test is not finished** — unless the fix is a
   configuration or copy change, in which case say so in the commit.
2. **A failing test is a finding, not an obstacle.** Fix the cause. Never
   weaken an assertion, skip a test or add a type/lint suppression to make the
   suite green.
3. **Tests must not depend on execution order.** `--test-concurrency=1` is a
   safety net, not permission to depend on it.
4. **No test may write to a real database.** Use a scratch database.
5. **Deterministic only.** No reliance on the wall clock (inject `nowMs`),
   on random ordering, or on network access.
6. **Assert the behaviour, not the implementation.** A test that breaks when
   you rename a private function is testing the implementation.
7. **When a test needs a database, it skips — it does not fail.** The CI step
   that has the database runs it for real.

---

## 11. Debugging a failing test

```bash
# backend: run one file with full output
cd backend && node --import tsx --test src/lockout.test.ts

# e2e: run one spec, headed, with the trace
npx playwright test e2e/security.spec.ts --headed --trace on
```

Playwright writes a trace on failure (`trace: 'retain-on-failure'`) and a
screenshot (`screenshot: 'only-on-failure'`) into `test-results/`. The
Playwright HTML report shows the step that failed.

A very common e2e failure is **HTTP 429 on login**: the auth rate limit (30
per 15 minutes per IP) was exhausted by repeated local runs. Wait 15 minutes,
or clear the counters:

```sql
DELETE FROM rate_limit_hits WHERE key LIKE 'auth:%';
```
