# Progress Log

## CURRENT TASK (2026-10-26) — Silver Rate page redesign + update-pipeline tracker — DONE

### A. Silver Rate Management page redesign — committed `c45f9f2`

- `frontend/src/pages/SilverRate.tsx` rebuilt (1,739 lines) + `frontend/src/pages/SilverRate.test.tsx`. Every API call, permission gate (`canApprove` / `isApprover`) and dialog preserved — UI and component structure only:
  - amber **"Rate source not configured"** banner with an *Open settings* link at the top (was grey text in the auto-rate card);
  - **hero card** (large ₹rate, coloured change chip, last updated, inline SVG sparkline of the last 5 rates) beside a **status card** (Shopify sync / products repriced / pending approvals);
  - **three compact cards in one row** (Approvals · Scheduled · Auto rate), badge + one line + one action, with the expanded approvals and queued-schedule lists below only when non-empty (Auto rate keeps *Fetch now* / *Edit schedule* in a ⋯ menu);
  - **"Update Silver Rate" and "Schedule rate change" merged into one drawer** (Apply now / Schedule toggle, rate + chips −1/−0.5/+0.5/+1/Reset, date+time only in Schedule mode, summary grid, *Review prices* / *Review and schedule*);
  - **history table** Date | Rate (old → new) | Change | Approved by | Shopify | Restore (hidden on the current row) in an `overflow-x-auto` wrapper; the "Total value shift" / "Avg price change" tiles are gone.
- **[run]** `tsc -b --force` 0, oxlint 0 warnings on both files, frontend tests pass, encoding check pass.
- **[run]** live click-through on the dev stack (Vite 47195 + backend 47191, Chromium): drawer chips `160 → +1 → 161.00 → −0.5 → 160.50 → Reset → 160`, review step, Schedule mode, schedule review, 390 px mobile (no page overflow; history scrolls 720 px inside a 356 px viewport). Screenshots in `test-results/silver-rate-visual/` (gitignored). Two fixes came from the screenshots: the amber banner stacks its button on phones, and the sparkline is no longer hidden below `sm`.

### B. Update-pipeline tracker + rate-update history log — committed `57cd1e9`

Built around the real flow (read out to the user first): every entry point (direct update, approved staff request, auto fetch / scheduler) funnels into `applySilverRate` (`backend/src/shopify.ts`), which runs **optional Sync catalog from Shopify → Save new rate → Reprice products → Match to Shopify → Push prices to Shopify**, stopping at the first failure. Before this, only the final `sync_status` was stored.

User decisions: show **5 steps + the optional "Sync catalog" step**; **persist a `step_log` jsonb** on `silver_rates`; date filter **client-side** over the loaded rows.

- `backend/src/db/schema.ts` — `SilverRateStepRecord` / `SilverRateStepLog` + `stepLog: jsonb('step_log')` on `silverRates`; `bootstrap.ts` **and** `migrate.ts` each add one idempotent `ALTER TABLE silver_rates ADD COLUMN IF NOT EXISTS step_log jsonb`. The column is **already applied to the dev DB** (`127.0.0.1:47194/opal_line`, via `npx tsx src/db/migrate.ts`; that run applied every statement then lingered past the tool's 180 s timeout — all statements are `IF NOT EXISTS`, safe to re-run).
- `backend/src/shopify.ts` — `applySilverRate` records every step (key/label/status/startedAt/finishedAt/detail/error) and persists it with `sync_status` on **this run's** row (id captured at insert; the old code re-queried "the latest row"). The reprice loop is wrapped: a throw marks the step failed, **releases the stuck `running: true` progress flag** (the drawer used to spin forever), stops before the Shopify steps and returns partial counts. Sync-first and `recordAudit` are guarded the same way, and the match/push catch now blames the step that actually failed — **[run]** backend suite 447 tests, 424 pass, 0 fail, 23 skipped (DB-gated).
- `frontend/src/lib/silverRatePipeline.ts` (new, pure) + `.test.ts` — phase → step mapping, result/step_log → steps, `plannedSteps`, `pipelineSucceeded`. The tests caught a real bug: steps after a failure were being marked done — fixed so a failure stops the run — **[run]** 9/9 lib tests, frontend 97/97.
- `frontend/src/components/dashboard/silver-rate-pipeline.tsx` (new) — `SilverRatePipeline` (green ✓ / red ✗ with the error / spinner / grey pending, optional "Complete" row), `StepDots`, `RateUpdateDetailDialog` (who/when/old→new/change/source/Shopify + steps with timestamps + repriced/matched/pushed/skipped counts, degrading to a note for rows written before step tracking), `ViewUpdateButton`, `SyncStatusBadge`.
- `frontend/src/pages/SilverRate.tsx` — the review step lists "This update will" and that checklist goes live ("Update pipeline") while the apply runs; the result screen renders the final pipeline + Complete; the history card gained **From/To date filters** (IST days, client-side, Clear, "No updates in this date range."), a **Steps** dot column and a **View** action per row.
- **[run]** live click-through: 6-row history, `from=2026-10-26` → 3 rows, a 2020 range → empty-range message, Clear → 6 rows; View dialog opens with the details grid and the legacy fallback note; review step shows the 5-step checklist. Screenshots in `test-results/silver-rate-visual/log-*.png`.

Commits on local `master`: `c45f9f2` (redesign) → `780feb9` (**the user's** product_variants upgrade, committed first so `bootstrap.ts` could then be committed cleanly) → `57cd1e9` (pipeline) → `22e862b` (this log).

### Open follow-up from this task

1. **One real rate update with the new code** — no row carries a `step_log` yet, so the View dialog still shows the legacy note for all six rows. A run at the current rate with sync-first off would reprice to identical prices so `push` is skipped (**no Shopify writes**) — needs the user's OK. The user's own ₹160 → ₹161 at 10:18 UTC today predates the backend, so their **next** update is the first that will log every step.
2. Dev stack still up: Vite 47195 (background process), backend 47191 on `tsx watch` (it reloaded the new code).

---

## Pending work (priority order)

1. **Catalogue damage** — read-only report first, then wait for approval: which Shopify store the 15:17 sync pulled from, before/after counts from the pre-copy backup + `sync_logs`, restore plan for real products/stock/49 orphaned `stock_levels` rows, then make the sync non-destructive. **No DB writes until approved.**
2. **Approved fixes A–E (after #1)** — voided-order count consistency, "Last sync" from `sync_logs`, GST basis subtitle, orphan `stock_levels` cleanup (show → back up → delete), commit `backend/src/shopify.ts`.
3. **Total Stock (Weight) sanity** — NOT STARTED.
4. **Outstanding point-in-time "As of now"** — NOT STARTED.
5. **Fair comparisons (same elapsed prior period)** — NOT STARTED.
6. **Add/Edit Product rebuild** — handed to the user's team; the revoked work left dev-DB objects behind (dev `opal_line`: `product_variants`, `sku_counters`, `product_barcode_seq`, `products.has_colours`, 89 default variant rows, plus a throwaway `opal_line_test`) that still need a keep/drop decision. The desktop `opal_line` DB (47193) was never touched.
7. **Docs upkeep** — follow `docs/README.md` ("Keeping Documentation Updated") when the matching code changes.

Known follow-ups recorded but not fixed: UTC-vs-local day-boundary skew in `recordActivity`/`recordAudit`; header activity feed is today-only; app-bootstrap fetches (`silver-rate-provider`, `auth-provider` user preload) ignore role and 403 for dashboard-only users.

---

## Completed work (archived 2026-10-26 — detail lives in git history and the older session logs)

- **"Today/This Week shows no data"** — investigated read-only: not a range-code bug, the data simply stops at 2026-10-10; regression test `dashboardTodayRange.test.ts` added.
- **Dashboard work (Items 0–6, committed `e9238b9` / `7f72a03` / `d305e21` / `41fed31` / `8210ceb` / `73b3441`)** — date-range lib; invoice weight snapshot + backfill; low-stock default reorder level 10; gross-profit cost basis with a "based on X of Y invoices" caption; totals reconciliation (`NOT_VOIDED` also excludes `payment_status='refunded'`); consistent card subtitles; Payment Status as four segments; Silver Rate History card with 7/30/90 toggles + backfill endpoint; Financial Analytics (Net Revenue, Receivables, Income/Expense, Top Expense); widget checks (admin-only Security gate, Recent Activities reading the log table its writers use, aging net of payments); full e2e 58/60 pass + signed desktop build.
- **New code notes (N1–N8)** — Shopify silver-rate fallback; dashboard summary order/invoice counts; the e2e dashboard error-state spec; scratch-DB-gated test contract (`DASHBOARD_TEST_DATABASE_URL`); Shopify unit tests made hermetic; `db:seed` refuses the desktop DB and any populated DB without `--force`; `scripts/dev.mjs` provisions `opal_line_dev` so dev never shares the desktop database; `backend/.env` is excluded from git and the installer (verified, no change needed).
- **Frontend test plumbing** — `frontend/scripts/test.mjs` runs tsx with the `jsx-shim` preload (tsx loses `jsx: react-jsx` against the solution-style tsconfig); test files live in `tsconfig.test.json`.
- **Backend test isolation** — `--test-concurrency=1` (scratch-DB suites were racing on "today"-dated invoices).

---

## Environment notes

- `backend/.env` targets the **dev** cluster `127.0.0.1:47194/opal_line`; the desktop app owns `opal_line` on 47193 and the two run side by side.
- `backend/.env`'s `APP_DATA_DIR`/`LOG_DIR` pointed at another machine's Windows profile (stale), which is why credential decryption failed; `node scripts/dev.mjs` rewrote them on 2026-10-17. Values never printed.
- README "Default seeded login: admin / Opal@2026" may be stale (the desktop first-run generates a random password shown once).
- ~60 silent `.catch(() => …)` handlers remain in the backend (some deliberate per ROADMAP).
- Mutating e2e/API requests need `X-CSRF-Token` matching the `XSRF-TOKEN` cookie (double-submit); `/auth/login` is exempt.
