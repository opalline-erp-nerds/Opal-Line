# Opal Line ERP — Configuration Guide

Every configuration surface in the project: **environment variables** (backend
`backend/.env`), **in-app settings** (stored in the database, edited via the
Settings UI), and **integration setup** (Shopify, email, WhatsApp, Razorpay,
backups). Each section shows a working example and the steps to apply it.

> Env vars are read once at server start — restart the backend after editing
> `backend/.env`. Values stored in the database (Shopify credentials, SMTP,
> WhatsApp) can be changed live from the UI and **override** env vars.

---

## 1. Core (required)

| Variable | Example | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:secret@localhost:5432/opal_line` | PostgreSQL connection (local install or Neon/Supabase cloud) |
| `PORT` | `47191` | Backend API port |
| `HOST` | `127.0.0.1` | Bind address (default: all interfaces) |
| `NODE_ENV` | `production` | `production` disables pretty logs, verbose error bodies, dev transports |

**Example `backend/.env`:**

```env
DATABASE_URL=postgresql://postgres:S3cret@localhost:5432/opal_line
PORT=47191
```

**Steps (dev machine):**

1. Install PostgreSQL 14+, create a database: `CREATE DATABASE opal_line;`
2. Copy `backend/.env.example` → `backend/.env`, fill `DATABASE_URL`.
3. `npm install` (repo root), then:
   ```bash
   npm run db:push      # create/update all tables
   npm run db:seed      # demo users, roles, settings row
   ```
4. `npm run dev` → UI at `http://127.0.0.1:47195`, API at `http://localhost:47191`.

**No PostgreSQL setup needed:** if `backend/.env` has no `DATABASE_URL`,
`npm run dev` provisions one automatically — a **dev-only** cluster on port
**47194** under `%APPDATA%/Opal Line Billing Dev` (Windows), fully separate
from the installed desktop app's cluster (port **47193** under
`%APPDATA%/Opal Line Billing`). Dev and the desktop app never share users,
sessions or data, and both stacks can run at once.

**Logins** (each environment bootstraps its own database, so credentials do
not transfer between machines):

| Setup | Username | Password |
|---|---|---|
| Fresh database (first backend start / bootstrap) | `admin` | `Opal@2026` — first login forces a change |
| After `npm run db:seed` (demo data) | `arjun` | `Opal@2026` |

A teammate's working password will not work on a new clone; use the table
above. An older `backend/.env` that still points `DATABASE_URL` at
`127.0.0.1:47193` (the pre-separation shared setup) is migrated to the dev
cluster automatically on the next `npm run dev`.

Cloud database (Neon example) — just swap the URL and keep `sslmode=require`:

```env
DATABASE_URL=postgresql://user:pass@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

## 2. Security

| Variable | Example | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | 64-char hex | AES-256-GCM key encrypting secrets stored in DB (Shopify token, SMTP, WhatsApp). **Leave empty on first run** — auto-generated to `.encryption-key`. Set the same value on every server sharing one database. |
| `CSRF_SECRET` | random hex | HMAC key for CSRF tokens. Auto-generated to `.csrf-secret` when empty. |
| `SEED_ADMIN_PASSWORD` | `Opal@2026` | Password for the superadmin created on a fresh install (bootstrap), by `npm run db:seed`, and by `npm run auth:reset`. Default `Opal@2026`; fresh installs still force a password change at first sign-in. |
| `COOKIE_SECURE` | `true` | Marks the `opal.session` cookie `Secure`. Leave empty for the desktop app (plain `http://localhost` drops a `Secure` cookie); set `true` on Render or any HTTPS deployment. |
| `COOKIE_SAMESITE` | `strict` / `lax` / `none` | Session cookie `SameSite` policy (default `strict`). Use `none` only when the UI and API are on different sites; it forces `Secure`. |
| `TRUST_PROXY` | `1` / `loopback` / `"10.0.0.1,10.0.0.2"` | Trust Express `X-Forwarded-*` headers (needed behind nginx/Cloudflare for correct rate-limit keys and `req.ip`). **Never enable when directly exposed** — it lets clients spoof IPs. |

```env
ENCRYPTION_KEY=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
TRUST_PROXY=1
```

## 3. Shopify

Stored **in the database** (encrypted) via *System → Connections* — env vars are
only a fallback:

| Variable | Example | Purpose |
|---|---|---|
| `SHOPIFY_STORE_URL` | `your-store` (or full `https://your-store.myshopify.com`) | Store identifier |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxxxxxxxxxxxxxx` | Custom-app Admin API token |
| `SHOPIFY_API_VERSION` | `2025-10` | Admin API version |
| `SHOPIFY_WEBHOOK_SECRET` | random hex | Verifies `/api/v1/webhooks/shopify` + Flow webhook HMAC |
| `PUBLIC_BASE_URL` | `https://erp.example.com` | When set, order/product/customer webhooks are **auto-registered** at startup to point here |
| `FRONTEND_ORIGIN` | `http://localhost:47195` | Allowed CORS origin (the desktop app default) |

**Steps:**

1. Shopify Admin → *Settings → Apps and sales channels → Develop apps → Create an app*.
2. *Configure Admin API scopes*: `read/write products, orders, customers, inventory`.
3. *API credentials → Install app* → copy the **Admin API access token** (shown once).
4. ERP → *System → Connections → Shopify*: paste store URL + token → **Test** → **Save**.
5. Optional (auto webhooks): set `PUBLIC_BASE_URL` so the ERP registers
   `orders/create`, `orders/cancelled`, `orders/fulfilled`, `products/update`,
   `customers/create` on boot.
6. Dev stores redact customer PII on the API — set up the
   [Flow webhook](shopify-flow-webhook.md) and/or order-email ingestion (§5) to
   recover name/address.

## 4. Notifications email (SMTP / Resend)

Used for backup emails, payment reminders, dues statements, daily summary,
low-stock alerts. Env fallbacks; live values editable in *System → Settings →
Notifications* (stored encrypted):

| Variable | Example | Purpose |
|---|---|---|
| `NOTIFICATION_SMTP_HOST` | `smtp.gmail.com` | SMTP server |
| `NOTIFICATION_SMTP_PORT` | `587` | SMTP port (587 STARTTLS / 465 SSL) |
| `EMAIL_FROM` | `Opal Line <no-reply@opalline.in>` | From header |
| `NOTIFICATION_EMAIL` | `owner@opalline.in` | Default recipient (backups, summaries) |
| `RESEND_API_KEY` | `re_xxxxxxxxx` | Use Resend API instead of SMTP when set |

**Gmail example:**

```env
NOTIFICATION_SMTP_HOST=smtp.gmail.com
NOTIFICATION_SMTP_PORT=587
EMAIL_FROM=Opal Line <no-reply@opalline.in>
NOTIFICATION_EMAIL=owner@opalline.in
```

Steps for Gmail: enable 2FA → create an **App Password** → store it as the SMTP
password in *Settings → Notifications* (or `.env`). Verify with the **Send test
email** button on that page.

## 5. Order email ingestion (PII recovery)

Shopify's owner **"New Order" notification email is never redacted** — point a
dedicated mailbox at it and the ERP polls every 2 minutes, merging full customer
name/phone/address into imported orders:

| Variable | Example | Purpose |
|---|---|---|
| `ORDER_EMAIL_ADDRESS` | `orders@yourdomain.com` | Mailbox that receives Shopify's new-order notification |
| `ORDER_EMAIL_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | App password (Gmail) — values with the `encV1:` prefix are treated as already encrypted |
| `ORDER_EMAIL_HOST` | `imap.gmail.com` | IMAP server |
| `ORDER_EMAIL_PORT` | `993` | IMAP port |
| `ORDER_EMAIL_FOLDER` | `INBOX` | Folder to scan |
| `ORDER_EMAIL_PROVIDER` | `mailtm` | Use `mailtm` for a mail.tm REST mailbox, otherwise IMAP |

**Steps (Gmail):**

1. Create/choose a mailbox, e.g. `orders@yourdomain.com`.
2. Shopify Admin → *Settings → Notifications*: add that address as a **staff
   order notification** recipient.
3. Gmail: enable 2FA + IMAP (*Settings → Forwarding and POP/IMAP*), create an
   App Password.
4. `backend/.env`:
   ```env
   ORDER_EMAIL_ADDRESS=orders@yourdomain.com
   ORDER_EMAIL_PASSWORD=abcd-efgh-ijkl-mnop
   ORDER_EMAIL_HOST=imap.gmail.com
   ORDER_EMAIL_PORT=993
   ORDER_EMAIL_FOLDER=INBOX
   ```
5. Restart the backend. Check *Shopify → email ingest status* / the
   **Recover PII** button on the Customers page.

## 6. WhatsApp (Cloud API)

Sends invoice/order/shipping/payment-reminder messages:

| Variable | Example | Purpose |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | `EAAG…` | Meta WhatsApp Cloud API token |
| `WHATSAPP_PHONE_NUMBER_ID` | `123456789012345` | Phone number ID from the Meta dashboard |

Steps: Meta developers → WhatsApp product → copy token + phone number ID →
paste in *System → Connections* (encrypted, editable live) or `.env`. Verify
with *Settings → Test WhatsApp*.

## 7. Razorpay payment links

| Variable | Example | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID` | `rzp_live_xxxxxxxx` | Key ID |
| `RAZORPAY_KEY_SECRET` | `xxxxxxxxxxxxxxxx` | Key secret |

Steps: Razorpay dashboard → *Settings → API keys → Generate test/live key* →
paste into `.env` (or the Connections UI). Used for payment links on invoices
and auto-reconciliation of Razorpay payments.

## 8. Backups

| Variable | Example | Purpose |
|---|---|---|
| `BACKUP_DIR` | `D:\opal-backups` | Overrides the default backup folder |
| `BACKUP_ENCRYPTION_KEY` | passphrase | Encrypts auto-backup archives when the encrypted toggle is on |
| `BACKUP_OFFSITE_*` | see below | Push the latest backup to any S3-compatible bucket after each auto-backup |

**Off-site (S3 / R2 / B2 example):**

```env
BACKUP_OFFSITE_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
BACKUP_OFFSITE_REGION=auto
BACKUP_OFFSITE_BUCKET=opal-backups
BACKUP_OFFSITE_KEY_ID=xxxxx
BACKUP_OFFSITE_SECRET=yyyyy
BACKUP_OFFSITE_PREFIX=opal-line
```

In-app toggles (*System → Backup & Restore*): auto-backup schedule (7:00 PM
IST), **encrypted archives**, **auto-email the archive** (≤20 MB attachment
budget), verify-all, cleanup keep-last-N. The daily summary + low-stock emails
reuse the notifications email (§4).

## 9. Silver rate pricing

| Variable | Example | Purpose |
|---|---|---|
| `SILVER_RATE_API_URL` | `https://api.example.com/xagusd` | Metal rate source (fallback: bundled fetchers) |
| `SILVER_RATE_API_KEY` | `key` | Bearer key for the rate API |
| `LOYALTY_ENABLED` | `true` | Turns the loyalty-points module on |

Rate lifecycle: *Silver Rate page* or the scheduler updates the rate → all
product selling prices recompute → matched Shopify variants get the new price
pushed → a sync-log entry records the change.

The scheduler's run days/time are editable per install from the *Silver Rate
page → Edit schedule* (any subset of days including weekends, plus a time in
Asia/Kolkata; default every day at 09:00). Weekend runs are allowed — MCX is
closed Saturdays and Sundays, so on those days the fetch returns the last
traded rate or fails (visible in the card's last-fetch status), and manual
entry remains available.

**One-off scheduled changes** live on the same page (*Scheduled Rate
Changes* card) behind a guided dialog: set the rate (with ±adjustments and a
product price-impact preview), pick the date & time (quick picks like
*Tomorrow 9:00 AM*, *Saturday 10:00 AM*, or any custom instant), add an
optional short note, and confirm — it is applied automatically at that
instant, like pressing "Approve & Update Shopify" at that moment. The
weekend workflow is scheduling Saturday's rate on Friday afternoon. Admin /
Super Admin only (scheduling is pre-approval), at most 20 queued; queued
rows show the rate, a countdown and the note, and each can be **edited in
place** (rate, time, note) or cancelled until it runs. Every outcome is
written to the activity log ("Scheduled Silver Rate Change Applied", with
the note). The queue is persisted (settings.scheduled_rate_changes) so
changes survive a restart, and an overdue change found at startup is applied
right away.

## 10. Paths, logging, uploads (desktop/embedded use)

| Variable | Example | Purpose |
|---|---|---|
| `APP_DATA_DIR` | `%APPDATA%\Opal Line Billing` | Desktop data root (database, env, keys) |
| `UPLOADS_DIR` | `D:\opal-uploads` | Where product images are written (default under app data) |
| `LOG_DIR` | `D:\opal-logs` | Log folder for the System Status log viewer |
| `LOG_LEVEL` | `debug` / `info` | pino level (dev default `debug`, prod `info`) |
| `APP_VERSION` | `1.0.7` | Shown on System Status |
| `DOTENV_CONFIG_PATH` | `D:\conf\opal.env` | Load `.env` from an explicit path |
| `FRONTEND_DIST` | `D:\opal\frontend-dist` | Serve the UI from an explicit folder |

## 11. Print Designer

No env vars — configured entirely in the UI (*System → Print Designer*):

1. Pick the doc tab: **Invoice / Quotation / Order / Packing slip / Pick list**.
2. Style it: header style, accent colours, fonts, page size, margins, zebra
   rows, logo, bank details, UPI QR, Packed-By/Checked-By signature lines.
3. **Save & set default** → applies to every future printout of that type.
4. **Export design** / **Import design** (`.opal-print.json`) to share designs
   or move them between machines; imports are validated server-side.

Invoices, quotations, orders, packing slips and pick lists print with product
photo thumbnails when images exist.

## 11b. Quotations: lifecycle, sending and follow-ups

A quotation moves through a real lifecycle:

```
draft ──► sent ──► approved ──► converted      (terminal)
  │        │           │
  └────────┴───────────┴──► cancelled / expired (terminal)
```

| Action | Where | Notes |
|---|---|---|
| Mark as sent / approved / cancel | Quotations page, row actions | Invalid jumps are rejected server-side |
| Email quotation | Row actions (✉) | Sends the **PDF attached**; a draft flips to `sent` automatically |
| WhatsApp quotation | Row actions (💬) | Needs `customerPhone`; degrades gracefully when WhatsApp isn't configured |
| Reopen expired | Row actions (↻) | Extends validity by 15 days and returns it to `draft` |

- **Auto-expiry:** once `Valid Until` passes, the quotation becomes `expired`
  and can no longer be converted into an invoice or an order — extend it to
  revive it. Expiry runs on every list load and in a daily sweep (10:05).
- **Follow-ups** (`GET /api/v1/sales/followups`) collect what needs chasing:
  quotations sent/approved with no decision, quotes lapsing within 2 days,
  orders stuck in the pipeline, and bookings awaiting fulfilment or advance.
  Shown on the Quotations page and, scoped per customer, on Customer 360. The
  daily sweep writes a summary into the activity log.

## 11c. Purchases: line items, stock-in, supplier ledger and input GST

`Purchase → Invoices` records what actually arrived. A purchase invoice is made
of **line items** (product / SKU / qty / weight / rate / GST per line) — the
totals are derived from those lines, and each line's quantity is **added to
stock** for the matching SKU.

| Action | Effect on stock |
|---|---|
| Record purchase | `stock += qty` per line, and cost price is re-weighted |
| Edit the lines | Old lines are reversed, then the new lines are applied |
| Cancel the invoice | The stock it added is taken back out; the lines are kept |
| Reinstate a cancelled invoice | The kept lines put their stock back |
| Delete the invoice | Removed for good, with its stock reversed |

**Stock and cost.** Buying revalues the product's weighted-average cost:

```
newCost = (stockOnHand × costOnHand + boughtQty × buyPrice) / newStock
```

A product with stock but no recorded cost simply adopts the buy price. Selling
or cancelling never revalues what remains — standard weighted-average
behaviour. The result is stored in `products.cost_price`.

**Purchase returns** (`Purchase → Returns`) carry their own line items. Stock
only moves when the return is **Received** — a pending or approved return is
paperwork. Receiving takes the goods out, and undoing the receipt (or
cancelling a received return) puts them back.

Editing a line that has already been paid against is blocked if it would drop
the invoice total below what has been paid.

**Input GST split.** Each invoice stores the supplier GSTIN. The first two
digits give the supplier's state, which is compared with the business state
(taken from your own GSTIN in `System → Settings → Business`):

| Case | Charged |
|---|---|
| Same state (or no supplier GSTIN) | CGST + SGST, half each |
| Different state | IGST, in full |

With no GSTIN anywhere the purchase is treated as intra-state, which is the
same assumption the HSN summary makes for counter sales.

**TCS (194Q).** Bullion buyers owe tax collected at source. Set the rate per
invoice (usually `1`, sometimes `0.25`/`0.5`); `0` disables it. TCS is computed
on the pre-tax value and shown on the invoice.

TCS is **not** input credit — it is collected from the supplier and deposited
on their behalf, so it is a liability in its own right (GSTR-3B "TCS
collected"). `Reports → GST` shows it as its own line and it is deliberately
excluded from ITC and from net payable. Cancelled invoices drop out of it, as
they do from the input credit.

**Supplier ledger.** `Reports → Supplier Dues` shows every supplier still owed
money, split into aging buckets (0–30 / 31–60 / 60+ days). Cancelled and fully
paid invoices are excluded, so the total is always payable.

- **Pay** opens the supplier's open invoices — tick the ones this payment
  settles and enter the amount. Allocation is oldest-first and bounded by each
  invoice's balance, so repeated partial payments settle correctly and a
  supplier can never be over-paid (the API rejects it).
- **Ledger** shows the same open invoices plus the payment history and exactly
  where each payment was allocated.
- **Send Summary** emails the payables report to the notification address.
  A summary is also emailed **automatically every day at 09:20** — one email
  covering every supplier, never one per supplier, and never more than once a
  day. Set it off with `NOTIFICATION_EMAIL`, or via *Settings → Notifications →
  Recipient email*. `POST /db/supplier-dues/sweep` runs it on demand.

Purchase orders carry their own line items (`purchase_order_items`) for what was
*ordered*; stock only moves when the purchase invoice is recorded. A purchase
invoice can be linked to its order (`order_id`), and
`GET /db/purchase-orders/:id/receipt` reconciles **ordered vs received** —
cancelled invoices are ignored, so a short shipment is not masked by a voided
invoice. The PO detail dialog shows the variance.

**Concurrency.** Recording a supplier payment locks the candidate invoice rows
and re-reads their balances inside a single transaction, so two payments racing
on the same invoice cannot both act on a stale balance and over-allocate it.

Schema additions are idempotent and applied on every start
(`purchase_invoice_items`, `purchase_order_items`, `supplier_payments`,
`supplier_payment_allocations`, plus the `paid_amount` / GST split / TCS columns
on `purchase_invoices`), so an existing install upgrades itself.

## 12. In-app Settings reference (*System → Settings*)

| Tab | Keys |
|---|---|
| Appearance | Theme: Light / Dark / System (also the 🌙 header toggle) |
| Business | Business name, GSTIN, phone, email, address; defaults: purity (92.5/95.8/99.9), making charge ₹/g, GST %, currency, invoice prefix, rate source (MCX), auto-update rate |
| Banking | Bank accounts used on prints |
| Compliance | E-invoicing mode (off / manual / automatic), gateway status, GSTIN reminder |
| Silver Rate | Source + auto-update. Rate changes by anyone other than an Admin / Super Admin **always** require approval (see below) |
| Notifications | Low-stock alerts, daily summary, Shopify order-import notices, payment reminders, test senders |
| Team | Role permissions overview + **Security card → "Log out other devices"** |
| Users & Roles | Per-user module/action permissions, activation, password resets |

### GST e-invoicing (IRN)

`System → Settings → Compliance` chooses how IRNs are generated:

| Mode | Behaviour |
|---|---|
| **Off** | Invoices are issued without an IRN (default) |
| **Manual** | Nothing leaves the app until someone clicks **Generate IRN** on the invoice |
| **Automatic** | Every newly issued invoice is sent to the gateway on save; cancelling stays manual |

An invoice shows its IRN, issue date and signed QR payload once generated, and
**Cancel IRN** voids it at the portal (irreversible) and marks the invoice
cancelled.

**Gateway.** No IRP round trip happens until credentials exist, so IRNs are
generated locally in the meantime — the whole flow (storage, QR, status, cancel)
works offline and is clearly marked `mock` in the QR payload. To go live, set:

| Variable | Purpose |
|---|---|
| `CLEARTAX_GSTIN` | Your GSTIN |
| `CLEARTAX_AUTH_TOKEN` | ClearTax API auth token |
| `CLEARTAX_SANDBOX` | `true` to use the ClearTax sandbox |

Other gateways (Zoho, a direct IRP connection with your own signing
certificate) slot in as another adapter in `backend/src/einvoice.ts` — the
routes, UI and schema do not change.

### HSN summary

`Reports → HSN Summary` groups the month's **issued invoices** by the HSN code
on each product. Taxable value takes a pro-rata share of the invoice discount,
so line totals reconcile with the invoice, and GST is split into CGST/SGST or
IGST by comparing the customer's state with the business address (a blank
customer state is treated as intra-state, which is how counter sales are
charged). Products with no HSN on file land in a clearly-labelled
**Unclassified** row — worth clearing before filing.

### Silver rate approval

Rate changes made by an **Admin or Super Admin** apply immediately. A change
submitted by **any other role** (e.g. Manager) is queued as a *pending request*
and the rate stays unchanged until an Admin / Super Admin approves it —
rejecting keeps the old rate. This is enforced in the backend for every entry
point, including the legacy `/api/v1/silver/update` route, and cannot be
switched off from Settings. `POST /api/v1/silver/auto-rate/fetch-now` applies the
live MCX spot rate and reprices products, so it is likewise restricted to
Admin / Super Admin. Approvers see a pending-count badge in the header and a
"Rate Change Approvals" panel on the Silver Rate page; every submission,
approval and rejection is written to the activity log with the actor's name.

## 13. Rate limiting (operational notes)

- Login: 30 attempts / 15 min / IP; password reset: stricter; email endpoints:
  30/hour. Counters are **persisted in Postgres** (`rate_limit_hits`,
  `login_attempts`) and survive restarts.
- Behind a proxy, set `TRUST_PROXY` (§2) so per-IP limits see real client IPs.
- Dev tip — clear the budget after heavy testing:
  ```sql
  DELETE FROM rate_limit_hits;
  DELETE FROM login_attempts;
  ```
- **Cannot log in with the documented `admin` / `Opal@2026`?** The known
  credential is only seeded on a *fresh* (empty) database — a database
  created earlier keeps its original admin password. Reset it without
  touching any data (also clears that account's lockout counters):
  ```bash
  npm run auth:reset                    # admin / Opal@2026
  SEED_ADMIN_PASSWORD=Other#1 npm run auth:reset
  npm run auth:reset -- someusername    # a different account
  ```
  Do **not** use `npm run db:seed` for this — it truncates every table.
- **Account lockout (Settings → Security → Login lockout).** After a set
  number of failed sign-in attempts an account is locked for a set time.
  Both numbers are **editable from Settings** next to the switch — *Attempts
  before lockout* (1–50, default 5) and *Lockout duration (minutes)*
  (1–1440, default 15) — and the values are stored per install in the
  settings row (`lockout_threshold`, `lockout_duration_minutes`); the server
  clamps anything out of range, so a bad value can never disable protection
  or lock accounts out for a week. The product ships with lockout
  **disabled** (testing default) — failed attempts never lock an account
  until an Admin / Super Admin switches it on from Settings. Each install
  owns the setting (dev stack and desktop app are separate), every
  successful use is audited in the activity log, and switching it off starts
  counters fresh on the next attempt.
- E2E tests abort with a clear 429 message when the login budget is exhausted.

## 14. Quick-reference: full example `backend/.env`

```env
# ── Core ────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:S3cret@localhost:5432/opal_line
PORT=47191
NODE_ENV=development

# ── Security ────────────────────────────────────────────────────────────
ENCRYPTION_KEY=            # auto-generated on first run
CSRF_SECRET=               # auto-generated on first run
TRUST_PROXY=               # only behind a reverse proxy

# ── Shopify (or set in System → Connections) ────────────────────────────
# SHOPIFY_STORE_URL=your-store
# SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxx
# SHOPIFY_API_VERSION=2025-10
# SHOPIFY_WEBHOOK_SECRET=some-random-hex
PUBLIC_BASE_URL=           # https://erp.example.com → auto-registers webhooks

# ── Order email ingestion (dev-store PII recovery) ──────────────────────
# ORDER_EMAIL_ADDRESS=orders@yourdomain.com
# ORDER_EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx
# ORDER_EMAIL_HOST=imap.gmail.com
# ORDER_EMAIL_PORT=993
# ORDER_EMAIL_FOLDER=INBOX

# ── Notification email ──────────────────────────────────────────────────
NOTIFICATION_SMTP_HOST=smtp.gmail.com
NOTIFICATION_SMTP_PORT=587
EMAIL_FROM=Opal Line <no-reply@opalline.in>
NOTIFICATION_EMAIL=owner@opalline.in
# RESEND_API_KEY=re_xxxxxxxx

# ── WhatsApp Cloud API ──────────────────────────────────────────────────
# WHATSAPP_ACCESS_TOKEN=EAAG...
# WHATSAPP_PHONE_NUMBER_ID=123456789012345

# ── Razorpay ────────────────────────────────────────────────────────────
# RAZORPAY_KEY_ID=rzp_test_xxxx
# RAZORPAY_KEY_SECRET=xxxx

# ── Backups ─────────────────────────────────────────────────────────────
# BACKUP_DIR=D:\opal-backups
# BACKUP_OFFSITE_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
# BACKUP_OFFSITE_REGION=auto
# BACKUP_OFFSITE_BUCKET=opal-backups
# BACKUP_OFFSITE_KEY_ID=xxxxx
# BACKUP_OFFSITE_SECRET=yyyyy
# BACKUP_OFFSITE_PREFIX=opal-line

# ── Pricing ─────────────────────────────────────────────────────────────
# SILVER_RATE_API_URL=https://api.example.com/xagusd
# SILVER_RATE_API_KEY=xxxxx
# LOYALTY_ENABLED=true

# ── Logging / paths ─────────────────────────────────────────────────────
LOG_LEVEL=debug
# LOG_DIR=D:\opal-logs
# UPLOADS_DIR=D:\opal-uploads
```
