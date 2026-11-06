# Opal Line Billing v1.0.26

The largest feature release since the 1.0 line. Shopify orders, returns and
refunds now live in the ERP instead of being looked up in two places, and
loyalty points are driven by the same order and refund events.

No existing data is lost: the database upgrade is additive and runs in place on
start, so an existing installation keeps its orders, products, customers and
settings.

## 1. Shopify order pipeline

Shopify orders now arrive through a single pipeline instead of ad-hoc imports.

- Webhooks for `orders/create`, `orders/updated`, `orders/edited`, `orders/paid`,
  `orders/cancelled`, `orders/fulfilled`, `fulfillments/create`,
  `fulfillments/update` and `refunds/create` all feed the same handler.
- Every order is reduced to one stage — open, unfulfilled, in progress,
  partially fulfilled, fulfilled, archived or cancelled — so the board, the
  badges and the reports agree.
- Both Shopify payload shapes are understood. REST (`partially_fulfilled`) and
  GraphQL (`PARTIALLY_FULFILLED`) spellings normalize to one stored value.
- Each real transition is appended to `order_events`, giving an audit trail of
  what Shopify reported and when.
- Applying the same snapshot twice writes nothing the second time, so a
  duplicated webhook cannot double-count a sale or a shipment.
- Orders can be refreshed on demand, and
  `POST /api/v1/orders/pipeline/reconcile` re-reads recent orders from Shopify
  to repair anything a missed webhook left behind.

## 2. Shopify two-way order synchronization

- **ERP → Shopify:** create a fulfilment (per line, only up to the quantity
  Shopify still has outstanding), update tracking, cancel an order, archive an
  order.
- **Shopify → ERP:** the webhooks above plus reconciliation bring financial
  status, fulfilment status, tracking, cancellations and closures back into the
  order record.
- Cancelling from the ERP restores local stock exactly once, even if the action
  is retried.
- A payload that carries no tracking number never blanks a shipment already
  known locally.
- Archiving an order in Shopify is not treated as fulfilment, and a partial
  refund no longer makes a shippable order look fully refunded.

## 3. Returns management

A dedicated returns workflow, backed by the new `sales_returns` table.

- Create a return against a sales order, choosing SKUs and quantities. The
  returnable quantity is calculated from the order minus earlier returns that
  are still open or completed, so the same piece cannot be returned twice.
- Receive and inspect what actually came back: received, accepted and damaged
  quantities are recorded per line.
- Accepted stock is restocked; damaged stock is not.
- Returns move through explicit statuses, and the API rejects a transition that
  is not allowed rather than silently accepting it.
- The Returns screen lists returns with their order, customer, reason, value,
  refund status and received items, and shows the order's refund history.

## 4. Refund management

- Refunds are stored in `refunds` and `refund_line_items`, linked to the return
  and the Shopify order.
- A refund can be recorded per line with its own amount, method and reason.
- Each refund carries an idempotency key, so retrying a failed request cannot
  create a second refund.
- Every Shopify interaction is logged in `refund_sync_events`, which is what the
  Retry action reads.

## 5. Shopify refund synchronization

- Before refunding, the ERP asks Shopify which lines and amounts are actually
  refundable and shows that preview, so a refund is never built on a stale
  order.
- Refunds created in the ERP are pushed to Shopify through the Admin GraphQL
  API and recorded locally in one flow.
- Refunds created in Shopify arrive through `refunds/create` and are matched
  back to the local order.
- Refunds can be pulled for a single order on demand, and a failed push can be
  retried from the recorded event.
- The order's financial status and its loyalty balance follow the refund.

## 6. Loyalty points integration

- Points live in a ledger (`loyalty_transactions`) that records the source, an
  external reference, an expiry date and the balance after each entry.
- A paid Shopify order earns points; a refund or cancellation reverses the
  points it earned.
- Points can be redeemed at the counter or adjusted by an administrator, and
  every movement appears in the customer's history.
- Earning rules and redemption settings are configurable in the Loyalty screen,
  and expired points are cleared by a scheduled job rather than on page load.
- The customer's balance is pushed to a Shopify customer metafield, with a sync
  status view and a retry for failed pushes.
- `GET /api/v1/loyalty/reconcile` checks the ledger against the stored balances.

## 7. Customer management improvements

- Loyalty balance and history are resolved by customer id instead of customer
  name. Shopify-created customers with a blank or duplicated name now show the
  correct balance.
- The customer detail dialog has an Edit action, so a customer can be corrected
  without closing the view and hunting for the row.
- Customer 360 reflects the new orders, returns and loyalty data.
- Shopify customer sync now writes against the real schema, including customers
  created on the Shopify side.

## 8. Database and backend improvements

- New tables for the features above: `sales_returns`, `refunds`,
  `refund_line_items`, `refund_sync_events`, `order_events` and
  `loyalty_transactions`, plus the Shopify order columns on `sales_orders`.
- All of it is created by idempotent bootstrap DDL, so an existing database
  upgrades in place on start. The upgrade-path test runs against a real
  PostgreSQL in CI to prove an older database reaches the current schema.
- Order pricing accepts weight per piece, total line weight and making charge
  from the order form. A value entered on the form round-trips through save and
  refresh; the catalogue fills in only when the form sent none, and an unknown
  line never invents a weight.
- Hosted mode refuses to start on a non-loopback host without its encryption and
  CSRF secrets, and the session cookie's `Secure` flag is opt-in for those
  deployments.
- Product images go to Supabase Storage when it is configured and stay on local
  disk otherwise, so the desktop app is unchanged.
- The SPA fallback resolves the built frontend directory reliably.
- A staging Render blueprint and hosted environment template document the
  hosted setup; `DEPLOYMENT.md` covers the new variables.

## 9. Bug fixes and reliability improvements

- Duplicate and replayed Shopify webhooks are ignored inside the replay window,
  and an id is released again when its processing fails so the retry works.
- Fulfilment allocation enforces Shopify's remaining quantities instead of
  trusting the request.
- A partial refund keeps the order shippable; archiving is not fulfilment;
  cancellation and partial fulfilment are distinct stages.
- Currency formatting handles non-INR codes (USD, CAD, EUR) without throwing,
  and prints an unambiguous code where several currencies share a symbol.
- The searchable select treats an empty value as "nothing chosen" instead of
  letting a blank option hijack the trigger, and gained a compact variant for
  tight layouts such as order lines.
- Order dialogs pass weight and making charge to Shopify draft orders.

## Upgrading

Replace the installed application with the new installer. On first start the
existing database is upgraded in place; orders, products, customers, settings
and logins are preserved. No manual migration step is required.

## Verifying

The release build is signed and CI installs it into a clean Windows environment,
launches it, and runs the full interface suite against the installed copy, so
the published installer is verified to start and work rather than merely to
compile. Backend type checking, the unit and integration suites (including the
PostgreSQL upgrade-path and Shopify sync tests), the frontend production build,
linting and the production dependency audit are all release gates.
