/**
 * Cron エンドポイント共通認証 (続134 ハードニング)。
 *
 * 背景: 旧実装は `x-vercel-cron: '1'` ヘッダ単体で通していた。Vercel が inbound の
 *   `x-vercel-*` を strip するか保証しきれないため、ヘッダ単体依存はスプーフ耐性が弱く、
 *   不正なジョブ実行 (全テナント処理 / コスト) を許す余地があった。
 *
 * 方針:
 *   - `CRON_SECRET` が設定されている (本番推奨) → **secret を必須**にし、スプーフ可能な
 *     `x-vercel-cron` 単体パスは受け付けない。
 *       受理: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron は secret 設定時にこれを送る)
 *             または `x-cron-secret: <CRON_SECRET>` (手動 invoke 用、後方互換)
 *   - `CRON_SECRET` 未設定 → cron を壊さないため `x-vercel-cron: '1'` に degrade しつつ
 *     warn を出す (Owner に「CRON_SECRET を設定して完全に閉じる」を促す)。
 *
 * 比較は constant-time (timing 漏洩防止)。
 */

import { timingSafeEqual } from 'node:crypto'

export interface CronAuthResult {
  ok: boolean
  /** observability 用の理由ラベル (secret 値は含めない) */
  reason:
    | 'bearer'
    | 'header-secret'
    | 'secret-mismatch'
    | 'vercel-cron-fallback'
    | 'no-secret-no-cron-header'
}

/** 長さ差で短絡せず constant-time 比較する (timing 漏洩防止)。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Cron リクエストを認可する。`CRON_SECRET` 設定時は secret 必須 (header 単体不可)。
 */
export function checkCronAuth(request: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET

  if (secret && secret.trim().length >= 16) {
    const expected = secret.trim()
    const auth = request.headers.get('authorization') ?? ''
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice('Bearer '.length), expected)) {
      return { ok: true, reason: 'bearer' }
    }
    const headerSecret = request.headers.get('x-cron-secret') ?? ''
    if (headerSecret && safeEqual(headerSecret, expected)) {
      return { ok: true, reason: 'header-secret' }
    }
    // secret が設定されている以上、x-vercel-cron 単体は受け付けない (スプーフ遮断)
    return { ok: false, reason: 'secret-mismatch' }
  }

  // CRON_SECRET 未設定: cron を壊さないため Vercel ヘッダに degrade (弱い) + 警告
  if (request.headers.get('x-vercel-cron') === '1') {
    // eslint-disable-next-line no-console
    console.warn(
      '[cron-auth] CRON_SECRET 未設定のため x-vercel-cron ヘッダを受理しました (弱い認証)。' +
        '本番では CRON_SECRET を設定してください。',
    )
    return { ok: true, reason: 'vercel-cron-fallback' }
  }

  return { ok: false, reason: 'no-secret-no-cron-header' }
}

/** boolean だけ欲しい呼出側向けの薄いラッパ。 */
export function isCronAuthorized(request: Request): boolean {
  return checkCronAuth(request).ok
}
