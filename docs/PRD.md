# Product Requirements — Opal Line Billing

**Version:** 1.0.22 · **Owner:** Opal Line Jewels LLP · **Status:** living
document

This document describes **what the product is for and what it must do**. It is
the answer to "why does this exist, and what would make it fail?" — not a
description of how it is built (that is [ARCHITECTURE.md](./ARCHITECTURE.md))
or how it looks ([DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)).

---

## 1. Problem

A silver jewellery retail shop runs on three disconnected tools: a billing
application that prices by a metal rate the shop looks up manually, a
spreadsheet that tracks stock across two locations, and a Shopify store that
knows what was sold but not what it cost.

The consequences are concrete:

- **Pricing errors.** A rate moves daily. If the rate applied to an invoice is
  the rate at print time rather than the rate at sale time, every invoice
  issued after a rate change is wrong, and reconciling them means rewriting
  history.
- **Stock that is believed rather than known.** The Shopify store and the
  shop's counter disagree, and neither is authoritative.
- **No margin visibility.** Product costs live in a purchase spreadsheet.
  Nobody knows which products actually make money.
- **Compliance by hand.** GST returns, HSN summaries and TDS are assembled
  manually from invoices.

Shopify was supposed to solve the last two. It does not: a Shopify shop knows
what it sold, not what silver cost the shop, not what the making charge was,
and not what the supplier was paid.

---

## 2. Product statement

> **Opal Line Billing is the billing and stock system of record for a silver
> jewellery shop, with Shopify as a channel rather than as the source of
> truth.**

The ERP owns the price, the cost, the stock and the books. Shopify owns the
storefront and the customer-facing catalogue. Sync is bidirectional where it
is safe, and ERP-led where it is not.

---

## 3. Users

| User | Needs | Typical session |
|---|---|---|
| **Owner / Super Admin** | The whole business on one screen; control of who may do what; the books are right | Morning dashboard, month-end reports |
| **Counter staff** | Ring up a sale fast, print it, take the payment | Minutes, standing at a counter |
| **Store / inventory manager** | Stock is accurate across locations; purchases are recorded | Hours, daily |
| **Accountant** | Books balance; GST and TDS are ready | Weekly |

The product is used on shop hardware, in daylight, often while a customer
waits. That sets the performance bar: **a screen the counter trusts must open
fast**, which is why dialogs are memoised and animations are capped at
120 ms.

---

## 4. Scope

### 4.1 In scope

| Module | Capability |
|---|---|
| **Billing** | Invoice from a rate-priced catalogue, GST, HSN, making charges, credit notes, returns, quotations with validity, printable and downloadable as PDF, UPI QR on the invoice |
| **Pricing** | A daily silver rate with history, an approval gate for staff-initiated changes, an automatic rate schedule, and repricing of open invoices when the rate moves |
| **Shopify sync** | Orders, products (incl. collections and sanitised descriptions), customers, inventory, price; push tools; sync logs; a comparison view for reconciliation |
| **Supply chain** | Order pipeline, bulk packing slips and pick lists with product photos, dispatch and shipments, bookings, purchase orders, purchase invoices with stock-in, supplier dues and a supplier payment ledger, stock counts with a Shopify round-trip |
| **Inventory** | An append-only stock ledger with a balance per location, transfers (dispatch → receive → cancel), stock counts recorded as adjustments, barcode labels, low-stock alerts, stock running |
| **Accounts** | Double-entry bookkeeping (trial balance, P&L, balance sheet, journals), bank accounts, expenses, payments, receivables and payables aging |
| **Reporting** | Business, GST, HSN, sales analysis, day book, inventory and dues reports |
| **Print** | A print designer for five document types with saved templates, import/export, and per-document defaults |
| **Platform** | Role-based access, per-user permissions, audit and activity logs, encrypted backups with off-site push, notifications (e-mail, WhatsApp), a system status page |

### 4.2 Explicitly out of scope

- **Multi-tenant / SaaS hosting.** One shop, one database, one install.
- **A marketplace or a customer-facing storefront.** Shopify is that.
- **Payroll, HR, CRM campaigns.** Not what a jewellery shop's owner asked for.
- **Manufacturing / job costing.** The product tracks batches and BOMs as
  catalogue data; it does not run a factory.

---

## 5. Functional requirements

### 5.1 Billing

**FR-B1 — Rate-priced line items.** A line item's amount is derived from
`net weight × quantity × (silver rate + making charge)`, plus tax, less
discount. The rate used is **stored on the line item**.

**FR-B2 — History is immutable.** A later rate change must never alter an
invoice that was already issued. The rate is captured at the moment of
billing and stored on the item.

**FR-B3 — GST.** Line and invoice totals split into CGST/SGST (intra-state)
or IGST (inter-state), computed from the supplier's and the buyer's state.
The invoice prints the GSTIN, the HSN summary and the amount in words
(Indian numbering).

**FR-B4 — Quotation → invoice.** A quotation carries a validity term and
line items; converting it produces an invoice that inherits the lines. A
quotation that has expired is visibly expired.

**FR-B5 — Credit notes.** A sales return produces a credit note that reverses
stock and adjusts receivables.

**FR-B6 — Printing.** Every invoice, quotation, credit note and order can be
printed from a template and downloaded as a PDF. The printed output always
uses the light palette.

**FR-B7 — Payments.** A payment can be recorded against an invoice, in full
or in part; the invoice's payment status follows.

### 5.2 Silver rate

**FR-S1 — One rate per day, with history.** Every rate change is recorded with
who changed it, when, and why.

**FR-S2 — Approval gate.** A non-admin submitting a rate change creates a
pending request; an approver accepts or rejects it with a note. The rate does
not change until it is approved.

**FR-S3 — Scheduled rate.** The rate can be fetched automatically on a
schedule (chosen weekdays and a time), and a change can be queued for a future
date.

**FR-S4 — Repricing.** When the rate moves, open (not yet paid) invoices can
be repriced. Issued invoices are never touched.

### 5.3 Shopify

**FR-H1 — Import.** Orders, products, customers, inventory levels and prices
import from Shopify on demand.

**FR-H2 — Push.** Products, prices and inventory push to Shopify on demand,
or automatically on a schedule.

**FR-H3 — Catalogue fidelity.** Collections attach as pipe-separated titles
(`Rings | Home page`). Descriptions are sanitised. Images pushed to Shopify
are strictly the ones uploaded in the ERP — a Shopify round-trip URL is never
re-sent.

**FR-H4 — Reconciliation.** A comparison view shows what differs between
Shopify and the ERP, so a mismatch is diagnosable rather than mysterious.

**FR-H5 — PII recovery.** On dev/trial Shopify stores the API redacts customer
name and address. The ERP fills them from the order e-mail (IMAP ingest) or a
Shopify Flow webhook. Both paths are documented in
[shopify-flow-webhook.md](./shopify-flow-webhook.md).

**FR-H6 — Logs.** Every sync run records what it did, what it changed and any
error, and the log is readable in the app.

### 5.4 Supply chain

**FR-C1 — Pipeline.** An order moves through stages (new → confirmed → packed
→ dispatched → delivered). Stages can be moved one at a time or in bulk, by
drag or by selection.

**FR-C2 — Fulfilment documents.** Packing slips and pick lists can be
generated in bulk, with product photos, and printed.

**FR-C3 — Purchases.** A purchase order can raise its own purchase invoice.
A purchase invoice records line items, the input GST, and the stock-in it
causes.

**FR-C4 — Supplier ledger.** Payments to suppliers are recorded and allocated
against purchase invoices; dues age like receivables.

**FR-C5 — Cost.** Stock-in sets a weighted-average cost per SKU, so inventory
value and margins are computed, not guessed.

### 5.5 Inventory

**FR-I1 — The ledger is append-only.** Every stock change is a movement with a
resulting balance. A stock count is an **adjustment**, never a silent
overwrite.

**FR-I2 — Locations.** Sales, purchases, counts and transfers all post to the
location where they happened, and every reversal resolves back to it.
Availability is checked at that location, not against the chain-wide total.

**FR-I3 — Transfers.** A transfer follows dispatch → receive → cancel.

**FR-I4 — Visibility.** The stock history for a product explains every number
on screen.

**FR-I5 — Backfill.** An installation that predates the ledger is backfilled
with dated opening movements on boot.

### 5.6 Accounts and reporting

**FR-A1 — Double entry.** Journal entries, trial balance, P&L and balance
sheet must balance at any time.

**FR-A2 — Aging.** Receivables and payables are bucketed by age, and the
bucket can be drilled into the invoices behind it.

**FR-A3 — GST and HSN.** GST reports and an HSN summary are derived from the
invoice data, not entered by hand.

**FR-A4 — One basis.** Every widget and report states whether its figures are
inclusive or exclusive of GST. Totals must reconcile with each other.

### 5.7 Platform

**FR-P1 — Permissions.** Nine modules × four actions, resolved per user, with
the super admin as the only role that ships with access.

**FR-P2 — Audit.** Every mutation is attributable: who, what, when, from
where.

**FR-P3 — Backups.** A local backup on a schedule, optional off-site push, and
a restore path. Backups are encrypted with the app's master key.

**FR-P4 — Health.** A system status page shows database health, latency,
pool statistics, port occupancy and the server log tail.

**FR-P5 — Sessions.** A user can sign out other devices; a forced password
change locks everything else until it is done.

---

## 6. Non-functional requirements

| ID | Requirement | How it is met |
|---|---|---|
| **NFR-1** | A counter can bill a customer without waiting | Dialogs open in ~120 ms; tables are memoised; a dialog-open stall of ~370 ms was measured and fixed |
| **NFR-2** | The app runs on a shop PC with no admin rights | The installer bundles its own runtime and PostgreSQL; nothing is installed machine-wide |
| **NFR-3** | The dev stack and the installed app never interfere | Separate clusters, data dirs, encryption keys and sessions; a dedicated port block (47191–47198) |
| **NFR-4** | Data survives an app update | An upgrade-path regression test proves an existing install gains new tables |
| **NFR-5** | Secrets are never stored in plain text | AES-256-GCM at rest; the credential scan runs in CI over the tree and the whole history |
| **NFR-6** | The interface is readable in a bright shop | WCAG AA contrast enforced in CI across light, dark and print |
| **NFR-7** | A printer works out of the box | Electron print bridge with a native chooser; UPI QR rendered on the invoice |
| **NFR-8** | The product works offline | The installed app needs no internet except for Shopify and e-mail |

---

## 7. The design principles behind the requirements

1. **The ERP is the source of truth for money and stock.** Shopify is a
   channel. A sync that would silently delete or overwrite an ERP product must
   ask first.
2. **Capture the fact at the moment it happens.** The rate, the weight and
   the cost are stored on the document, so history never needs recomputing.
3. **The ledger is append-only.** Corrections are entries, not edits.
4. **Permissions are decided by the owner, not by a template.** The product
   ships with no access for any role except Super Admin.
5. **Print is a first-class output, not an afterthought.** In a jewellery shop
   half the paperwork is a printed document.
6. **Fail visibly.** A failed load must never render as "no data".

---

## 8. Success criteria

### 8.1 For the shop

| Criterion | Measure |
|---|---|
| Billing is correct | Every issued invoice prices from the rate captured at billing time; no manual rate correction needed |
| Stock is known | The stock balance on screen matches the shelf, per location, without a stock count |
| The books balance | Trial balance, P&L and balance sheet balance at any time |
| Compliance is ready | GST and HSN reports are produced from the data, not retyped |
| Shopify is reconciled | The comparison view shows no unexplained difference after a sync |

### 8.2 For the product

| Criterion | Measure |
|---|---|
| It installs anywhere | A clean machine, no Node.js, no PostgreSQL, no admin rights → a running app |
| It upgrades safely | The upgrade-path test passes; no schema change requires a manual step |
| It is secure by default | Loopback-only binding, per-user permissions, encrypted secrets, no committed credentials |
| It is fast enough | A counter never waits on the app |
| It is verifiable | Every bug fix has a test; the whole suite runs in CI |

---

## 9. Constraints

| Constraint | Consequence |
|---|---|
| The desktop app runs over plain HTTP on loopback | The session cookie cannot be `Secure` |
| The master key lives on the same disk as the data | Losing it loses the encrypted secrets; it must be backed up with the database |
| Money is stored as numeric columns, not integer paise | Rounding happens at the display and PDF layer |
| Shopify's API redacts PII on trial stores | The order-e-mail ingest and Flow webhook exist to recover it |
| Express 5 / Tailwind 4 / TypeScript 7 are all recent majors | Upgrades need the migration notes in [DEVELOPING.md](./DEVELOPING.md) |
| The backend is CommonJS, the frontend is ESM | Do not "unify" them casually |

---

## 10. Release history and roadmap

Release notes for shipped versions live in this directory:

- [release-notes-v1.0.11.md](./release-notes-v1.0.11.md)
- [release-notes-v1.0.10.md](./release-notes-v1.0.10.md)
- [release-notes-v1.0.9.md](./release-notes-v1.0.9.md)

The planned work is tracked in [ROADMAP.md](../ROADMAP.md).

---

## 11. Change log for this document

| Date | Change |
|---|---|
| 2026-10-20 | First consolidated PRD written from the shipped v1.0.22 behaviour |
