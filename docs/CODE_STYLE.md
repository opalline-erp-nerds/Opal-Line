# Code Style

The conventions this repository follows. They are not aspirational — they are
what the existing code does, so that a new file looks like its neighbours.

Two linters are the executable form of these rules:

| Command | Scope | Config |
|---|---|---|
| `npm run lint` | Frontend | oxlint (default rules) |
| `npm run lint:backend` | Backend | oxlint `--max-warnings 0` — **any warning fails the build** |
| `npm run typecheck` | Backend | `tsc --noEmit` |
| `npm run build` | Frontend | `tsc -b && vite build` |

Run all three before you call a change done.

---

## 1. The house rules

1. **Explain the *why* in a comment, not the *what*.** The code already says
   what it does. A comment earns its place by explaining a decision that a
   reader would otherwise have to reverse-engineer.
2. **Never weaken a check to make a test pass.** If a guard is wrong, fix the
   guard. If the guard is right and the test is wrong, fix the test.
3. **Never swallow an error silently.** `catch {}` is allowed only when the
   comment says why the failure is harmless.
4. **One concern per module.** A file that needs a "and" in its description
   wants to be two files.
5. **Fail loudly in development, quietly in production.** Stacks go to the log,
   never to the response body.

---

## 2. Backend (`backend/src`)

### 2.1 Language and module system

- **CommonJS** (`"type": "commonjs"` in `backend/package.json`).
- TypeScript 7 with `module: preserve` + `moduleResolution: bundler` — the
  backend is bundled by esbuild and run by `tsx`, both of which resolve like a
  bundler. See [DEVELOPING.md](./DEVELOPING.md) for why `nodenext` was
  rejected.
- Imports use extensionless relative paths (`./lib/crypto`). No `.js`
  suffixes.

### 2.2 Naming

| Thing | Convention | Example |
|---|---|---|
| File | kebab-case | `silverRateScheduler.ts`, `pgRateLimitStore.ts` |
| Router file | camelCase, singular | `printTemplates.ts`, `systemStatus.ts` |
| Component/route file | PascalCase | `SalesOrders.tsx` |
| Function | camelCase verb-first | `computeUserPermissions`, `saveUploadedImage` |
| Constant | SCREAMING_SNAKE inside an object | `CONSTANTS.SESSION_TTL_MS` |
| DB column | snake_case | `require_password_change` |
| API path | kebab-case | `/api/v1/purchase-invoices` |
| Type/interface | PascalCase | `UserPermissions`, `ActivityEntry` |

### 2.3 Functions and modules

- **Arrow-function consts** for module-level helpers:
  `export const normalizeLockoutPolicy = (row) => {...}`.
- **Function declarations** for anything that needs hoisting or a `this`.
- Export the smallest useful surface. If a helper is only used inside its own
  file, do not export it.
- Shared pure logic goes in `backend/src/lib/` with a sibling
  `*.test.ts`. Examples: `dashboardRange.ts`, `rateSchedule.ts`,
  `scheduledRate.ts`, `dbtime.ts`, `routeParams.ts`.

### 2.4 Comments

The house style for explaining a non-obvious decision:

```ts
/**
 * Why the decision is what it is, and what breaks if it changes.
 *
 * A note about the failure mode that motivated it.
 */
export function doTheThing(): void {
  // A one-line note for a non-obvious line.
}
```

Comments in this repository frequently record a **past bug**: what went wrong,
why the current shape is the fix. That is deliberate — it stops the next
reader from "simplifying" the fix back into the bug.

```ts
// The expiresAt column is stored as UTC without a zone marker — parse as UTC
// or the session appears expired hours early on non-UTC machines.
const expiresAt = parseDbTimestamp(session.expiresAt)
```

### 2.5 Errors

- Handlers answer with `res.status(n).json({ error: '...' })`. The `error`
  key is the contract the frontend reads (`ApiError.message`).
- Log the cause with `logger.error({ err }, 'context')` before answering
  `500`.
- Never return a stack trace or a raw driver message to the client.
- Background or best-effort work (audit logging, activity logging, e-mail) may
  catch and discard — with a comment saying why that is safe.

```ts
try {
  await db.insert(schema.auditLogs).values({ ... })
} catch {
  // Audit logging must never break a business operation.
}
```

### 2.6 Database access

- **Drizzle only.** No raw SQL strings in route handlers. (`postgres.js`
  tagged templates are acceptable in `db/client.ts` and the few places that
  need a Postgres-specific feature such as `pg_stat_activity`.)
- Build queries with the Drizzle query builder (`and`, `or`, `eq`, `gt`, `lt`,
  `desc`, `sql`).
- `db` may be `null` when `DATABASE_URL` is unset. **Every route that touches
  the database must handle that** — return `503`, do not crash:

  ```ts
  if (!requireDb(res)) return
  ```

- Use `routeParam(req.params.id)` from `backend/src/lib/routeParams.ts` rather
  than casting `req.params.id` to a string. Express 5 types
  `req.params.*` as `string | string[]`.

### 2.7 Validation

- Validate the body with a **Zod schema** from `backend/src/validation.ts`
  and the `validate(schema)` middleware:

  ```ts
  dbRouter.post('/invoices', requirePermission('sales', 'create'),
    validate(createInvoiceSchema), async (req, res) => { ... })
  ```

- Zod **strips unknown keys** by default. If a field the handler needs is
  missing from the schema, it never reaches the handler — add it to the
  schema.
- Passwords use the shared `strongPassword` policy: ≥ 8 chars, one uppercase,
  one lowercase, one digit, one special character.

### 2.8 Routes

Every business route carries its own permission check:

```ts
dbRouter.post('/invoices', requirePermission('sales', 'create'), async (req, res) => { ... })
```

The mapping from HTTP method to action is fixed:

| Method | Action |
|---|---|
| `GET` | `view` |
| `POST` | `create` |
| `PATCH` / `PUT` | `edit` |
| `DELETE` | `delete` |

### 2.9 Logging

- Use the shared `logger` from `backend/src/logger.ts` (pino).
- Structured fields, not interpolated strings:

  ```ts
  logger.error({ err, userId }, 'Failed to create session in database')
  ```

- `logger.info` for lifecycle events, `logger.warn` for recoverable
  problems, `logger.error` for failures, `logger.debug` for detail.
- Never log a secret, a token, a password or a full request body.

### 2.10 Money, weight and rates

- Money is a **number** in the database, rounded at the point of calculation:
  `Math.round(x * 100) / 100`.
- Weights are grams, as numbers.
- Silver rate is a number per gram. The rate used by an invoice is **stored on
  the invoice item**, never looked up later — otherwise a rate change would
  rewrite history.

---

## 3. Frontend (`frontend/src`)

### 3.1 Language and module system

- **ESM** (`"type": "module"`), TypeScript, `.tsx` for components.
- The `@/` alias maps to `frontend/src`. Always import through it:
  `import { cn } from '@/lib/utils'`.
- Path alias for imports, relative imports inside a folder.

### 3.2 Components

- **Function components with hooks.** No class components.
- **Named exports** for page-level and feature components:
  `export function StatCard({ ... }: StatCardProps) { ... }`.
- **Default exports are reserved for React Router page components** — a page
  is imported with `lazy(() => import('@/pages/Dashboard'))`, which requires
  a default export.

```tsx
// A page — default export, because lazy() needs it.
export default function Products() { ... }

// A component — named export.
export function StatCard({ icon: Icon, title, value }: StatCardProps) { ... }
```

### 3.3 Props

- Type the props with an `interface` next to the component.
- Mark callbacks `React.FC`/`(…) => void` explicitly; avoid implicit `any`.
- Prefer explicit `string`/`number` over unions of literal strings unless
  the union is used for narrowing.

```tsx
interface StatCardProps {
  icon: LucideIcon
  title: string
  value: string
  trend?: 'up' | 'down' | 'flat'
  accent?: keyof typeof accentStyles
  className?: string
}
```

### 3.4 Styling

- **Tailwind utilities only.** No inline `style={{}}` for colours or spacing.
- Semantic tokens, never raw palette colours in a component:
  `bg-card`, `text-muted-foreground`, `border-border`, `text-success-700`.
  Raw palette classes (`bg-red-50`) are reserved for status semantics that
  have no token pair yet.
- Merge classes with `cn()` from `@/lib/utils` — `cn` is `twMerge(clsx(...))`,
  so a caller can override a component's defaults.
- Variants go through **CVA** (`class-variance-authority`), as in
  `components/ui/button.tsx` and `components/ui/badge.tsx`.
- Icons come from `lucide-react`, sized via the component's own classes
  (`&_svg]:size-4` on the button base).

### 3.5 Data fetching

- Pages never call `fetch`. They call the typed API client in
  `frontend/src/lib/api/`.
- Use `list()` when you need every row — it walks the pagination for you.
- Use `maybe()` when a `404` is an acceptable answer.
- Types live in `frontend/src/types/index.ts`; import them from `@/types`.

### 3.6 Permissions in the UI

- Guard a page with `RequireModule` (in `App.tsx`) and gate individual
  controls with `useAuth().hasPermission(module, action)`.
- Hide a control the user cannot use; do not render it disabled.
- The UI guard is **cosmetic**. The backend is the authority.

### 3.7 Formatting

- Currency, weight, dates and percentages go through `frontend/src/lib/format.ts`
  (`formatCurrency`, `formatWeight`, `formatDate`, `formatDateTime`,
  `compactCurrency`, `formatPercent`).
- The app is **IST-first**: `todayIST()` and `istDateKey()` are the only
  sanctioned ways to get "today".
- Amounts in words use `numberToIndianWords()` from `@/lib/utils`.

---

## 4. Git and commits

- Conventional-ish prefixes, lowercase, imperative:

  ```
  fix(purchases): bump the last digit run when recreating a purchase invoice
  feat(dashboard): financial analytics section with charts, aging and its own range
  test(dashboard): today/week range regression on scratch data
  ```

  Allowed scopes: `dashboard`, `purchases`, `shopify`, `sales`, `inventory`,
  `accounts`, `print`, `auth`, `desktop`, `docs`, `backend`, `frontend`.

- One logical change per commit. A refactor and a behaviour change in the
  same commit make the bisect useless.
- Never commit a credential. `npm run scan:secrets` runs in CI before
  anything else; if it fires on a real credential, **rotate it** — removing
  the commit does not help on a public repository.

---

## 5. Comments that are worth writing

```ts
// ✗ Restates the code.
// Increment the counter.
counter++

// ✓ Explains a decision.
// The browser drops Secure cookies over plain http, and the desktop app
// serves from http://localhost — so the flag must stay false here.
secure: false,
```

```ts
// ✓ Records a past bug so the fix is not "simplified" back.
// The window has lapsed (or nothing stored): the next failure restarts at 1.
return { decision: 'reset', count: 1 }
```

---

## 6. Review checklist

Before you open a PR:

- [ ] `npm run lint` — clean
- [ ] `npm run lint:backend` — clean (`--max-warnings 0`)
- [ ] `npm run typecheck` — clean
- [ ] `npm test` — all backend unit tests pass
- [ ] `npm run build` — frontend builds
- [ ] `npm run scan:secrets` — nothing to rotate
- [ ] New behaviour has a test, or a comment saying why it cannot have one
- [ ] New endpoints carry a `requirePermission(...)`
- [ ] New pages carry a `RequireModule` guard and a sidebar entry
- [ ] New configuration has an entry in [CONFIGURATION.md](./CONFIGURATION.md)
