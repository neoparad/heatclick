/**
 * POST /api/auth/magic-link
 *
 * 親 SSOT §3.6.1 / §6.4 Sprint 1 / Part V §5.5.1 P-01
 *
 * Request:
 *   { email: string, redirect?: string }
 *
 * Response:
 *   200 { success: true }           — 常に成功扱い (列挙対策)
 *   429 { success: false, error }   — Rate limit 超過
 *   400 { success: false, error }   — 入力不正
 *
 * セキュリティ:
 *   - 公開 endpoint (middleware の PUBLIC_API_PATHS で除外)
 *   - email 単位の rate limit (1 分 5 回 / 1 時間 20 回)
 *   - user 存在チェックは行うが、レスポンスで存在有無を露呈しない
 *   - token は 15 分 expiry + Redis nonce で single-use
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import { redis } from '@/lib/redis'
import { resolveRequestOrigin } from '@/lib/app-url'
import { sendMagicLinkEmail } from '@/lib/resend'
import {
  signMagicLinkToken,
  generateNonce,
  MAGIC_LINK_EXPIRES_MIN,
} from '@/lib/auth/magic-link'

export const runtime = 'nodejs'

const requestSchema = z.object({
  email: z.string().email().max(254),
  redirect: z
    .string()
    .max(512)
    .regex(/^\/[^/].*$/, 'redirect must be a local path starting with /')
    .optional(),
})

// H-1 fix (Reviewer T1 dual 続 10): mailbomb 攻撃対策のため email 単位だけでなく
// IP 単位 + global 単位の rate limit を追加。enumeration 防止は維持しつつ
// 1 IP / 1 サブネット / 全体スループットで多層防御。
const MAGIC_LINK_RATE_LIMIT_PER_MIN = 5 // email/min
const MAGIC_LINK_RATE_LIMIT_PER_HOUR = 20 // email/hour
const MAGIC_LINK_IP_RATE_LIMIT_PER_HOUR = 30 // IP/hour
const MAGIC_LINK_GLOBAL_RATE_LIMIT_PER_HOUR = 1000 // 全体スループット上限

function extractClientIp(request: Request): string {
  // Vercel / Cloudflare では x-forwarded-for / x-real-ip / cf-connecting-ip。
  // 最初の hop のみを取る (rest は upstream proxy なので信用しない)。
  const h = request.headers
  const xff = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff
  const cf = h.get('cf-connecting-ip')
  if (cf) return cf
  const real = h.get('x-real-ip')
  if (real) return real
  return 'unknown'
}

/** IPv4 は /24、IPv6 は /48 でサブネット化 (precise IP は audit 用に別途記録) */
function subnetKey(ip: string): string {
  if (ip === 'unknown') return 'unknown'
  if (ip.includes(':')) {
    // IPv6: 最初の 3 group (= 48bit)
    const parts = ip.split(':').slice(0, 3)
    return parts.join(':') + ':/48'
  }
  // IPv4: /24
  const oct = ip.split('.')
  if (oct.length === 4) return `${oct[0]}.${oct[1]}.${oct[2]}.0/24`
  return ip
}

async function isRateLimited(
  emailKey: string,
  ip: string,
): Promise<{ limited: true; reason: string } | { limited: false }> {
  try {
    const client = redis()
    const subnet = subnetKey(ip)
    const minuteKey = `magic-link:rl:1m:${emailKey}`
    const hourKey = `magic-link:rl:1h:${emailKey}`
    const ipKey = `magic-link:rl:ip:1h:${subnet}`
    const globalKey = `magic-link:rl:global:1h`

    const minuteCount = await client.incr(minuteKey)
    if (minuteCount === 1) await client.expire(minuteKey, 60)

    const hourCount = await client.incr(hourKey)
    if (hourCount === 1) await client.expire(hourKey, 3600)

    const ipCount = await client.incr(ipKey)
    if (ipCount === 1) await client.expire(ipKey, 3600)

    const globalCount = await client.incr(globalKey)
    if (globalCount === 1) await client.expire(globalKey, 3600)

    if (minuteCount > MAGIC_LINK_RATE_LIMIT_PER_MIN) return { limited: true, reason: 'email-min' }
    if (hourCount > MAGIC_LINK_RATE_LIMIT_PER_HOUR) return { limited: true, reason: 'email-hour' }
    if (ipCount > MAGIC_LINK_IP_RATE_LIMIT_PER_HOUR) return { limited: true, reason: 'ip-hour' }
    if (globalCount > MAGIC_LINK_GLOBAL_RATE_LIMIT_PER_HOUR)
      return { limited: true, reason: 'global-hour' }

    return { limited: false }
  } catch {
    // Redis 失敗時は fail-open (UX 優先、Sentry で検知)
    return { limited: false }
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body', code: 'BAD_REQUEST' },
      { status: 400 },
    )
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid request',
        code: 'BAD_REQUEST',
      },
      { status: 400 },
    )
  }

  const email = parsed.data.email.toLowerCase().trim()
  const redirect = parsed.data.redirect
  const ip = extractClientIp(request)

  const rl = await isRateLimited(email, ip)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many requests', code: 'RATE_LIMITED' },
      { status: 429 },
    )
  }

  const jti = generateNonce()
  const token = await signMagicLinkToken({ email, jti, redirect })

  // single-use 用 nonce を Redis に登録 (TTL = expiry と一致)
  try {
    await redis().set(`magic-link:nonce:${jti}`, '1', 'EX', MAGIC_LINK_EXPIRES_MIN * 60)
  } catch {
    // Redis 不可なら nonce check 飛ばし fail-open (Sprint 1 の dogfood 規模では許容)
  }

  // Build verify URL.
  // 続 117 root-fix (本番 login bug の本丸):
  //   旧実装は固定 `NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` でリンク生成していた。
  //   ユーザーが ugokimap-saas.vercel.app を見ていてもリンクは ugokimap.com を指し、
  //   別 host でログイン成立 → Cookie は host 単位なので閲覧中の host には付かず、
  //   ページ遷移のたびに sign-in へ蹴られていた。
  //   resolveRequestOrigin() は今アクセス中の host (allowlist 検証済) でリンクを組み立て、
  //   ログイン host と閲覧 host を一致させる。allowlist 外なら canonical にフォールバック。
  const verifyUrl = new URL('/api/auth/verify', resolveRequestOrigin(request))
  verifyUrl.searchParams.set('token', token)

  // 送信 — user 存在チェックは Sprint 1 では行わず、全 email に送信 (dogfood 招待制で母数小)
  // Sprint 3 以降で user 存在チェック + 「存在しない場合は無音」化
  await sendMagicLinkEmail({
    to: email,
    magic_link_url: verifyUrl.toString(),
    expires_in_minutes: MAGIC_LINK_EXPIRES_MIN,
  })

  return NextResponse.json({ success: true })
}
