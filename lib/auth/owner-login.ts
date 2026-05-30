/**
 * Owner 専用・メール不要ログイン (env secret 方式) の有効判定 — 単一ソース
 *
 * 背景 (続 119, 2026-05-30):
 *   dogfood 検証で magic-link が「検証ループに向かない」問題が継続。
 *   - 短い prod ドメイン (ugokimap-saas.vercel.app) と CLI deploy の長い alias で
 *     コード世代がズレ、magic-link の verify URL は allowlist 仕様で常に canonical
 *     (短い方) を指すため、新コードを載せた alias 側に Cookie を置けず検証不能。
 *   - そもそもメール往復自体が遅く、別ブラウザ起動等で host ズレも起きる。
 *
 *   そこで Owner / dogfood 用に「メール不要・環境変数の合言葉で、今見ている host に
 *   そのまま session Cookie を発行する」ログイン口を追加する。magic-link は温存。
 *
 * セキュリティ設計 (これ自体が新たな認証面 = T1):
 *   - `OWNER_LOGIN_SECRET` env が未設定なら **機能ごと無効** (API は 404、page は notFound)。
 *     → 本番で env を入れない限り攻撃面ゼロ。
 *   - 弱い secret 誤設定を防ぐため最低長 (16) 未満も無効扱い (fail-closed)。
 *   - 実際の認可は「secret 一致 (constant-time)」かつ「email が dogfood allowlist 内」の
 *     AND。発行する JWT は当該 user の実 tenant_id/plan/role で、tenant 分離は不変。
 *   - secret は HTTPS POST body でのみ送信 (URL に載せない → ログ/履歴/Referer に残さない)。
 */

/**
 * secret の最低長。これ未満が設定されていても無効化する (fail-closed)。
 * 24 = `openssl rand -hex 32` (64 文字) 等の十分強い値を要求し、短い人間記憶の
 * 合言葉での総当たりを実用上不可能にする (security review 続 119)。
 */
export const OWNER_LOGIN_MIN_SECRET_LENGTH = 24

/**
 * 設定済みかつ十分強い `OWNER_LOGIN_SECRET` を返す。未設定 / 空 / 短すぎる場合は null。
 * null = 機能無効 (API 404 / page notFound)。
 */
export function getOwnerLoginSecret(): string | null {
  const raw = process.env.OWNER_LOGIN_SECRET
  if (!raw) return null
  const secret = raw.trim()
  if (secret.length < OWNER_LOGIN_MIN_SECRET_LENGTH) return null
  return secret
}

/** Owner 専用ログインが有効か (env secret 設定済み + 十分強い)。 */
export function isOwnerLoginEnabled(): boolean {
  return getOwnerLoginSecret() !== null
}
