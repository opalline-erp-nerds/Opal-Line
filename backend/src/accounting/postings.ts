import { db, schema } from '../db/client'
import { upsertJournalEntry, removeJournalEntry, toIsoDate, ACCOUNT_CODES } from './journal'
import { eq } from 'drizzle-orm'

const n = (v: unknown) => Number(v || 0) || 0
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

function isInvoiceActiveForAccounting(inv: any) {
  const status = String(inv?.status ?? '').toLowerCase()
  return status !== 'cancelled' && status !== 'void' && status !== 'draft'
}

export async function postSalesInvoiceJournal(invoiceId: string, createdBy?: string | null) {
  if (!db) return null
  const [inv] = await db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, invoiceId)).limit(1)
  if (!inv) return null
  if (!isInvoiceActiveForAccounting(inv)) {
    await removeJournalEntry('invoice', inv.id, createdBy ?? null).catch(() => undefined)
    return null
  }
  const grandTotal = n(inv.grandTotal)
  const gst = n(inv.gstAmount)
  const tds = n(inv.tdsAmount)
  const discount = n(inv.discount)
  const taxable = Math.max(0, round2(n(inv.subtotal) - discount))
  const receivable = round2(grandTotal - tds)
  const isShopify = !!inv.shopifyOrder
  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [
    { accountCode: ACCOUNT_CODES.receivable, debit: receivable, description: `Receivable ${inv.number}` },
    { accountCode: ACCOUNT_CODES.salesRevenue, credit: taxable, description: `Sales ${inv.number}` },
  ]
  if (gst > 0) lines.push({ accountCode: ACCOUNT_CODES.gstOutput, credit: round2(gst), description: `GST Output ${inv.number}` })
  if (tds > 0) lines.push({ accountCode: ACCOUNT_CODES.tdsPayable, debit: round2(tds), description: `TDS deducted ${inv.number}` })
  const debit = round2(lines.reduce((s, l) => s + n(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + n(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) {
    if (debit > credit) lines.push({ accountCode: ACCOUNT_CODES.salesRevenue, credit: round2(debit - credit), description: 'Rounding adjustment' })
    else lines[0].debit = round2(n(lines[0].debit) + (credit - debit))
  }
  if (Math.abs(receivable) < 0.01 && Math.abs(taxable) < 0.01 && Math.abs(gst) < 0.01) {
    await removeJournalEntry('invoice', inv.id, createdBy ?? null).catch(() => undefined)
    return null
  }
  return upsertJournalEntry({
    date: toIsoDate(inv.date),
    description: `${isShopify ? 'Shopify' : 'ERP'} sales invoice ${inv.number}`,
    reference: inv.number,
    referenceType: 'invoice',
    referenceId: inv.id,
    source: isShopify ? 'shopify' : 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function postPurchaseInvoiceJournal(invoiceId: string, createdBy?: string | null) {
  if (!db) return null
  const [inv] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, invoiceId)).limit(1)
  if (!inv) return null
  const status = String(inv.status ?? '').toLowerCase()
  if (status === 'cancelled' || status === 'void') {
    await removeJournalEntry('purchase-invoice', inv.id, createdBy ?? null).catch(() => undefined)
    return null
  }
  const total = n(inv.total)
  const gst = n(inv.tax)
  const expense = Math.max(0, round2(n(inv.cost)))
  // `total` is cost + GST and is what the supplier is owed. TCS (194Q) is
  // withheld when the supplier is paid and remitted separately, so posting it
  // here as well would double-count both the payable and the expense.
  const payable = round2(total)
  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [
    { accountCode: ACCOUNT_CODES.purchaseExpense, debit: expense, description: `Purchase ${inv.number}` },
    { accountCode: ACCOUNT_CODES.payable, credit: payable, description: `Payable ${inv.number}` },
  ]
  if (gst > 0) lines.push({ accountCode: ACCOUNT_CODES.gstInput, debit: round2(gst), description: `GST Input ${inv.number}` })
  const debit = round2(lines.reduce((s, l) => s + n(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + n(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) {
    if (debit > credit) lines.push({ accountCode: ACCOUNT_CODES.payable, credit: round2(debit - credit), description: 'Rounding adjustment' })
    else lines[0].debit = round2(n(lines[0].debit) + (credit - debit))
  }
  if (Math.abs(debit) < 0.01 && Math.abs(credit) < 0.01) {
    await removeJournalEntry('purchase-invoice', inv.id, createdBy ?? null).catch(() => undefined)
    return null
  }
  return upsertJournalEntry({
    date: toIsoDate(inv.date),
    description: `Purchase invoice ${inv.number}`,
    reference: inv.number,
    referenceType: 'purchase-invoice',
    referenceId: inv.id,
    source: 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function postExpenseJournal(expenseId: string, createdBy?: string | null) {
  if (!db) return null
  const [exp] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expenseId)).limit(1)
  if (!exp) return null
  const amount = n(exp.amount)
  if (amount <= 0) {
    await removeJournalEntry('expense', expenseId, createdBy ?? null).catch(() => undefined)
    return null
  }
  const method = String(exp.paymentMethod ?? '').toLowerCase()
  const cashLike = /cash|cod/.test(method)
  return upsertJournalEntry({
    date: toIsoDate(exp.date),
    description: `Expense ${exp.description || exp.category || exp.id}`,
    reference: exp.id,
    referenceType: 'expense',
    referenceId: exp.id,
    source: 'erp',
    createdBy: createdBy ?? null,
    lines: [
      { accountCode: ACCOUNT_CODES.operatingExpense, debit: round2(amount), description: exp.description ?? 'Expense' },
      { accountCode: cashLike ? ACCOUNT_CODES.cash : ACCOUNT_CODES.bank, credit: round2(amount), description: 'Payment' },
    ],
  })
}

export async function postPaymentJournal(paymentId: string, createdBy?: string | null) {
  if (!db) return null
  const [pay] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1)
  if (!pay) return null
  const status = String(pay.status ?? '').toLowerCase()
  const amount = n(pay.amount)
  if (status === 'failed' || status === 'cancelled' || amount === 0) {
    await removeJournalEntry('payment', paymentId, createdBy ?? null).catch(() => undefined)
    await removeJournalEntry('supplier-payment', paymentId, createdBy ?? null).catch(() => undefined)
    return null
  }
  const method = String(pay.method ?? '').toLowerCase()
  const gateway = String(pay.gateway ?? '').toLowerCase()
  const cashLike = /cash|cod/.test(method)
  // Supplier payments live in `supplier_payments`, not here; they have their
  // own posting function so a customer whose name contains "SUP" can never be
  // misclassified as a supplier.
  await removeJournalEntry('supplier-payment', paymentId, createdBy ?? null).catch(() => undefined)
  // Negative payment (credit note/refund adjustment trail) reverses receivable/cash impact from available real fields.
  const abs = round2(Math.abs(amount))
  const isShopify = !!gateway || method.includes('shopify') || String(pay.ref ?? '').startsWith('#') || String(pay.invoice ?? '').startsWith('INV') && String(pay.gateway ?? '') === 'return'
  const cashAcc = cashLike ? ACCOUNT_CODES.cash : ACCOUNT_CODES.bank
  const lines = amount >= 0
    ? [
        { accountCode: cashAcc, debit: abs, description: 'Payment received' },
        { accountCode: ACCOUNT_CODES.receivable, credit: abs, description: `Against ${pay.invoice ?? 'customer'}` },
      ]
    : [
        { accountCode: ACCOUNT_CODES.receivable, debit: abs, description: `Adjustment ${pay.ref ?? pay.invoice ?? ''}`.trim() },
        { accountCode: cashAcc, credit: abs, description: 'Refund/credit adjustment' },
      ]
  return upsertJournalEntry({
    date: toIsoDate(pay.date),
    description: `${amount < 0 ? 'Payment reversal/refund adjustment' : 'Customer payment'} ${pay.ref ?? pay.id}`,
    reference: pay.ref ?? pay.id,
    referenceType: 'payment',
    referenceId: pay.id,
    source: isShopify ? 'shopify' : 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function postSupplierPaymentJournal(paymentId: string, createdBy?: string | null) {
  if (!db) return null
  const [pay] = await db.select().from(schema.supplierPayments).where(eq(schema.supplierPayments.id, paymentId)).limit(1)
  if (!pay) return null
  const amount = round2(n(pay.amount))
  if (amount <= 0) {
    await removeJournalEntry('supplier-payment', paymentId, createdBy ?? null).catch(() => undefined)
    return null
  }
  const method = String(pay.method ?? '').toLowerCase()
  const cashLike = /cash|cod/.test(method)
  return upsertJournalEntry({
    date: toIsoDate(pay.date),
    description: `Supplier payment ${pay.ref ?? pay.id}`,
    reference: pay.ref ?? pay.id,
    referenceType: 'supplier-payment',
    referenceId: pay.id,
    source: 'erp',
    createdBy: createdBy ?? null,
    lines: [
      { accountCode: ACCOUNT_CODES.payable, debit: amount, description: `Paid ${pay.supplier ?? 'supplier'}`.trim() },
      { accountCode: cashLike ? ACCOUNT_CODES.cash : ACCOUNT_CODES.bank, credit: amount, description: 'Paid out' },
    ],
  })
}

export async function postSalesReturnJournal(returnId: string, createdBy?: string | null) {
  if (!db) return null
  const [ret] = await db.select().from(schema.salesReturns).where(eq(schema.salesReturns.id, returnId)).limit(1)
  if (!ret) return null
  const status = String(ret.status ?? '').toLowerCase()
  const amount = n(ret.amount)
  if (amount <= 0 || ['rejected', 'cancelled', 'requested', 'approved', 'in_transit'].includes(status)) {
    await removeJournalEntry('sales-return', returnId, createdBy ?? null).catch(() => undefined)
    return null
  }
  let invoice: any = null
  if (ret.invoiceId) [invoice] = await db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.id, ret.invoiceId as string)).limit(1)
  else if (ret.order) [invoice] = await db.select().from(schema.salesInvoices).where(eq(schema.salesInvoices.shopifyOrder, String(ret.order))).limit(1)
  const base = invoice ? Math.max(0.01, n(invoice.grandTotal) - n(invoice.tdsAmount)) : amount
  const gstTotal = invoice ? n(invoice.gstAmount) : 0
  const gstPortion = invoice && base > 0 ? round2(Math.min(gstTotal, (amount / base) * gstTotal)) : 0
  const revenuePortion = round2(Math.max(0, amount - gstPortion))
  const isShopify = !!(invoice?.shopifyOrder || ret.source === 'shopify' || String(ret.order ?? '').startsWith('#'))
  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [
    { accountCode: ACCOUNT_CODES.salesRevenue, debit: revenuePortion, description: `Sales return ${ret.number}` },
    { accountCode: ACCOUNT_CODES.receivable, credit: amount, description: `Credit note ${ret.creditNoteNumber || ret.number}` },
  ]
  if (gstPortion > 0) lines.splice(1, 0, { accountCode: ACCOUNT_CODES.gstOutput, debit: gstPortion, description: `GST reversal ${ret.number}` })
  const debit = round2(lines.reduce((s, l) => s + n(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + n(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) lines[0].debit = round2(n(lines[0].debit) + (credit - debit))
  return upsertJournalEntry({
    date: toIsoDate(ret.date ?? ret.requestedAt),
    description: `${isShopify ? 'Shopify' : 'ERP'} sales return ${ret.number}`,
    reference: ret.creditNoteNumber || ret.number,
    referenceType: 'sales-return',
    referenceId: ret.id,
    source: isShopify ? 'shopify' : 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function postPurchaseReturnJournal(returnId: string, createdBy?: string | null) {
  if (!db) return null
  const [ret] = await db.select().from(schema.purchaseReturns).where(eq(schema.purchaseReturns.id, returnId)).limit(1)
  if (!ret) return null
  const status = String(ret.status ?? '').toLowerCase()
  const amount = n(ret.amount)
  if (amount <= 0 || status === 'cancelled' || status === 'rejected' || status === 'pending') {
    await removeJournalEntry('purchase-return', returnId, createdBy ?? null).catch(() => undefined)
    return null
  }
  let inv: any = null
  if (ret.invoiceId) [inv] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.id, ret.invoiceId as string)).limit(1)
  const gstTotal = inv ? n(inv.tax) : 0
  const base = inv ? Math.max(0.01, n(inv.total)) : amount
  const gstPortion = inv && base > 0 ? round2(Math.min(gstTotal, (amount / base) * gstTotal)) : 0
  const expensePortion = round2(Math.max(0, amount - gstPortion))
  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [
    { accountCode: ACCOUNT_CODES.payable, debit: amount, description: `Purchase return ${ret.number}` },
    { accountCode: ACCOUNT_CODES.purchaseExpense, credit: expensePortion, description: `Return to supplier ${ret.supplier ?? ''}`.trim() },
  ]
  if (gstPortion > 0) lines.push({ accountCode: ACCOUNT_CODES.gstInput, credit: gstPortion, description: `GST input reversal ${ret.number}` })
  const debit = round2(lines.reduce((s, l) => s + n(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + n(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) lines[1].credit = round2(n(lines[1].credit) + (debit - credit))
  return upsertJournalEntry({
    date: toIsoDate(ret.date),
    description: `Purchase return ${ret.number}`,
    reference: ret.number,
    referenceType: 'purchase-return',
    referenceId: ret.id,
    source: 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function postRefundJournal(refundId: string, createdBy?: string | null) {
  if (!db) return null
  const [ref] = await db.select().from(schema.refunds).where(eq(schema.refunds.id, refundId)).limit(1)
  if (!ref) return null
  const status = String(ref.status ?? '').toLowerCase()
  const amount = n(ref.refundedAmount || ref.amount)
  if (status !== 'completed' || amount <= 0) {
    await removeJournalEntry('refund', refundId, createdBy ?? null).catch(() => undefined)
    return null
  }
  const method = String(ref.paymentMethod || ref.gateway || '').toLowerCase()
  const cashLike = /cash|cod/.test(method)
  // Real-data-only posting: refund paid back to customer reduces cash/bank and clears receivable/refund due.
  const lines: Array<{ accountCode: string; debit?: number; credit?: number; description?: string }> = [
    { accountCode: ACCOUNT_CODES.receivable, debit: round2(amount), description: `Refund ${ref.number}` },
    { accountCode: cashLike ? ACCOUNT_CODES.cash : ACCOUNT_CODES.bank, credit: round2(amount), description: `Refund paid ${ref.shopifyRefundId || ref.number}` },
  ]
  return upsertJournalEntry({
    date: toIsoDate(ref.processedAt ?? ref.createdAt),
    description: `${ref.source === 'shopify' ? 'Shopify' : 'ERP'} refund ${ref.number}`,
    reference: ref.shopifyRefundId || ref.number,
    referenceType: 'refund',
    referenceId: ref.id,
    source: ref.source === 'shopify' ? 'shopify' : 'erp',
    createdBy: createdBy ?? null,
    lines,
  })
}

export async function removeExpenseJournal(expenseId: string, createdBy?: string | null) {
  return removeJournalEntry('expense', expenseId, createdBy ?? null)
}
export async function removePaymentJournal(paymentId: string, createdBy?: string | null) {
  const a = await removeJournalEntry('payment', paymentId, createdBy ?? null)
  const b = await removeJournalEntry('supplier-payment', paymentId, createdBy ?? null)
  return a || b
}