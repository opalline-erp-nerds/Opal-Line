# Security

The security model of Opal Line Billing, the controls that implement it, and
the checklist to run before shipping a change that touches it.

The threat model in one sentence: **a single shop's billing data, on a
Windows desktop that may also be reachable over a LAN.** Every control below
exists to keep a stolen password or a hostile neighbour from reading or
altering that data.

---

## 1. Controls at a glance

| Area | Control | Where |
|---|---|---|
| Passwords | argon2id hashing | `backend/src/routes/auth.ts` |
| Password strength | ≥ 8 chars, upper + lower + digit + special | `backend/src/validation.ts` |
| Sessions | DB-backed, opaque 32-byte token, `httpOnly` + `SameSite=Strict` cookie | `backend/src/sessions.ts` |
| Authorisation | 9 modules × 4 actions, role + per-user overrides | `backend/src/rbac.ts` |
| CSRF | HMAC-signed token + double-submit cookie check | `backend/src/index.ts` |
| XSS / headers | Helmet CSP, HSTS, frameguard, no-sniff | `backend/src/index.ts` |
| CORS | Exactly one origin, `credentials: true` | `backend/src/index.ts` |
| Brute force | Per-IP rate limit **and** per-account lockout | `index.ts`, `lockout.ts` |
| Network | Binds to `127.0.0.1` by default | `backend/src/config.ts` |
| Secret storage | AES-256-GCM at rest | `backend/src/lib/crypto.ts` |
| Webhooks | HMAC-SHA256 + constant-time compare + replay dedupe | `backend/src/webhooks.ts` |
| Uploads | Magic-byte validation, size caps, content-addressed names | `backend/src/uploads.ts` |
| Proxy headers | `trust proxy` off unless `TRUST_PROXY` is set | `backend/src/proxyTrust.ts` |
| Audit | Audit log + activity log on every mutation | `backend/src/activity.ts` |
| Supply chain | Secret scan over the tree **and** the whole git history | `scripts/scan-secrets.mjs` |

---

## 2. Authentication

### 2.1 Password storage

Passwords are hashed with **argon2id** (the `argon2` package). The plain
password is never stored, logged, or returned by any endpoint.

Policy (`strongPassword` in `backend/src/validation.ts`):

- at least 8 characters, at most 255
- at least one uppercase letter
- at least one lowercase letter
- at least one digit
- at least one special character

The first-login admin is seeded with `require_password_change = true`. While
that flag is set, `requireAuth` refuses every request except
`/api/v1/auth/change-password`, `/api/v1/auth/logout` and `/api/v1/auth/me`.

### 2.2 The recovery password

A shop owner who forgets the password can type a **recovery password** into
the normal password box. It is accepted only for `Admin` and `Super Admin`
roles, and only against the account it is presented for.

- Only an **argon2id hash** is stored — either the built-in constant's hash
  (`CONSTANTS.SUPERADMIN_RECOVERY_PASSWORD_HASH`) or a rotated value in
  `settings.notificationSettings.recoveryPasswordHash`.
- The plaintext of the built-in value lives in
  [recovery-password.md](./recovery-password.md) and nowhere else.
- A legacy ≤ v1.0.14 AES-encrypted copy is still honoured, re-hashed with
  argon2id on first use, and the plaintext-capable copy is then dropped.
- Every use is written to the activity log, and the login lockout still
  applies.

### 2.3 Login lockout

`backend/src/lockout.ts` holds the decision rules as pure functions (unit
tested, no database needed); `routes/auth.ts` persists the counters in
`login_attempts`.

- Default: **5 failures in 15 minutes** → locked until 15 minutes after the
  last failure.
- The threshold and duration are configurable per install in
  **Settings → Security → Login lockout**, and are clamped to sane bounds
  (threshold 1–50, duration 1–1440 minutes) so a bad row can never disable
  protection or lock the owner out for a week.
- **The product ships with lockout disabled** so that testing installs are not
  locked out; the per-IP rate limit below is always on.

### 2.4 Rate limiting

| Scope | Limit | Key | Store |
|---|---|---|---|
| `/api/v1/auth/login` | 30 / 15 min | IP | Postgres (`rate_limit_hits`) |
| `forgot-password`, `reset-password`, `resend-verification` | 3 / hour | IP | Postgres |
| Outbound e-mail routes | 30 / hour | user id, falling back to IP | Postgres |

The counters live in Postgres on purpose: an in-memory store would let an
attacker wait out a window — or trigger a backend restart — for a fresh
budget. IPv6 clients go through `ipKeyGenerator`, so the key is a /64 prefix
rather than a rotating /128 address.

---

## 3. Sessions

- A session is a **random 32-byte token** stored in the `sessions` table with
  a 24-hour TTL, delivered as the `opal.session` cookie.
- The cookie is `httpOnly` and `SameSite=Strict`.
- `secure` is **false**, deliberately: the desktop app serves over
  `http://localhost`, and a browser silently drops `Secure` cookies on plain
  HTTP. Behind a reverse proxy that terminates TLS, set it via the deployment
  (see [DEPLOYMENT.md](../DEPLOYMENT.md)).
- The token is looked up by exact match on every request; expired rows are
  deleted on read and by a 5-minute sweeper.
- **Sessions survive a backend restart** — that is the point of a database
  table with a TTL. `shutdownSessions()` therefore does *not* wipe the table:
  doing so logged every user out of every backend instance sharing the
  database, including the desktop app when the dev server restarted.
- `destroyUserSessions()` exists for "log out other devices".

---

## 4. Authorisation (RBAC)

### 4.1 The model

Nine modules, four actions each:

| Module | Covers |
|---|---|
| `dashboard` | Home dashboard and KPIs |
| `silver-rate` | View and update the silver rate |
| `sales` | Invoices, orders, customers, returns |
| `purchase` | Purchase orders, invoices, suppliers, returns |
| `inventory` | Products, stock, transfers, barcodes, low stock |
| `accounts` | Expenses, payments, bank accounts, ledger |
| `reports` | Business, GST, sales and inventory reports |
| `shopify` | Shopify sync, price and inventory push |
| `system` | Users & roles, settings, audit logs |

Actions: `view`, `create`, `edit`, `delete`.

### 4.2 How permissions are resolved

```
effective = merge(rolePermissions[role], user.permissions /* personal override */)
```

- **Only `Super Admin` ships with access.** Every other role starts with no
  modules at all — a super admin turns modules on per user or per custom
  role. The old per-role templates (Admin = everything, Manager = sales +
  inventory) handed every new user broad access without anyone deciding it.
- A personal override wins over the role, per module and per action.
- A **Super Admin is never narrowed** — neither the stored role row nor a
  personal override may reduce a Super Admin's access. That is a deliberate
  self-lockout guard.
- `requireSuperAdmin` gates the operations that hand out access itself:
  switching a module on for a user, defining a role with permissions, or
  assigning the `Super Admin` role.

### 4.3 Enforcement points

| Guard | Purpose |
|---|---|
| `requireAuth` | Resolves the session to a user id |
| `enforceRbac` | Maps the first path segment of `/api/v1/db/*` to a module and checks the action implied by the HTTP method |
| `requirePermission(module, action)` | The explicit per-route check — **this is the authoritative one** |

The frontend mirrors the model (`frontend/src/lib/permissions.ts`) to hide what
the user cannot do, and `RequireModule` guards each route. **The frontend
guard is cosmetic**: the backend re-checks every request.

---

## 5. Request-level protections

### 5.1 CSRF

`GET /api/v1/csrf-token` issues an HMAC-SHA256-signed token bound to the
session id and a timestamp (1-hour validity). State-changing requests must
send it in the `X-CSRF-Token` header, and it must match the `XSRF-TOKEN`
cookie — a double-submit check, so a token leaked from another origin cannot
be replayed.

Exempt paths: the login/forgot/reset/verify/resend auth routes and the Shopify
webhooks (which carry their own HMAC).

The frontend caches the token for 30 minutes and, on a `403` for a
state-changing call, refreshes it and retries **once**.

### 5.2 Security headers

Helmet sets a strict CSP (`default-src 'self'`, `script-src 'self'`,
`style-src 'self' 'unsafe-inline'`, `img-src 'self' data: https://cdn.shopify.com`,
`object-src 'none'`, `frame-ancestors 'none'`), HSTS with preload, a
`strict-origin-when-cross-origin` referrer policy, `X-Content-Type-Options:
nosniff` and `X-Frame-Options: DENY`. `x-powered-by` is disabled.

### 5.3 CORS

Exactly one origin (`FRONTEND_ORIGIN`, default `http://localhost:47195`),
with `credentials: true` and an explicit method/header allowlist. There is no
`origin: true` wildcard anywhere.

### 5.4 Body size

The JSON body parser is limited to **1 MB** (`REQUEST_SIZE_LIMIT`). The two
routes that legitimately need more (bulk product images) install their own
parser with a 25 MB limit on that route only.

---

## 6. Network exposure

- The backend binds to **127.0.0.1** by default. The desktop app only ever
  loads the UI from `http://localhost:<port>`, so listening on every interface
  would expose the entire authenticated API — including `/auth/login` — to
  the local network.
- A container deployment must opt in explicitly with `HOST=0.0.0.0`.
- `trust proxy` is **off** unless `TRUST_PROXY=1` (or a hop count) is set.
  Trusting `X-Forwarded-For` by default lets a direct client rotate its
  rate-limit key and bypass login throttling.

---

## 7. Secrets at rest

### 7.1 Encryption

`backend/src/lib/crypto.ts` encrypts secrets with **AES-256-GCM**.

- The master key comes from `ENCRYPTION_KEY` (hex) if set, otherwise from
  `.encryption-key` in the app data dir, otherwise a new key is generated and
  persisted with mode `0600`.
- The desktop app's install directory is read-only, so the key must live in
  the **per-user data dir** (`APP_DATA_DIR/.encryption-key`) — otherwise every
  restart would mint a new key and permanently orphan every encrypted secret.
- The stored format is `base64(iv ‖ tag ‖ ciphertext)`; the `encV1:` prefix
  marks an encrypted value in an environment variable.
- `decryptSecret()` never throws on a bad value — it logs and returns empty,
  so one corrupt ciphertext cannot stop the app from booting.

**Losing the master key means losing the encrypted data.** Back it up with the
database.

### 7.2 What is stored encrypted

Shopify store URL and access token, the Shopify webhook secret, database
credentials, the database password shown to the administrator, the rotated
recovery password (as a hash), and the SMTP/notification secrets.

### 7.3 In transit

Secrets are never written to a log. `mask()` renders them as `••••••••` in
the UI. `scripts/scan-secrets.mjs` scans the working tree **and the entire git
history** for credential-shaped paths and content; it runs in CI before
anything else and in the pre-commit hook.

**If it fires on a real credential, rotate it.** Removing the commit does not
help on a public repository — the value was world-readable from the moment it
was pushed.

---

## 8. Input handling

| Input | Defence |
|---|---|
| Request bodies | Zod schemas (`backend/src/validation.ts`) |
| IDs and path params | `routeParam()` (Express 5 types them as `string \| string[]`) |
| User-supplied HTML (product descriptions, print templates) | `escapeHtml()` — `backend/src/htmlEscape.ts` and `frontend/src/lib/utils.ts` |
| Uploaded images | Magic-byte check against the declared MIME type |
| Filenames | `basename()` + a prefix check + a resolved-path containment check |
| SQL | Drizzle query builder — no string interpolation into SQL |

### 8.1 Upload validation

`backend/src/uploads.ts` accepts JPEG, PNG, WebP, GIF and AVIF.

- The client's declared MIME type is **not trusted**: the file's magic bytes
  must match it, or the upload is rejected. Without this, a "PNG" could be an
  HTML/SVG payload served from `/uploads`.
- Maximum **8 MB** per image, maximum **20 images** per request.
- Files are stored under a content-addressed name (`sha1-16 + uuid8 + ext`),
  so the name carries no user input and the same image uploaded twice stores
  once.

---

## 9. Webhooks

`backend/src/webhooks.ts` verifies Shopify deliveries:

1. The HMAC header must be present; the raw body must be available (the JSON
   parser keeps a raw copy for the webhook path).
2. The signature is recomputed with HMAC-SHA256 and compared **byte-wise with
   `timingSafeEqual`**, not as base64 strings — comparing the strings rejects
   every genuine webhook when a length differs.
3. **Replay protection**: deliveries are deduplicated by
   `X-Shopify-Webhook-Id` for 3 days, in the `webhook_deliveries` table with
   an in-memory fallback for a database outage. A duplicate returns `200`
   without acting — Shopify retries failed deliveries, and a retry is not an
   attack.

---

## 10. Auditability

| Log | Contains | Read by |
|---|---|---|
| `audit_logs` | Who changed what, with a change summary | System → Audit Logs |
| `activity_logs` | Operational events (sync run, rate changed, backup taken) | System → Activity Log |
| `login_attempts` | Failed logins per identifier | Login lockout, System → Status |
| `sync_logs` | Every Shopify sync run and its outcome | System → Sync Logs |
| `notification_log` | Every outbound message | System → Notification Log |

`recordActivity()` and `recordAudit()` are **fire-and-forget**: a logging
failure never breaks the business operation that triggered it.

---

## 11. Backup and recovery

- Backups are encrypted with the same master key, so a backup file is useless
  without it.
- Auto-backup runs on a schedule; a copy can be pushed to an S3-compatible
  endpoint (Cloudflare R2 and friends).
- Restore is a first-class screen (System → Backup & Restore).
- **A backup without the master key cannot be restored.** The key lives in
  `APP_DATA_DIR/.encryption-key`; copy it with the backup.

---

## 12. Reporting a vulnerability

This is a private, single-tenant product. Report a suspected vulnerability to
the repository owner privately rather than opening a public issue. Include:
the affected version, the reproduction steps, and the impact.

---

## 13. Pre-release security checklist

Run through this before any release that touches auth, RBAC, sessions, crypto,
uploads or the network surface.

- [ ] Every new endpoint has `requireAuth` **and** a `requirePermission(...)`
- [ ] The new action maps to an existing module — no new module without an
      entry in `backend/src/rbac.ts` **and** `frontend/src/lib/permissions.ts`
- [ ] New input is validated with a Zod schema, not ad-hoc checks
- [ ] New user-supplied HTML is escaped
- [ ] New secrets are stored through `encryptSecret`, never in plain text
- [ ] Nothing new is logged that contains a token, password or personal data
- [ ] `npm run scan:secrets` is clean
- [ ] `npm run lint:backend` is clean (warnings are errors)
- [ ] `npm test` passes, including the lockout, RBAC, session and webhook tests
- [ ] The change does not reorder the middleware in `backend/src/index.ts`
- [ ] The change does not enable `trust proxy` or `HOST=0.0.0.0` by default
- [ ] Cross-origin reads are still blocked by the single-origin CORS policy
- [ ] The desktop app still binds to loopback

---

## 14. Known limitations

Stated plainly, so nobody is surprised:

- **The session cookie is not `Secure`** because the desktop app runs over
  plain HTTP on loopback. In a browser-hosted deployment behind TLS, set it
  in the deployment configuration.
- **The recovery password is a fixed value on every install** until it is
  rotated in Settings → Team. It is documented in
  [recovery-password.md](./recovery-password.md) — rotate it on any shared
  machine.
- **Login lockout ships disabled**; the per-IP rate limit is the always-on
  guard. Enable the lockout for a production install.
- **CSP allows `style-src 'unsafe-inline'`**, which Tailwind's runtime style
  injection requires. Scripts remain strictly `'self'`.
- **Rate-limit counters live in the database**, so a very large install adds
  a row per key per window; the store prunes expired rows.
