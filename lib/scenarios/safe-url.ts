/**
 * M-Director security (REQ-SEC-003) — URL scheme allowlist for scenario CTA / image URLs.
 *
 * STRIDE threat model finding: `cta_url` / `image_url` were validated with `z.string().url()`
 * only, which accepts `javascript:`, `data:`, `blob:` and other dangerous schemes. When the
 * runtime later assigns these to `href` / `location` / `img.src`, a stored `javascript:` URL
 * becomes a click-to-XSS on the customer's first-party origin.
 *
 * Policy: HTTPS-only absolute URLs. Reject:
 *   - non-`https:` schemes (`http:`, `javascript:`, `data:`, `blob:`, `vbscript:`, `file:`, ...)
 *   - relative URLs (no scheme/host)
 *   - URLs with embedded credentials (`https://user:pass@host`)
 *
 * This is enforced at the write boundary (Zod schema in types.ts) AND mirrored client-side
 * in scenario-runtime.js (`_isSafeHttpsUrl`) as defense-in-depth.
 */

/**
 * Returns true only for syntactically valid, absolute `https:` URLs with no embedded
 * credentials. Everything else (relative, javascript:, data:, blob:, http:, ...) returns false.
 */
export function isSafeHttpsUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    // Relative URLs and malformed strings throw here.
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username.length > 0 || parsed.password.length > 0) return false
  if (parsed.hostname.length === 0) return false
  return true
}
