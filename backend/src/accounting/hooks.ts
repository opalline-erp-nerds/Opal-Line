import { logger } from '../logger'

const log = (label: string, id?: string) => (err: unknown) => logger.warn({ err, id }, label)

export function queueSalesInvoiceJournal(invoiceId: string, userId?: string | null) {
  void import('./postings').then(({ postSalesInvoiceJournal }) => postSalesInvoiceJournal(invoiceId, userId ?? null)).catch(log('Failed to sync sales invoice journal', invoiceId))
}
export function queuePurchaseInvoiceJournal(invoiceId: string, userId?: string | null) {
  void import('./postings').then(({ postPurchaseInvoiceJournal }) => postPurchaseInvoiceJournal(invoiceId, userId ?? null)).catch(log('Failed to sync purchase invoice journal', invoiceId))
}
export function queueExpenseJournal(expenseId: string, userId?: string | null) {
  void import('./postings').then(({ postExpenseJournal }) => postExpenseJournal(expenseId, userId ?? null)).catch(log('Failed to sync expense journal', expenseId))
}
export function queuePaymentJournal(paymentId: string, userId?: string | null) {
  void import('./postings').then(({ postPaymentJournal }) => postPaymentJournal(paymentId, userId ?? null)).catch(log('Failed to sync payment journal', paymentId))
}
export function queueSupplierPaymentJournal(paymentId: string, userId?: string | null) {
  void import('./postings').then(({ postSupplierPaymentJournal }) => postSupplierPaymentJournal(paymentId, userId ?? null)).catch(log('Failed to sync supplier payment journal', paymentId))
}
export function queueSalesReturnJournal(returnId: string, userId?: string | null) {
  void import('./postings').then(({ postSalesReturnJournal }) => postSalesReturnJournal(returnId, userId ?? null)).catch(log('Failed to sync sales return journal', returnId))
}
export function queuePurchaseReturnJournal(returnId: string, userId?: string | null) {
  void import('./postings').then(({ postPurchaseReturnJournal }) => postPurchaseReturnJournal(returnId, userId ?? null)).catch(log('Failed to sync purchase return journal', returnId))
}
export function queueRefundJournal(refundId: string, userId?: string | null) {
  void import('./postings').then(({ postRefundJournal }) => postRefundJournal(refundId, userId ?? null)).catch(log('Failed to sync refund journal', refundId))
}
export function queueRemoveExpenseJournal(expenseId: string, userId?: string | null) {
  void import('./postings').then(({ removeExpenseJournal }) => removeExpenseJournal(expenseId, userId ?? null)).catch(log('Failed to remove expense journal', expenseId))
}
export function queueRemovePaymentJournal(paymentId: string, userId?: string | null) {
  void import('./postings').then(({ removePaymentJournal }) => removePaymentJournal(paymentId, userId ?? null)).catch(log('Failed to remove payment journal', paymentId))
}
export function queueRemoveJournal(referenceType: string, referenceId: string, userId?: string | null) {
  void import('./journal').then(({ removeJournalEntry }) => removeJournalEntry(referenceType, referenceId, userId ?? null)).catch(log(`Failed to remove ${referenceType} journal`, referenceId))
}