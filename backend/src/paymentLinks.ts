import { logger } from './logger'
import { fetchWithTimeout } from './lib/fetchTimeout'

const RAZORPAY_REQUEST_TIMEOUT_MS = 15_000

/**
 * Generate a Razorpay payment link for a given customer/amount.
 * Requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars.
 * Returns the payment link URL or null if not configured / failed.
 */
export async function createRazorpayPaymentLink(opts: {
  amount: number           // in INR (will be converted to paise)
  customer: string
  description: string
  referenceId?: string
  callbackUrl?: string
}): Promise<{ url: string; id: string } | null> {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim()
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim()
  if (!keyId || !keySecret) {
    logger.debug('Razorpay not configured — skipping payment link generation')
    return null
  }

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64')
    const res = await fetchWithTimeout(
      'https://api.razorpay.com/v1/payment_links',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: Math.round(opts.amount * 100), // paise
          currency: 'INR',
          accept_partial: false,
          description: opts.description,
          customer: {
            name: opts.customer,
            contact: opts.customer,
          },
          notify: {
            sms: false,
            email: true,
          },
          reference_id: opts.referenceId ?? `PL-${Date.now().toString(36).toUpperCase()}`,
          callback_url: opts.callbackUrl ?? undefined,
          callback_method: opts.callbackUrl ? 'get' : undefined,
        }),
      },
      RAZORPAY_REQUEST_TIMEOUT_MS,
      'Razorpay',
    )
    const data = await res.json() as Record<string, unknown>
    if (res.ok && data.short_url) {
      return { url: data.short_url as string, id: data.id as string }
    }
    logger.warn({ status: res.status, error: data }, 'Razorpay payment link creation failed')
    return null
  } catch (err) {
    logger.error({ err }, 'Razorpay payment link request failed')
    return null
  }
}

/**
 * Returns true if Razorpay env vars are present and look valid.
 */
export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim())
}
