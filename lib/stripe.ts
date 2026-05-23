/**
 * Stripe client + helpers
 *
 * 親 SSOT §2.4 / §6.5 S3-04 (Sprint 3 で本格化)
 * Sprint 0 S0-07 skeleton (実装は Sprint 3 で Stripe 審査完了後 W2-01)。
 */

import Stripe from 'stripe'

let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required')
    }
    _stripe = new Stripe(key, {
      // Sprint 0 scaffold drift fix (Frontend P-03 着工時、stripe@17.7 に追随)
      apiVersion: '2025-02-24.acacia',
      typescript: true,
    })
  }
  return _stripe
}

export const STRIPE_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER,
  growth: process.env.STRIPE_PRICE_ID_GROWTH,
  agency: process.env.STRIPE_PRICE_ID_AGENCY,
} as const

/**
 * Plan の月額表示用 (UI 表示、契約は Stripe Price ID を真とする)
 */
export const PLAN_PRICING = {
  free: { amount: 0, currency: 'jpy' },
  starter: { amount: 9800, currency: 'jpy' },
  growth: { amount: 29800, currency: 'jpy' },
  agency: { amount: 98000, currency: 'jpy' },
  enterprise: { amount: null, currency: 'jpy' },
} as const

/**
 * Stripe Checkout session 作成 (アップグレード時、Sprint 3)
 * TODO Sprint 3 S3-04: 実装
 */
export async function createCheckoutSession(_args: {
  tenant_id: string
  user_email: string
  plan: 'starter' | 'growth' | 'agency'
  success_url: string
  cancel_url: string
}): Promise<{ url: string }> {
  // TODO: getStripe().checkout.sessions.create(...)
  throw new Error('Sprint 3 S3-04 で実装予定')
}

/**
 * Stripe Webhook signature 検証 (Sprint 3)
 * TODO: stripe.webhooks.constructEvent(body, sig, secret)
 */
export function verifyWebhookSignature(body: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required')
  }
  return getStripe().webhooks.constructEvent(body, signature, secret)
}
