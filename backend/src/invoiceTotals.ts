/**
 * Canonical invoice money math — ONE calculation path for every surface.
 *
 * Business rule (shared by sales invoices and quotations): GST is charged on
 * the subtotal (the sum of the line-item amounts) and the discount is deducted
 * from the grand total. The invoice row stores the result; the invoice screen,
 * the printable HTML, the PDF and the WhatsApp summary all render those
 * STORED values and never recalculate.
 *
 * Keep in sync with frontend/src/lib/printTemplate.ts, which renders exactly
 * these fields (Taxable Value = subtotal, CGST/SGST = gstAmount / 2,
 * Discount, Grand Total).
 */

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

export interface InvoiceTotals {
  /** GST money, charged on the subtotal (pre-discount). */
  gstAmount: number
  /** subtotal + gstAmount - discount, rounded to the paisa. */
  grandTotal: number
}

export function invoiceTotals(subtotal: number, gstRate: number, discount: number): InvoiceTotals {
  const gstAmount = roundMoney((subtotal * gstRate) / 100)
  const grandTotal = roundMoney(subtotal + gstAmount - discount)
  return { gstAmount, grandTotal }
}
