import { pgTable, text, timestamp, numeric, integer, boolean, date, jsonb, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { mode: 'string' })
const numericNumber = (name: string) => numeric(name, { mode: 'number' })

export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  permissions: jsonb('permissions').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: ts('created_at'),
})

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  username: text('username').unique(),
  passwordHash: text('password_hash'),
  role: text('role').notNull(),
  lastLogin: ts('last_login'),
  status: text('status').notNull(),
  avatarColor: text('avatar_color'),
  permissions: jsonb('permissions'),
  emailVerified: boolean('email_verified'),
  requirePasswordChange: boolean('require_password_change'),
  resetToken: text('reset_token'),
  resetTokenExpiry: ts('reset_token_expiry'),
  emailVerificationToken: text('email_verification_token'),
  emailVerificationExpiry: ts('email_verification_expiry'),
})

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sku: text('sku').notNull().unique(),
  barcode: text('barcode'),
  huid: text('huid'),
  category: text('category').notNull(),
  collection: text('collection'),
  metal: text('metal').default('silver'),
  purity: numericNumber('purity'),
  purityLabel: text('purity_label'),
  grossWeight: numericNumber('gross_weight'),
  stoneWeight: numericNumber('stone_weight'),
  diamondWeight: numericNumber('diamond_weight'),
  netWeight: numericNumber('net_weight'),
  makingCharge: numericNumber('making_charge'),
  gst: numericNumber('gst'),
  hsn: text('hsn'),
  /** Free-text supplier name kept for legacy rows and display. */
  supplier: text('supplier'),
  /** FK to suppliers.id when the product was linked to a supplier record. */
  supplierId: text('supplier_id'),
  silverRate: numericNumber('silver_rate'),
  sellingPrice: numericNumber('selling_price'),
  /**
   * Piece Rate Product: sellingPrice is a fixed price per piece instead of a
   * silver-rate calculation. Silver-rate changes and Shopify syncs must never
   * recompute or overwrite the price of such a product.
   */
  pieceRateProduct: boolean('piece_rate_product').notNull().default(false),
  /** Fixed piece rate (₹/pc) used when pieceRateProduct is set. */
  fixedPieceRate: numericNumber('fixed_piece_rate'),
  compareAtPrice: numericNumber('compare_at_price'),
  /**
   * Weighted-average cost per unit, maintained from purchase invoices so
   * margin reporting reflects what stock actually cost rather than a manual
   * figure that drifts as silver moves.
   */
  costPrice: numericNumber('cost_price'),
  stock: integer('stock'),
  reorderLevel: integer('reorder_level'),
  shopifyStatus: text('shopify_status'),
  shopifyId: text('shopify_id'),
  status: text('status'),
  image: text('image'),
  images: jsonb('images'),
  vendor: text('vendor'),
  productType: text('product_type'),
  description: text('description'),
  tags: text('tags'),
  trackInventory: boolean('track_inventory').notNull().default(true),
  chargeOnTax: boolean('charge_on_tax').notNull().default(true),
  /**
   * Shopify-style option definitions on the parent product:
   * `[{ name: 'Size', values: ['Small', 'Large'] }]`. Each combination of
   * option values is a row in product_variants; NULL/empty = a simple
   * (single-variant) product, exactly as before.
   */
  options: jsonb('options'),
  branchId: text('branch_id'),
  // Timestamp (not date): the products list is ordered newest-first and
  // same-day creations must not tie. Existing date values upgrade to midnight
  // through the idempotent bootstrap ALTER.
  createdAt: timestamp('created_at', { mode: 'string' }),
}, (table) => ({
  skuIdx: uniqueIndex('products_sku_idx').on(table.sku),
  shopifyIdIdx: index('products_shopify_id_idx').on(table.shopifyId),
  categoryIdx: index('products_category_idx').on(table.category),
  statusIdx: index('products_status_idx').on(table.status),
  shopifyStatusIdx: index('products_shopify_status_idx').on(table.shopifyStatus),
  supplierIdIdx: index('products_supplier_id_idx').on(table.supplierId),
  barcodeIdx: index('products_barcode_idx').on(table.barcode).where(sql`${table.barcode} is not null and ${table.barcode} <> ''`),
  barcodeUniqueIdx: uniqueIndex('products_barcode_unique_idx').on(table.barcode).where(sql`${table.barcode} is not null and ${table.barcode} <> ''`),
  nameSearchIdx: index('products_name_search_idx').using('gin', sql`to_tsvector('english', ${table.name})`),
}))

/** Snapshot of a product's selling price whenever it is written. */
export const productPriceHistory = pgTable('product_price_history', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  sellingPrice: numericNumber('selling_price').notNull(),
  recordedAt: ts('recorded_at').notNull(),
}, (table) => ({
  productRecordedIdx: index('product_price_history_product_recorded_idx').on(table.productId, table.recordedAt),
}))

/**
 * Shopify-style variants: one row per option-value combination of the parent
 * product (products.options holds the option definitions). products.stock is
 * kept as the SUM of these rows' stock so every existing ledger, report and
 * sale flow keeps working against the parent unchanged.
 */
export const productVariants = pgTable('product_variants', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  /** "Small / Red" — the option values joined in option-definition order. */
  title: text('title').notNull(),
  /** Aligned with products.options: ['Small', 'Red']. */
  optionValues: jsonb('option_values').notNull(),
  sku: text('sku').notNull(),
  barcode: text('barcode'),
  sellingPrice: numericNumber('selling_price'),
  compareAtPrice: numericNumber('compare_at_price'),
  costPrice: numericNumber('cost_price'),
  grossWeight: numericNumber('gross_weight'),
  stock: integer('stock').notNull().default(0),
  reorderLevel: integer('reorder_level'),
  status: text('status'),
  createdAt: timestamp('created_at', { mode: 'string' }),
}, (table) => ({
  skuIdx: uniqueIndex('product_variants_sku_idx').on(table.sku),
  productIdIdx: index('product_variants_product_id_idx').on(table.productId),
}))

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  city: text('city'),
  province: text('province'),
  shopifyId: text('shopify_id').unique(),
  emailVerified: boolean('email_verified'),
  orders: integer('orders'),
  totalSpent: numericNumber('total_spent'),
  status: text('status'),
  joined: date('joined'),
}, (table) => ({
  emailIdx: index('customers_email_idx').on(table.email),
  shopifyIdIdx: uniqueIndex('customers_shopify_id_idx').on(table.shopifyId),
  phoneIdx: index('customers_phone_idx').on(table.phone),
  nameSearchIdx: index('customers_name_search_idx').using('gin', sql`to_tsvector('english', ${table.name})`),
}))

export const suppliers = pgTable('suppliers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  contact: text('contact'),
  phone: text('phone'),
  /** Second contact number, kept alongside the primary in case the main line is busy. */
  alternatePhone: text('alternate_phone'),
  email: text('email'),
  /** 15-character GSTIN, stored upper-cased. Unique when present. */
  gstin: text('gstin'),
  city: text('city'),
  address: text('address'),
  status: text('status'),
  outstanding: numericNumber('outstanding'),
}, (table) => ({
  nameIdx: uniqueIndex('suppliers_name_idx').on(table.name),
}))

export const salesOrders = pgTable('sales_orders', {
  id: text('id').primaryKey(),
  shopifyId: text('shopify_id').unique(),
  internalId: text('internal_id'),
  customer: text('customer'),
  customerShopifyId: text('customer_shopify_id'),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  value: numericNumber('value'),
  payment: text('payment'),
  fulfillment: text('fulfillment'),
  invoice: text('invoice'),
  status: text('status'),
  date: ts('date'),
  items: integer('items'),
  tags: text('tags'),
  currency: text('currency'),
  discount: numericNumber('discount'),
  lineItems: jsonb('line_items'),
  billingAddress: jsonb('billing_address'),
  shippingAddress: jsonb('shipping_address'),
  isBooking: boolean('is_booking'),
  advancePaid: numericNumber('advance_paid'),
  /**
   * Where this order was rung up, so its stock movements — and every reversal
   * of them — land on the same location's balance rather than the default one.
   */
  locationId: text('location_id'),
}, (table) => ({
  shopifyIdIdx: uniqueIndex('sales_orders_shopify_id_idx').on(table.shopifyId),
  customerShopifyIdIdx: index('sales_orders_customer_shopify_id_idx').on(table.customerShopifyId),
  internalIdIdx: index('sales_orders_internal_id_idx').on(table.internalId),
  customerIdx: index('sales_orders_customer_idx').on(table.customer),
  dateIdx: index('sales_orders_date_idx').on(table.date),
  statusIdx: index('sales_orders_status_idx').on(table.status),
}))

export const salesInvoices = pgTable('sales_invoices', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  shopifyOrder: text('shopify_order'),
  customer: text('customer'),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  customerAddress: text('customer_address'),
  customerCity: text('customer_city'),
  customerState: text('customer_state'),
  customerPincode: text('customer_pincode'),
  silverValue: numericNumber('silver_value'),
  makingCharge: numericNumber('making_charge'),
  subtotal: numericNumber('subtotal'),
  gst: numericNumber('gst'),
  gstAmount: numericNumber('gst_amount'),
  discount: numericNumber('discount'),
  grandTotal: numericNumber('grand_total'),
  tdsType: text('tds_type').default('none'),
  tdsRate: numericNumber('tds_rate'),
  tdsAmount: numericNumber('tds_amount'),
  tdsSection: text('tds_section'),
  buyerGstin: text('buyer_gstin'),
  irn: text('irn'),
  irnDate: ts('irn_date'),
  qrCode: text('qr_code'),
  paymentMethod: text('payment_method'),
  paymentStatus: text('payment_status'),
  paymentId: text('payment_id'),
  status: text('status'),
  date: ts('date'),
  dueDate: ts('due_date'),
  currency: text('currency').default('INR'),
}, (table) => ({
  numberIdx: uniqueIndex('sales_invoices_number_idx').on(table.number),
  shopifyOrderIdx: index('sales_invoices_shopify_order_idx').on(table.shopifyOrder),
  customerIdx: index('sales_invoices_customer_idx').on(table.customer),
  dateIdx: index('sales_invoices_date_idx').on(table.date),
  paymentStatusIdx: index('sales_invoices_payment_status_idx').on(table.paymentStatus),
  statusIdx: index('sales_invoices_status_idx').on(table.status),
}))

export const salesInvoiceItems = pgTable('sales_invoice_items', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').notNull(),
  product: text('product'),
  sku: text('sku'),
  qty: integer('qty'),
  weight: numericNumber('weight'),
  silverRate: numericNumber('silver_rate'),
  makingCharge: numericNumber('making_charge'),
  tax: numericNumber('tax'),
  amount: numericNumber('amount'),
}, (table) => ({
  invoiceIdIdx: index('sales_invoice_items_invoice_id_idx').on(table.invoiceId),
  skuIdx: index('sales_invoice_items_sku_idx').on(table.sku),
  invoiceFk: foreignKey({ columns: [table.invoiceId], foreignColumns: [salesInvoices.id], name: 'sales_invoice_items_invoice_id_fk' }).onDelete('cascade'),
}))

export const purchaseOrders = pgTable('purchase_orders', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  supplier: text('supplier'),
  /** FK to suppliers.id when the order was raised from the supplier picker. */
  supplierId: text('supplier_id'),
  items: integer('items'),
  qty: integer('qty'),
  weight: numericNumber('weight'),
  /** Line-item subtotal, before GST and discount. */
  value: numericNumber('value'),
  /** GST rate in percent — defaults to 3 (silver manufacturing). */
  gst: numericNumber('gst').default(3),
  gstAmount: numericNumber('gst_amount'),
  discount: numericNumber('discount').default(0),
  /** value + gstAmount − discount. */
  grandTotal: numericNumber('grand_total'),
  notes: text('notes'),
  /** When the supplier is expected to deliver. */
  expectedDate: ts('expected_date'),
  status: text('status'),
  date: ts('date'),
}, (table) => ({
  numberIdx: uniqueIndex('purchase_orders_number_idx').on(table.number),
  supplierIdx: index('purchase_orders_supplier_idx').on(table.supplier),
  dateIdx: index('purchase_orders_date_idx').on(table.date),
}))

export const purchaseInvoices = pgTable('purchase_invoices', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  supplier: text('supplier'),
  /** Where the goods were received, so the stock lands in the right balance. */
  locationId: text('location_id'),
  items: integer('items'),
  qty: integer('qty'),
  weight: numericNumber('weight'),
  rate: numericNumber('rate'),
  cost: numericNumber('cost'),
  tax: numericNumber('tax'),
  total: numericNumber('total'),
  status: text('status'),
  date: ts('date'),
  /** How much has been paid against this invoice (ledger-backed). */
  paidAmount: numericNumber('paid_amount').default(0),
  /** Supplier tax details — needed to claim input credit. */
  supplierGstin: text('supplier_gstin'),
  supplierState: text('supplier_state'),
  /** Input GST split, derived from the supplier's state vs ours. */
  cgst: numericNumber('cgst'),
  sgst: numericNumber('sgst'),
  igst: numericNumber('igst'),
  /** Tax collected at source on bullion purchases. */
  tcsRate: numericNumber('tcs_rate'),
  tcsAmount: numericNumber('tcs_amount'),
  /** The purchase order this invoice received, when it came from one. */
  orderId: text('order_id'),
}, (table) => ({
  numberIdx: uniqueIndex('purchase_invoices_number_idx').on(table.number),
  supplierIdx: index('purchase_invoices_supplier_idx').on(table.supplier),
  dateIdx: index('purchase_invoices_date_idx').on(table.date),
  statusIdx: index('purchase_invoices_status_idx').on(table.status),
  orderIdx: index('purchase_invoices_order_id_idx').on(table.orderId),
}))

/**
 * Line items on a purchase invoice. Without these there is nothing to add to
 * stock when a purchase is received — only totals were being stored.
 */
export const purchaseInvoiceItems = pgTable('purchase_invoice_items', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id').notNull(),
  product: text('product'),
  sku: text('sku'),
  qty: numericNumber('qty').default(1),
  weight: numericNumber('weight'),
  /** Silver rate per gram this was bought at. */
  rate: numericNumber('rate'),
  /** Rate × weight (+ making charge), pre-tax. */
  cost: numericNumber('cost'),
  tax: numericNumber('tax'),
  amount: numericNumber('amount'),
}, (table) => ({
  invoiceIdx: index('purchase_invoice_items_invoice_id_idx').on(table.invoiceId),
  skuIdx: index('purchase_invoice_items_sku_idx').on(table.sku),
  invoiceFk: foreignKey({ columns: [table.invoiceId], foreignColumns: [purchaseInvoices.id], name: 'purchase_invoice_items_invoice_id_fk' }).onDelete('cascade'),
}))

/** Line items on a purchase order — what was actually ordered from a supplier. */
export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  product: text('product'),
  sku: text('sku'),
  qty: numericNumber('qty').default(1),
  weight: numericNumber('weight'),
  rate: numericNumber('rate'),
  amount: numericNumber('amount'),
}, (table) => ({
  orderIdx: index('purchase_order_items_order_id_idx').on(table.orderId),
  skuIdx: index('purchase_order_items_sku_idx').on(table.sku),
  orderFk: foreignKey({ columns: [table.orderId], foreignColumns: [purchaseOrders.id], name: 'purchase_order_items_order_id_fk' }).onDelete('cascade'),
}))

/** Money actually paid to a supplier — the counterpart of `payments`. */
export const supplierPayments = pgTable('supplier_payments', {
  id: text('id').primaryKey(),
  ref: text('ref'),
  supplier: text('supplier'),
  amount: numericNumber('amount').notNull(),
  method: text('method'),
  note: text('note'),
  date: ts('date'),
  createdBy: text('created_by'),
}, (table) => ({
  refIdx: index('supplier_payments_ref_idx').on(table.ref),
  supplierIdx: index('supplier_payments_supplier_idx').on(table.supplier),
  dateIdx: index('supplier_payments_date_idx').on(table.date),
}))

/** How a supplier payment was split across their open invoices. */
export const supplierPaymentAllocations = pgTable('supplier_payment_allocations', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id').notNull(),
  invoiceId: text('invoice_id'),
  invoiceNumber: text('invoice_number'),
  amount: numericNumber('amount').notNull(),
}, (table) => ({
  paymentIdx: index('supplier_payment_allocations_payment_id_idx').on(table.paymentId),
  invoiceIdx: index('supplier_payment_allocations_invoice_id_idx').on(table.invoiceId),
  paymentFk: foreignKey({ columns: [table.paymentId], foreignColumns: [supplierPayments.id], name: 'supplier_payment_allocations_payment_id_fk' }).onDelete('cascade'),
}))

export const salesReturns = pgTable('sales_returns', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  invoiceId: text('invoice_id'),
  creditNoteNumber: text('credit_note_number'),
  restocked: boolean('restocked'),
  returnItems: jsonb('return_items'),
  order: text('order'),
  customer: text('customer'),
  items: integer('items'),
  amount: numericNumber('amount'),
  status: text('status'),
  date: ts('date'),
}, (table) => ({
  numberIdx: uniqueIndex('sales_returns_number_idx').on(table.number),
  customerIdx: index('sales_returns_customer_idx').on(table.customer),
  dateIdx: index('sales_returns_date_idx').on(table.date),
}))

export const orderEvents = pgTable('order_events', {
  id: text('id').primaryKey(),
  orderId: text('order_id'),
  event: text('event'),
  details: text('details'),
  actor: text('actor'),
  createdAt: ts('created_at'),
}, (table) => ({
  orderIdIdx: index('order_events_order_id_idx').on(table.orderId),
  createdIdx: index('order_events_created_idx').on(table.createdAt),
}))

export const shipments = pgTable('shipments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  orderRef: text('order_ref'),
  customer: text('customer'),
  courier: text('courier'),
  trackingNumber: text('tracking_number'),
  status: text('status').notNull().default('pending'),
  dispatchedAt: ts('dispatched_at'),
  expectedDelivery: date('expected_delivery'),
  deliveredAt: ts('delivered_at'),
  notes: text('notes'),
  createdAt: ts('created_at'),
}, (table) => ({
  orderIdIdx: index('shipments_order_id_idx').on(table.orderId),
}))

export const notificationLog = pgTable('notification_log', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  channel: text('channel').notNull(),
  recipient: text('recipient'),
  ref: text('ref'),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: ts('created_at'),
}, (table) => ({
  createdIdx: index('notification_log_created_idx').on(table.createdAt),
}))

export const purchaseReturns = pgTable('purchase_returns', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  supplier: text('supplier'),
  items: integer('items'),
  weight: numericNumber('weight'),
  amount: numericNumber('amount'),
  status: text('status'),
  date: ts('date'),
  /** The purchase invoice being returned against. */
  invoiceId: text('invoice_id'),
}, (table) => ({
  numberIdx: uniqueIndex('purchase_returns_number_idx').on(table.number),
  supplierIdx: index('purchase_returns_supplier_idx').on(table.supplier),
  dateIdx: index('purchase_returns_date_idx').on(table.date),
  invoiceIdx: index('purchase_returns_invoice_id_idx').on(table.invoiceId),
}))

/**
 * Line items on a purchase return. Without these a return can only carry a
 * total, so nothing can be taken back out of stock.
 */
export const purchaseReturnItems = pgTable('purchase_return_items', {
  id: text('id').primaryKey(),
  returnId: text('return_id').notNull(),
  product: text('product'),
  sku: text('sku'),
  qty: numericNumber('qty').default(1),
  weight: numericNumber('weight'),
  rate: numericNumber('rate'),
  amount: numericNumber('amount'),
}, (table) => ({
  returnIdx: index('purchase_return_items_return_id_idx').on(table.returnId),
  skuIdx: index('purchase_return_items_sku_idx').on(table.sku),
  returnFk: foreignKey({ columns: [table.returnId], foreignColumns: [purchaseReturns.id], name: 'purchase_return_items_return_id_fk' }).onDelete('cascade'),
}))

export const inventoryLocations = pgTable('inventory_locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type'),
  city: text('city'),
  manager: text('manager'),
}, (table) => ({
  nameIdx: uniqueIndex('inventory_locations_name_idx').on(table.name),
}))

export const stockTransfers = pgTable('stock_transfers', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  from: text('from'),
  to: text('to'),
  product: text('product'),
  sku: text('sku'),
  qty: integer('qty'),
  weight: numericNumber('weight'),
  initiatedBy: text('initiated_by'),
  status: text('status'),
  date: ts('date'),
  /** Quantity actually counted on arrival. Null means it matched `qty` exactly. */
  receivedQty: integer('received_qty'),
  /** receivedQty - qty: negative is short in transit, positive is an overage. */
  variance: integer('variance'),
}, (table) => ({
  numberIdx: uniqueIndex('stock_transfers_number_idx').on(table.number),
  skuIdx: index('stock_transfers_sku_idx').on(table.sku),
  dateIdx: index('stock_transfers_date_idx').on(table.date),
}))

/**
 * Per-location stock balance.
 *
 * Stock used to live only on products.stock, which made it impossible to say
 * how much was in which store or why a balance changed. This holds the balance
 * per location; products.stock is kept as the rollup across all locations so
 * every existing query keeps working.
 */
export const stockLevels = pgTable('stock_levels', {
  productId: text('product_id').notNull(),
  locationId: text('location_id').notNull(),
  qty: integer('qty').notNull().default(0),
}, (table) => ({
  productLocationIdx: uniqueIndex('stock_levels_product_location_idx').on(table.productId, table.locationId),
  locationIdx: index('stock_levels_location_idx').on(table.locationId),
}))

/**
 * Append-only record of every stock change.
 *
 * Every write goes through applyStockMovement in src/stock.ts, so this is the
 * audit trail for a balance: what moved, which direction, why, and what the
 * balance became. Nothing here is ever updated or deleted.
 */
export const stockMovements = pgTable('stock_movements', {
  id: text('id').primaryKey(),
  productId: text('product_id'),
  sku: text('sku'),
  locationId: text('location_id'),
  /** purchase_in, purchase_return_out, sale_out, sale_return_in, transfer_in, transfer_out, count_adjust, shopify_sync, manual */
  type: text('type').notNull(),
  /** Signed: positive adds stock, negative removes it. */
  qty: numericNumber('qty').notNull(),
  /** Balance at this location immediately after the movement. */
  stockAfter: numericNumber('stock_after'),
  unitCost: numericNumber('unit_cost'),
  refType: text('ref_type'),
  refId: text('ref_id'),
  note: text('note'),
  createdBy: text('created_by'),
  date: ts('date'),
}, (table) => ({
  skuIdx: index('stock_movements_sku_idx').on(table.sku),
  productIdx: index('stock_movements_product_id_idx').on(table.productId),
  locationIdx: index('stock_movements_location_id_idx').on(table.locationId),
  dateIdx: index('stock_movements_date_idx').on(table.date),
  refIdx: index('stock_movements_ref_idx').on(table.refType, table.refId),
}))

export const bankAccounts = pgTable('bank_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  bank: text('bank'),
  accountNumber: text('account_number'),
  accountNumberEncrypted: text('account_number_encrypted'),
  balance: numericNumber('balance'),
  ifsc: text('ifsc'),
}, (table) => ({
  nameIdx: uniqueIndex('bank_accounts_name_idx').on(table.name),
}))

export const ledgerEntries = pgTable('ledger_entries', {
  id: text('id').primaryKey(),
  date: date('date'),
  description: text('description'),
  ref: text('ref'),
  debit: numericNumber('debit'),
  credit: numericNumber('credit'),
}, (table) => ({
  dateIdx: index('ledger_entries_date_idx').on(table.date),
  refIdx: index('ledger_entries_ref_idx').on(table.ref),
}))

export const expenses = pgTable('expenses', {
  id: text('id').primaryKey(),
  category: text('category'),
  description: text('description'),
  amount: numericNumber('amount'),
  paymentMethod: text('payment_method'),
  date: ts('date'),
  status: text('status'),
  by: text('by'),
}, (table) => ({
  dateIdx: index('expenses_date_idx').on(table.date),
  categoryIdx: index('expenses_category_idx').on(table.category),
  statusIdx: index('expenses_status_idx').on(table.status),
}))

export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  ref: text('ref'),
  invoice: text('invoice'),
  customer: text('customer'),
  amount: numericNumber('amount'),
  method: text('method'),
  gateway: text('gateway'),
  status: text('status'),
  date: ts('date'),
  reconciled: boolean('reconciled'),
}, (table) => ({
  refIdx: index('payments_ref_idx').on(table.ref),
  invoiceIdx: index('payments_invoice_idx').on(table.invoice),
  customerIdx: index('payments_customer_idx').on(table.customer),
  dateIdx: index('payments_date_idx').on(table.date),
  reconciledIdx: index('payments_reconciled_idx').on(table.reconciled),
}))

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  timestamp: ts('timestamp'),
  user: text('user'),
  action: text('action'),
  module: text('module'),
  entity: text('entity'),
  changes: text('changes'),
  ip: text('ip'),
}, (table) => ({
  timestampIdx: index('audit_logs_timestamp_idx').on(table.timestamp),
  userIdx: index('audit_logs_user_idx').on(table.user),
  moduleIdx: index('audit_logs_module_idx').on(table.module),
}))

export const activityLogs = pgTable('activity_logs', {
  id: text('id').primaryKey(),
  timestamp: ts('timestamp'),
  user: text('user'),
  userId: text('user_id'),
  role: text('role'),
  action: text('action'),
  module: text('module'),
  entity: text('entity'),
  details: text('details'),
  ip: text('ip'),
}, (table) => ({
  timestampIdx: index('activity_logs_timestamp_idx').on(table.timestamp),
  userIdIdx: index('activity_logs_user_id_idx').on(table.userId),
  moduleIdx: index('activity_logs_module_idx').on(table.module),
}))

export const syncLogs = pgTable('sync_logs', {
  id: text('id').primaryKey(),
  entity: text('entity'),
  shopifyId: text('shopify_id'),
  direction: text('direction'),
  action: text('action'),
  status: text('status'),
  time: ts('time'),
  error: text('error'),
  retry: boolean('retry'),
}, (table) => ({
  timeIdx: index('sync_logs_time_idx').on(table.time),
  entityIdx: index('sync_logs_entity_idx').on(table.entity),
  shopifyIdIdx: index('sync_logs_shopify_id_idx').on(table.shopifyId),
}))

export const silverRates = pgTable('silver_rates', {
  id: text('id').primaryKey(),
  purity: numericNumber('purity'),
  rate: numericNumber('rate'),
  previousRate: numericNumber('previous_rate'),
  updatedAt: ts('updated_at'),
  change: numericNumber('change'),
  changePercent: numericNumber('change_percent'),
  currency: text('currency'),
  /** Display name of who applied the change (admin, scheduler, or approver). */
  updatedBy: text('updated_by'),
  /** How the change was applied: manual | auto | approval. */
  source: text('source'),
  /** Shopify push outcome for this change: synced | skipped | failed. */
  syncStatus: text('sync_status'),
  /** Admin/superadmin who approved a staff request (approval source only). */
  approvedBy: text('approved_by'),
}, (table) => ({
  updatedAtIdx: index('silver_rates_updated_at_idx').on(table.updatedAt),
}))

// Staff silver-rate change requests awaiting Admin / Super Admin approval.
export const silverRateRequests = pgTable('silver_rate_requests', {
  id: text('id').primaryKey(),
  rate: numericNumber('rate'),
  previousRate: numericNumber('previous_rate'),
  /** pending | approved | rejected */
  status: text('status').notNull().default('pending'),
  syncFirst: boolean('sync_first').notNull().default(false),
  requestedBy: text('requested_by'),
  requestedById: text('requested_by_id'),
  requestedByRole: text('requested_by_role'),
  requestedAt: ts('requested_at'),
  decidedBy: text('decided_by'),
  decidedById: text('decided_by_id'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  /** What happened when the request was applied (repriced/pushed counts or errors). */
  resultNote: text('result_note'),
}, (table) => ({
  statusIdx: index('silver_rate_requests_status_idx').on(table.status),
  requestedAtIdx: index('silver_rate_requests_requested_at_idx').on(table.requestedAt),
}))

export const goldRates = pgTable('gold_rates', {
  id: text('id').primaryKey(),
  rate: numeric('rate').notNull(),
  purity: numeric('purity').notNull().default('99.9'),
  currency: text('currency').notNull().default('INR'),
  source: text('source'),
  updatedAt: ts('updated_at').defaultNow(),
}, (table) => ({
  updatedAtIdx: index('gold_rates_updated_at_idx').on(table.updatedAt),
}))

export const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  businessName: text('business_name'),
  gstin: text('gstin'),
  pan: text('pan'),
  tdsEnabled: boolean('tds_enabled').default(false),
  tcsEnabled: boolean('tcs_enabled').default(false),
  defaultTdsSection: text('default_tds_section'),
  einvoiceEnabled: boolean('einvoice_enabled').default(false),
  /**
   * How IRNs get generated: off | manual | automatic.
   * `automatic` pushes every newly issued invoice to the gateway.
   */
  einvoiceMode: text('einvoice_mode').default('off'),
  ewayBillEnabled: boolean('eway_bill_enabled').default(false),
  upiId: text('upi_id'),
  upiMerchantName: text('upi_merchant_name'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  defaultPurity: numericNumber('default_purity'),
  makingCharge: numericNumber('making_charge'),
  gstRate: numericNumber('gst_rate'),
  currency: text('currency'),
  invoicePrefix: text('invoice_prefix'),
  rateSource: text('rate_source'),
  autoUpdateMcx: boolean('auto_update_mcx'),
  requireRateApproval: boolean('require_rate_approval'),
  autoReconcileRazorpay: boolean('auto_reconcile_razorpay'),
  notificationSettings: jsonb('notification_settings'),
  paymentReminders: boolean('payment_reminders'),
  lowStockAlerts: boolean('low_stock_alerts'),
  dailySummary: boolean('daily_summary'),
  orderImports: boolean('order_imports'),
  /**
   * Account lockout after repeated failed logins (5 failures / 15 minutes —
   * see src/lockout.ts). Default off: the product ships with lockout disabled
   * for testing and it is switched on per install from Settings → Security →
   * Login lockout. Read on every login attempt; NULL means disabled.
   */
  loginLockoutEnabled: boolean('login_lockout_enabled').default(false),
  /**
   * How many failed sign-ins inside the window lock the account
   * (Settings → Security → Login lockout). NULL → shipped default of 5.
   */
  lockoutThreshold: integer('lockout_threshold').default(5),
  /**
   * Lockout window/length in minutes (Settings → Security → Login lockout).
   * NULL → shipped default of 15.
   */
  lockoutDurationMinutes: integer('lockout_duration_minutes').default(15),
  /**
   * Run days/time for the silver-rate auto-update (Silver Rate page →
   * Edit schedule). JSONB `{ days: [0=Sun…6=Sat], time: 'HH:MM' }` in
   * Asia/Kolkata; NULL → every day at 09:00 (the original behaviour).
   */
  rateSchedule: jsonb('rate_schedule'),
  /**
   * One-off rate changes scheduled from the Silver Rate page: an array of
   * `{ id, rate, applyAt, requestedBy }` (see src/lib/scheduledRate.ts).
   * Pending entries only — applied/cancelled ones are removed (the activity
   * log keeps the trail). NULL → nothing scheduled.
   */
  scheduledRateChanges: jsonb('scheduled_rate_changes'),
  shopifyStoreUrlEncrypted: text('shopify_store_url_encrypted'),
  shopifyAccessTokenEncrypted: text('shopify_access_token_encrypted'),
  shopifyApiVersion: text('shopify_api_version'),
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  dbHostEncrypted: text('db_host_encrypted'),
  dbPortEncrypted: text('db_port_encrypted'),
  dbDatabaseEncrypted: text('db_database_encrypted'),
  dbUserEncrypted: text('db_user_encrypted'),
  dbPasswordEncrypted: text('db_password_encrypted'),
  /**
   * Auto-generated product identifiers (Settings → Product codes, consumed by
   * src/lib/productCodes.ts). NULL everywhere means the shipped defaults:
   * prefix SLV, template {PREFIX}-{CATEGORY}-{SEQ}, 5-digit sequence, EAN-13
   * barcode prefix 890 — the house style the app has always generated.
   */
  skuPrefix: text('sku_prefix'),
  skuSuffix: text('sku_suffix'),
  skuFormat: text('sku_format'),
  skuSeqLength: integer('sku_seq_length'),
  barcodePrefix: text('barcode_prefix'),
  updatedAt: ts('updated_at'),
})

export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: ts('created_at'),
  expiresAt: ts('expires_at'),
}, (table) => [
  index('sessions_expires_at_idx').on(table.expiresAt),
])

export const loginAttempts = pgTable('login_attempts', {
  identifier: text('identifier').primaryKey(),
  count: integer('count').notNull().default(0),
  lastAttempt: ts('last_attempt'),
})

export const rateLimitHits = pgTable('rate_limit_hits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  resetAt: timestamp('reset_at', { mode: 'string', withTimezone: true }),
})

export const webhookDeliveries = pgTable('webhook_deliveries', {
  webhookId: text('webhook_id').primaryKey(),
  seenAt: timestamp('seen_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
})

export const quotations = pgTable('quotations', {
  id: text('id').primaryKey(),
  number: text('number').notNull().unique(),
  customer: text('customer'),
  customerPhone: text('customer_phone'),
  customerEmail: text('customer_email'),
  customerAddress: text('customer_address'),
  customerCity: text('customer_city'),
  customerState: text('customer_state'),
  customerPincode: text('customer_pincode'),
  subtotal: numericNumber('subtotal'),
  gst: numericNumber('gst'),
  gstAmount: numericNumber('gst_amount'),
  discount: numericNumber('discount'),
  grandTotal: numericNumber('grand_total'),
  notes: text('notes'),
  status: text('status').notNull().default('draft'),
  validUntil: ts('valid_until'),
  convertedInvoice: text('converted_invoice'),
  convertedAt: ts('converted_at'),
  createdBy: text('created_by'),
  date: ts('date').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at'),
  currency: text('currency').default('INR'),
}, (table) => ({
  statusIdx: index('quotations_status_idx').on(table.status),
  customerIdx: index('quotations_customer_idx').on(table.customer),
  dateIdx: index('quotations_date_idx').on(table.date),
}))

export const quotationItems = pgTable('quotation_items', {
  id: text('id').primaryKey(),
  quotationId: text('quotation_id').notNull(),
  product: text('product'),
  sku: text('sku'),
  qty: integer('qty'),
  weight: numericNumber('weight'),
  silverRate: numericNumber('silver_rate'),
  makingCharge: numericNumber('making_charge'),
  amount: numericNumber('amount'),
}, (table) => ({
  quotationIdIdx: index('quotation_items_quotation_id_idx').on(table.quotationId),
  skuIdx: index('quotation_items_sku_idx').on(table.sku),
  quotationFk: foreignKey({ columns: [table.quotationId], foreignColumns: [quotations.id], name: 'quotation_items_quotation_id_fk' }).onDelete('cascade'),
}))

import { sql } from 'drizzle-orm'
// ─── Loyalty points ─────────────────────────────────────────────────────────

// ─── Batch / lot tracking ──────────────────────────────────────────────────

export const batches = pgTable('batches', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  batchNumber: text('batch_number').notNull(),
  quantity: integer('quantity').notNull().default(0),
  costPrice: numericNumber('cost_price'),
  manufacturingDate: date('manufacturing_date'),
  expiryDate: date('expiry_date'),
  supplier: text('supplier'),
  status: text('status').default('active'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  productIdx: index('batches_product_idx').on(table.productId),
  batchNumberIdx: index('batches_number_idx').on(table.batchNumber),
}))

// ─── Manufacturing / BOM ──────────────────────────────────────────────────

export const boms = pgTable('boms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  productId: text('product_id'),
  description: text('description'),
  yieldQty: integer('yield_qty').default(1),
  totalCost: numericNumber('total_cost'),
  status: text('status').default('active'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  productIdx: index('boms_product_idx').on(table.productId),
}))

export const bomItems = pgTable('bom_items', {
  id: text('id').primaryKey(),
  bomId: text('bom_id').notNull(),
  productId: text('product_id').notNull(),
  quantity: numericNumber('quantity'),
  unit: text('unit').default('g'),
  wastagePercent: numericNumber('wastage_percent'),
  cost: numericNumber('cost'),
}, (table) => ({
  bomIdx: index('bom_items_bom_idx').on(table.bomId),
}))

// ─── Karigar (artisan / worker) ───────────────────────────────────────────

export const karigars = pgTable('karigars', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  specialty: text('specialty'),
  rate: numericNumber('rate'),
  rateType: text('rate_type').default('per_gram'),
  balance: numericNumber('balance'),
  address: text('address'),
  status: text('status').default('active'),
  createdAt: timestamp('created_at').defaultNow(),
})

// ─── Multi-branch ─────────────────────────────────────────────────────────

export const branches = pgTable('branches', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  address: text('address'),
  phone: text('phone'),
  managerName: text('manager_name'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
})

export const loyaltyTransactions = pgTable('loyalty_transactions', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  invoiceId: text('invoice_id'),
  invoiceNumber: text('invoice_number'),
  type: text('type').notNull(), // 'earn' | 'redeem' | 'adjust'
  points: numericNumber('points').notNull(), // positive earn, negative redeem
  balanceAfter: numericNumber('balance_after'),
  note: text('note'),
  createdBy: text('created_by'),
  date: ts('date').notNull().defaultNow(),
}, (table) => ({
  customerIdx: index('loyalty_transactions_customer_id_idx').on(table.customerId),
  invoiceIdx: index('loyalty_transactions_invoice_id_idx').on(table.invoiceId),
  dateIdx: index('loyalty_transactions_date_idx').on(table.date),
}))

// ─── Multi-currency support ─────────────────────────────────────────────────

export const currencies = pgTable('currencies', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  exchangeRate: numericNumber('exchange_rate'),
  isActive: boolean('is_active').default(true),
  updatedAt: ts('updated_at').defaultNow(),
})

// ─── Double-entry accounting ──────────────────────────────────────────────

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  subType: text('sub_type'),
  parentId: text('parent_id'),
  isGroup: boolean('is_group').default(false),
  openingBalance: numericNumber('opening_balance').default(0),
  currentBalance: numericNumber('current_balance').default(0),
  currency: text('currency').default('INR'),
  branchId: text('branch_id'),
  isActive: boolean('is_active').default(true),
  createdAt: ts('created_at'),
}, (table) => ({
  typeIdx: index('accounts_type_idx').on(table.type),
}))

export const journalEntries = pgTable('journal_entries', {
  id: text('id').primaryKey(),
  entryNumber: text('entry_number').notNull().unique(),
  date: date('date').notNull(),
  description: text('description'),
  reference: text('reference'),
  referenceType: text('reference_type'),
  referenceId: text('reference_id'),
  isAuto: boolean('is_auto').default(true),
  branchId: text('branch_id'),
  createdBy: text('created_by'),
  createdAt: ts('created_at'),
}, (table) => ({
  dateIdx: index('journal_entries_date_idx').on(table.date),
  refIdx: index('journal_entries_ref_idx').on(table.referenceType, table.referenceId),
}))

export const journalEntryLines = pgTable('journal_entry_lines', {
  id: text('id').primaryKey(),
  journalEntryId: text('journal_entry_id').notNull(),
  accountId: text('account_id').notNull(),
  debit: numericNumber('debit').default(0),
  credit: numericNumber('credit').default(0),
  description: text('description'),
  branchId: text('branch_id'),
}, (table) => ({
  entryIdx: index('jel_entry_idx').on(table.journalEntryId),
  accountIdx: index('jel_account_idx').on(table.accountId),
}))

export const financialPeriods = pgTable('financial_periods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  isOpen: boolean('is_open').default(true),
  closedAt: timestamp('closed_at'),
})

/** Saved designs for printable documents (invoice, quotation, order). */
export const printTemplates = pgTable('print_templates', {
  id: text('id').primaryKey(),
  /** invoice | quotation | order — one default design per document type. */
  docType: text('doc_type').notNull(),
  name: text('name').notNull(),
  /** PrintDesignerConfig JSON: accent color, header style, toggles, margins… */
  config: jsonb('config').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  updatedAt: ts('updated_at'),
}, (table) => ({
  docTypeIdx: index('print_templates_doc_type_idx').on(table.docType),
}))
