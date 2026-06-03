/**
 * プリフェッチ要求の判定 — 副作用を持つ GET ルートを守るための単一ソース (続 119)
 *
 * 背景:
 *   Next.js App Router は `<Link>` を自動プリフェッチ (先読み GET) する。さらに
 *   ブラウザ/拡張/プレビュー生成も prefetch / prerender を行う。副作用を持つ GET
 *   (例: /auth/sign-out の cookie 削除) がこれらの先読みで実行されると「ページを
 *   開いただけでログアウト」等の事故になる。各 route で同じ判定を重複させると
 *   ドリフトするため、ここに集約する。
 *
 * 判定対象シグネチャ (Codex T1 review 続 119 で網羅性を強化):
 *   - `Next-Router-Prefetch: 1`        … Next.js App Router の <Link> プリフェッチ
 *   - `Purpose: prefetch` / `X-Purpose` … 一部ブラウザ/プロキシ (tokenize される場合があり includes 判定)
 *   - `Sec-Purpose: prefetch;...`       … 標準化された fetch metadata (prerender 含む)
 *   - `X-Moz: prefetch` / `prefetch-prerender` … Firefox 系
 */

function headerIncludes(value: string | null, needle: string): boolean {
  return (value ?? '').toLowerCase().includes(needle)
}

/** プリフェッチ / プリレンダ目的の要求なら true。副作用 (cookie 変更等) を行わない判断に使う。 */
export function isPrefetchRequest(request: Request): boolean {
  const h = request.headers
  if (h.get('next-router-prefetch') === '1') return true
  if (headerIncludes(h.get('purpose'), 'prefetch')) return true
  if (headerIncludes(h.get('x-purpose'), 'prefetch')) return true
  // Sec-Purpose は "prefetch" / "prefetch;prerender" 等。prerender も先読みなので拾う。
  if (headerIncludes(h.get('sec-purpose'), 'prefetch')) return true
  if (headerIncludes(h.get('sec-purpose'), 'prerender')) return true
  if (headerIncludes(h.get('x-moz'), 'prefetch')) return true
  return false
}
