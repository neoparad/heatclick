/**
 * ローカルパス限定の redirect 検証 — 単一ソース (続 119 security review)
 *
 * page (auth/dev-login) と API (api/auth/dev-login) で **同一ロジック** を使い、
 * 検証ドリフト (片方だけ緩い → open redirect / 壊れたリンク) を防ぐ。
 *
 * 許可:
 *   - '/' 始まりの相対パスのみ (今見ている host 内に留まる)
 * 拒否:
 *   - '/' 以外始まり (絶対 URL や scheme-relative の起点)
 *   - '//' や '/\' (別ホストへ化けうる scheme-relative)
 *   - 生のバックスラッシュ・空白・制御文字
 *   - percent-encoded のスラッシュ/バックスラッシュ/CRLF/NUL (%2f %5c %0d %0a %00)
 *     → middleware/proxy が decode した瞬間に // や /\ や header splitting に化ける
 */
export const SAFE_REDIRECT_MAX_LENGTH = 512

export function isSafeLocalRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > SAFE_REDIRECT_MAX_LENGTH) return false
  if (!value.startsWith('/')) return false
  if (value.startsWith('//')) return false
  // 生の危険文字 (バックスラッシュ / 空白 / 制御文字)
  if (/[\\\s\x00-\x1f]/.test(value)) return false
  // encoded slash / backslash / CR / LF / NUL — decode 後に化ける
  if (/%2f|%5c|%0d|%0a|%00/i.test(value)) return false
  // 1 回 decode して再検証 (decodeURIComponent が壊れた % 列で throw すれば拒否)
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }
  if (!decoded.startsWith('/')) return false
  if (decoded.startsWith('//')) return false
  if (/[\\\s\x00-\x1f]/.test(decoded)) return false
  return true
}

/** 安全なローカルパスならそのまま、危険なら undefined を返す。 */
export function sanitizeLocalRedirect(value: unknown): string | undefined {
  return isSafeLocalRedirect(value) ? value : undefined
}
