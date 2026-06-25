/**
 * CV経路分析 — URL / path の PII マスク
 *
 * council/Gemini 合意: URL の query には email / token / 個人名が紛れ込むため、
 * API が UI へ返す前に既知パターンをマスクする（GDPR / 個人情報保護法）。
 *
 * 方針:
 *   - query string は丸ごと落とす（path だけ残す）のが最も安全。
 *   - path 中に紛れた email / 長いトークン状文字列もマスクする。
 *   - 表示用ラベルにのみ使う。集計キーは別途 path 正規化済みを使う。
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
/** 20文字以上の英数字連続（トークン/ハッシュ/JWT 片）を伏字に */
const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g
/** path セグメントに紛れる機微キー（=value を伏字） */
const SENSITIVE_QS_KEYS = ['email', 'mail', 'token', 'code', 'tel', 'phone', 'name', 'pass']

/**
 * 表示用に URL を安全化する。
 *   1. query string を除去（ただし機微キーが無い軽量 query は残さず一律除去）
 *   2. email / token 状文字列をマスク
 * 戻り値は path（+ host 任意）のみ。
 */
export function maskUrlForDisplay(rawUrl: string): string {
  let path = rawUrl
  try {
    const u = new URL(rawUrl)
    path = u.pathname // query / hash を捨てる
  } catch {
    // 相対 path や不正 URL は ? 以降を素朴に除去
    const q = path.indexOf('?')
    if (q >= 0) path = path.slice(0, q)
    const h = path.indexOf('#')
    if (h >= 0) path = path.slice(0, h)
  }
  return maskSensitiveTokens(path)
}

/** path 文字列内の email / token をマスク（query を残す経路用の保険） */
export function maskSensitiveTokens(value: string): string {
  return value
    .replace(EMAIL_RE, '<email>')
    .replace(TOKEN_RE, (m) => `${m.slice(0, 4)}…`)
}

/** 集計キー用の path 正規化（query 除去・末尾スラッシュ統一）。表示前提でなく group-by 用。 */
export function normalizePath(rawUrl: string): string {
  let path = rawUrl
  try {
    path = new URL(rawUrl).pathname
  } catch {
    const q = path.indexOf('?')
    if (q >= 0) path = path.slice(0, q)
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path || '/'
}

export const SENSITIVE_QUERY_KEYS = SENSITIVE_QS_KEYS
