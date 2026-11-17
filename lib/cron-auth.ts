/**
 * Cron エンドポイント共通認証 (続134 ハードニング + 2026-11 fail-closed 化)。
 *
 * 背景:
 *   - 旧実装は `x-vercel-cron: '1'` ヘッダ単体で通していた。このヘッダは外部の誰でも付けられる
 *     ため、認証の根拠にならない (不正なジョブ実行 = 全テナント処理 / コスト)。
 *   - cron route は Vercel Cron (JWT なし) から呼ばれるので middleware では公開 (api-public) に
 *     なっており、**この関数が唯一の関所**。よって secret が無い構成では誰も通さない。
 *
 * 方針 (fail-closed):
 *   - `CRON_SECRET` (trim 後 16 文字以上) が設定されている → secret の一致を必須にする。
 *       受理: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron は secret 設定時にこれを送る)
 *             または `x-cron-secret: <CRON_SECRET>` (手動 invoke 用)
 *   - `CRON_SECRET` が未設定 / 空 / 16 文字未満 → **すべて拒否**し、サーバーログに理由を残す。
 *     Vercel の Production / Preview に CRON_SECRET を設定するまで定期ジョブは動かない
 *     (ローカルで試すときは .env.local に設定する)。
 *
 * 比較は constant-time (timing 漏洩防止)。
 */

import { timingSafeEqual } from 'node:crypto'

/** これ未満の secret は誤設定とみなして使わない (弱い secret で開けさせない)。 */
const MIN_SECRET_LENGTH = 16

export interface CronAuthResult {
  ok: boolean
  /** observability 用の理由ラベル (secret 値は含めない) */
  reason: 'bearer' | 'header-secret' | 'secret-mismatch' | 'secret-not-configured'
}

/** 長さ差で短絡せず constant-time 比較する (timing 漏洩防止)。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Cron リクエストを認可する。一致する `CRON_SECRET` を持つ要求だけを通す。
 */
export function checkCronAuth(request: Request): CronAuthResult {
  const expected = (process.env.CRON_SECRET ?? '').trim()

  if (expected.length < MIN_SECRET_LENGTH) {
    // eslint-disable-next-line no-console
    console.error(
      `[cron-auth] CRON_SECRET が未設定または ${MIN_SECRET_LENGTH} 文字未満のため、` +
        '定期ジョブの要求を拒否しました。環境変数 CRON_SECRET を設定してください。',
    )
    return { ok: false, reason: 'secret-not-configured' }
  }

  const auth = request.headers.get('authorization') ?? ''
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice('Bearer '.length), expected)) {
    return { ok: true, reason: 'bearer' }
  }
  const headerSecret = request.headers.get('x-cron-secret') ?? ''
  if (headerSecret && safeEqual(headerSecret, expected)) {
    return { ok: true, reason: 'header-secret' }
  }
  return { ok: false, reason: 'secret-mismatch' }
}

/** boolean だけ欲しい呼出側向けの薄いラッパ。 */
export function isCronAuthorized(request: Request): boolean {
  return checkCronAuth(request).ok
}
