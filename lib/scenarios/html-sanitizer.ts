/**
 * M-Director security (REQ-SEC-001 / REQ-SEC-002) — server-side HTML sanitizer for
 * inline-HTML variants.
 *
 * STRIDE threat model finding: `HtmlVariantSchema.html` accepted arbitrary `z.string()`
 * with no content restriction, and the runtime later did `el.innerHTML = variant.html`
 * with no sanitization. A `<script>` / `<iframe>` / `on*=` payload stored by (or injected
 * into the config of) one tenant therefore executed as stored XSS on every customer's
 * first-party origin.
 *
 * This module sanitizes inline HTML at the WRITE boundary (repository create/update) using
 * the vetted `sanitize-html` allowlist sanitizer. Only a small set of safe presentational
 * tags/attributes survive. The high-signal XSS vectors the threat model named explicitly
 * (script/iframe/object/embed/form/style/..., `on*=` handlers, javascript:/vbscript:/data:/
 * blob: URLs) cause a HARD REJECT (not silent mangling) so the author sees an error rather
 * than a half-stripped surprise; everything else is reduced to the safe allowlist output.
 *
 * Defense-in-depth: scenario-runtime.js additionally runs an inline allowlist sanitizer
 * before insertion (in case a payload reaches the runtime by some other path).
 */

import sanitizeHtml from 'sanitize-html'

/** Safe presentational tags. No script/iframe/object/embed/form/input/style/link/meta. */
const ALLOWED_TAGS: ReadonlyArray<string> = [
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'br',
  'hr',
  'p',
  'div',
  'span',
  'section',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'figure',
  'figcaption',
  'img',
  'picture',
  'source',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
]

/**
 * Allowed attributes per tag. `on*` handlers are never allowed (sanitize-html drops any
 * attribute not in this allowlist). `style` is permitted on presentational containers but
 * its values are filtered by `allowedStyles` below (no url()/expression()/javascript:).
 */
const STYLE_TAGS: ReadonlyArray<string> = [
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'p',
  'div',
  'span',
  'section',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'figure',
  'figcaption',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
]

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  // Style-only defaults FIRST, then override the tags that need extra attributes.
  // (Order matters: a later key overwrites an earlier one with the same name.)
  ...Object.fromEntries(STYLE_TAGS.map((t) => [t, ['style']])),
  a: ['href', 'title', 'target', 'rel', 'style'],
  img: ['src', 'alt', 'width', 'height', 'style'],
  source: ['srcset', 'media', 'type'],
  td: ['colspan', 'rowspan', 'style'],
  th: ['colspan', 'rowspan', 'scope', 'style'],
}

/**
 * Allowed CSS properties (presentational only). sanitize-html validates each declaration's
 * VALUE against these regexes; anything not matching (incl. `url(...)`, `expression(...)`,
 * `javascript:`) is dropped from the stored output.
 */
const SAFE_STYLE_VALUE = [/^[#a-z0-9 .,%()/_'"-]+$/i]
const ALLOWED_STYLES: sanitize_html_AllowedStyles = {
  '*': {
    color: SAFE_STYLE_VALUE,
    'background-color': SAFE_STYLE_VALUE,
    background: SAFE_STYLE_VALUE,
    'font-family': [/^[a-z0-9 ,'"._-]+$/i],
    'font-size': [/^[0-9.]+(px|em|rem|%|pt)$/i],
    'font-weight': [/^[a-z0-9]+$/i],
    'font-style': [/^(normal|italic|oblique)$/i],
    'text-align': [/^(left|right|center|justify)$/i],
    'text-decoration': [/^[a-z0-9 -]+$/i],
    'line-height': [/^[0-9.]+(px|em|rem|%)?$/i],
    margin: [/^[0-9.px em rem %auto-]+$/i],
    'margin-top': [/^[0-9.]+(px|em|rem|%)$/i],
    'margin-bottom': [/^[0-9.]+(px|em|rem|%)$/i],
    'margin-left': [/^[0-9.]+(px|em|rem|%)$/i],
    'margin-right': [/^[0-9.]+(px|em|rem|%)$/i],
    padding: [/^[0-9.px em rem %-]+$/i],
    'padding-top': [/^[0-9.]+(px|em|rem|%)$/i],
    'padding-bottom': [/^[0-9.]+(px|em|rem|%)$/i],
    'padding-left': [/^[0-9.]+(px|em|rem|%)$/i],
    'padding-right': [/^[0-9.]+(px|em|rem|%)$/i],
    border: [/^[#a-z0-9 .px solid dashed dotted-]+$/i],
    'border-radius': [/^[0-9.]+(px|em|rem|%)$/i],
    display: [/^(block|inline|inline-block|flex|none)$/i],
    width: [/^[0-9.]+(px|em|rem|%|vw)$/i],
    'max-width': [/^[0-9.]+(px|em|rem|%|vw)$/i],
    height: [/^[0-9.]+(px|em|rem|%|vh)$/i],
    'max-height': [/^[0-9.]+(px|em|rem|%|vh)$/i],
  },
}

type sanitize_html_AllowedStyles = NonNullable<sanitizeHtml.IOptions['allowedStyles']>

/**
 * Tags/constructs whose mere presence triggers a hard reject. These are the high-signal
 * XSS vectors the threat model called out explicitly.
 */
const FORBIDDEN_TAG_REGEX =
  /<\s*\/?\s*(script|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|style|svg|math|template|noscript|frame|frameset|applet)\b/i
const EVENT_HANDLER_REGEX = /\son[a-z]+\s*=/i
const DANGEROUS_URL_SCHEME_REGEX = /(?:javascript|vbscript|data|blob)\s*:/i

export interface SanitizeHtmlVariantOptions {
  /** Max bytes after sanitize (defensive; schema already caps input at 8192). */
  maxLength?: number
}

export class HtmlSanitizationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'forbidden_tag'
      | 'event_handler'
      | 'dangerous_url'
      | 'empty_after_sanitize'
      | 'too_long',
  ) {
    super(message)
    this.name = 'HtmlSanitizationError'
  }
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedStyles: ALLOWED_STYLES,
  // https: only for href/src; sanitize-html drops other schemes (incl. javascript:/data:).
  allowedSchemes: ['https'],
  allowedSchemesByTag: { img: ['https'], a: ['https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: false,
}

/**
 * Sanitize an inline-HTML variant at the write boundary.
 *
 * Strategy (fail-closed on the named vectors, then allowlist-reduce the rest):
 *   1. Pre-scan the RAW input for the explicit forbidden vectors (script/iframe/object/
 *      embed/form/style/..., `on*=` handlers, javascript:/vbscript:/data:/blob: schemes).
 *      If any is present → throw HtmlSanitizationError so the author sees a clear error
 *      instead of silently getting a stripped value.
 *   2. Run sanitize-html with the safe allowlist; the returned string is what gets stored.
 *      Tags/attributes/styles outside the allowlist are dropped here (defense-in-depth on
 *      top of step 1, e.g. unknown novel vectors).
 *   3. Guard against a non-empty input that sanitizes down to empty (all content was
 *      disallowed markup) — reject so the author knows nothing usable was stored.
 *
 * Returns the sanitized HTML to persist.
 */
export function sanitizeHtmlVariant(rawHtml: string, options: SanitizeHtmlVariantOptions = {}): string {
  const maxLength = options.maxLength ?? 8192

  if (FORBIDDEN_TAG_REGEX.test(rawHtml)) {
    throw new HtmlSanitizationError(
      'inline HTML contains a forbidden tag (script/iframe/object/embed/form/style/...)',
      'forbidden_tag',
    )
  }
  if (EVENT_HANDLER_REGEX.test(rawHtml)) {
    throw new HtmlSanitizationError(
      'inline HTML contains an inline event handler (on*= attribute)',
      'event_handler',
    )
  }
  if (DANGEROUS_URL_SCHEME_REGEX.test(rawHtml)) {
    throw new HtmlSanitizationError(
      'inline HTML references a dangerous URL scheme (javascript:/vbscript:/data:/blob:)',
      'dangerous_url',
    )
  }

  const sanitized = sanitizeHtml(rawHtml, SANITIZE_OPTIONS)

  if (sanitized.length > maxLength) {
    throw new HtmlSanitizationError(`sanitized HTML exceeds ${maxLength} bytes`, 'too_long')
  }

  // A non-blank input that reduces to empty means every element was disallowed markup;
  // reject rather than silently store an empty variant.
  if (rawHtml.trim().length > 0 && sanitized.trim().length === 0) {
    throw new HtmlSanitizationError(
      'inline HTML contained no allowed presentational content after sanitization',
      'empty_after_sanitize',
    )
  }

  return sanitized
}
