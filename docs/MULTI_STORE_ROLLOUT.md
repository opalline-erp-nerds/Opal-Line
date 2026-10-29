# Multi-store rollout — implementation plan

## Status

- **Phase 1 (Transfer integrity) — implemented.** Server-minted transfer
  numbers, canonical location IDs with a safe legacy backfill, `FOR UPDATE`
  locking on every transition, and one transaction per stock movement + status
  update. Coverage: `backend/src/stockTransfers.test.ts` (scratch database,
  `DASHBOARD_TEST_DATABASE_URL`) plus the transfer backfill assertions in
  `backend/src/db/upgrade.test.ts`.
- **Phases 2–4 (store access model, shared-computer behaviour, rollout &
  migration) — planned.** Not implemented yet by design; see the workstreams
  below.

## Goal

Support several computers using the same store and additional stores using one
authoritative Opal Line database. Store-level stock remains separate; authorised
users can view chain-wide stock.

## Architecture decision

Use one central backend + PostgreSQL instance for the business, and have all
client computers connect to that service. Do not treat multiple independently
installed Electron instances with their own local databases as synchronised
clients.

The repository documents a self-hosted/Docker deployment for a central web
stack. Prefer that topology for the first rollout: the server owns PostgreSQL,
encryption keys, scheduled jobs, backups and Shopify integration; staff
computers access the same application over the store network or a secured
remote connection. Do not expose PostgreSQL directly to client computers.

The current installed Electron mode is intentionally loopback-oriented and
provisions local PostgreSQL. It should not be switched to shared-DB mode by
only changing `DATABASE_URL`: each desktop backend also has its own encryption
key and background workers, so doing so could cause unreadable encrypted
settings and duplicate scheduled work.

## Workstreams

1. **Transfer integrity (Phase 1 — done)**
   - Generate transfer numbers on the server, not from the number of rows
     loaded in a client.
   - Persist canonical location IDs for new transfers, migrating legacy
     name-valued rows through an idempotent bootstrap upgrade that leaves
     unresolvable references untouched.
   - Lock transfer rows during dispatch/receive/cancel so concurrent requests
     cannot apply a transition twice.
   - Write stock ledger movements through the same transaction as the transfer
     status update.
   - Scratch-database integration coverage for duplicate/concurrent transitions
     and stock balances.

2. **Store access model (next phase — not in the codebase yet)**
   - Add explicit user-to-location assignment and a deliberate chain-wide
     permission for authorised roles.
   - Enforce scope on the backend for location lists, stock levels, transfers,
     product stock summaries, sales/purchases and reports; frontend hiding is
     not a security boundary.

3. **Shared computer behaviour (planned)**
   - Confirm every client uses the same backend origin and database.
   - Make screens refresh after writes from other clients, with polling or
     server events where necessary.
   - Test simultaneous sales, purchases, stock counts and transfers against the
     same scratch database.

4. **Rollout and data migration (planned)**
   - Back up each current database and inventory ledger before migration.
   - Select one authoritative source database; reconcile stock by SKU and
     location before importing other data.
   - Run the upgrade path and reconciliation report on a copy first.
   - Never merge independent database files blindly or add opening stock twice.

## Acceptance criteria

- Transfer numbering, locking and ledger atomicity hold — **met by Phase 1**:
  - A transfer number is minted on the backend under the create transaction;
    client counts can never produce one.
  - Duplicate dispatch/receive/cancel requests cannot move stock twice.
  - A failed transfer transaction leaves both the transfer status and stock
    ledger unchanged.
  - Existing installs upgrade without losing existing transfer history.
- Still to prove in later phases:
  - Two clients see the same product catalogue and latest committed stock.
  - Store A and Store B have independent balances for the same SKU.
  - Store-scoped users cannot read or mutate another store's data by changing
    request parameters.
  - A chain-wide user can inspect stock by location and total stock.
  - A transfer changes stock only on dispatch and receive.
  - Concurrent sales cannot oversell one location.
