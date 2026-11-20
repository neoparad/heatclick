/**
 * UGOKI LINK v2 — 束 3-D (手順 10): 行為者単一登録簿・UA縮約・未知UA定足数
 *
 * 事業者 × 面 (surface) × 目的 (purpose) の単一登録簿。
 * - `Google-Extended` / `Applebot-Extended` / `__usage_ai-training` は HTTP 行為者ではなく
 *   `policy_only` 別枠として管理する (設計書 §7.1)。
 * - 標準ブラウザ UA は「系統＋版」へ縮約し、生 UA は自動操作証拠あり行のみ保持する (§7.3)。
 * - 未知 UA は「10 リクエスト以上かつ 3 ネットワーク以上」の定足数達成後にのみ見本保存する (§7.3)。
 *
 * 設計根拠:
 * - マスター設計書 v2 §7.1, §7.2, §7.3
 * - actors-final.md M1, Appendix A, C.M1
 * - facts/web-ai-agents.md §1–§8
 */

export const ACTOR_REGISTRY_VERSION = 'actors-reg/1' as const

export type ActorPurpose =
  | 'training'
  | 'search_index'
  | 'user_fetch'
  | 'hosted_browser_agent'
  | 'ads_check'
  | 'preview'
  | 'seo_tool'
  | 'web_search'

export type ActorSurface =
  | 'chatgpt'
  | 'claude'
  | 'perplexity'
  | 'google_search_ai'
  | 'gemini_app'
  | 'apple_intelligence'
  | 'copilot_bing'
  | 'amazon_ai'
  | 'meta_ai'
  | 'duckassist'
  | 'search_web'
  | 'training_corpus'
  | 'you_search'
  | 'own_instrument'

export type VerificationMethodKind =
  | 'http_sig'
  | 'sail_exclusive'
  | 'ip_feed'
  | 'fcrdns'
  | 'asn'

export type TraitBasis = 'vendor_stated' | 'measured' | 'unknown'

export interface MeasuredTrait<T> {
  readonly value: T
  readonly basis: TraitBasis
}

export interface ActorVerificationSpec {
  readonly method: VerificationMethodKind
  /** `lib/link/clocks/actor-evidence-snapshot.ts` の `source_id` */
  readonly source_id?: string
  /** FCrDNS で許可する逆引きホスト名サフィックス (例: `.googlebot.com`) */
  readonly fcrdns_suffixes?: readonly string[]
  /** ASN 一致の補助証拠 (検証ではなく `asn_consistent`) */
  readonly asns?: readonly number[]
  readonly exhaustive_basis: 'sail_flag' | 'vendor_statement' | 'none'
  readonly exclusive_scope: 'token' | 'operator' | 'none'
}

export interface ActorRegistryEntry {
  readonly actor_id: string
  readonly operator: string
  readonly surface: ActorSurface
  readonly purpose: ActorPurpose
  readonly ua_tokens: readonly string[]
  /** RFC 9421 `Signature-Agent` URI (例: `https://chatgpt.com`) */
  readonly signature_agents: readonly string[]
  readonly verification_methods: readonly ActorVerificationSpec[]
  readonly robots_scope: MeasuredTrait<'honours' | 'ignores_user_triggered' | 'partial' | 'unknown'>
  readonly executes_js: MeasuredTrait<boolean | null>
  readonly downloads_js_rate: MeasuredTrait<number | null>
  readonly is_own_instrument?: boolean
}

export interface PolicyOnlyTokenEntry {
  readonly kind: 'policy_only'
  readonly http_actor: false
  readonly token: string
  readonly operator: string
  readonly governs: string
  readonly affects_search_ranking: boolean
  readonly source_note: string
}

// ---------------------------------------------------------------------------
// Policy-Only Tokens (NEVER HTTP Actors — §7.1 / facts/web-ai-agents.md §5, §6)
// ---------------------------------------------------------------------------

export const POLICY_ONLY_REGISTRY: readonly PolicyOnlyTokenEntry[] = Object.freeze([
  Object.freeze({
    kind: 'policy_only',
    http_actor: false,
    token: 'Google-Extended',
    operator: 'google',
    governs: 'Gemini model training and grounding in Gemini Apps / Vertex AI API',
    affects_search_ranking: false,
    source_note: 'Standalone robots.txt product token; never appears in HTTP User-Agent',
  }),
  Object.freeze({
    kind: 'policy_only',
    http_actor: false,
    token: 'Applebot-Extended',
    operator: 'apple',
    governs: 'Use of Applebot-crawled data for Apple generative AI training',
    affects_search_ranking: false,
    source_note: 'Secondary robots.txt token; never crawls or appears in HTTP User-Agent',
  }),
  Object.freeze({
    kind: 'policy_only',
    http_actor: false,
    token: '__usage_ai-training',
    operator: 'ietf_aipref',
    governs: 'Shared machine-readable AI training preference signal (draft-kelley-aipref)',
    affects_search_ranking: false,
    source_note: 'Robots.txt preference signal only; no HTTP actor',
  }),
])

// ---------------------------------------------------------------------------
// Single Authoritative HTTP Actor Registry (act.G2)
// ---------------------------------------------------------------------------

export const ACTOR_REGISTRY: readonly ActorRegistryEntry[] = Object.freeze([
  // OpenAI
  Object.freeze({
    actor_id: 'openai:oai-searchbot',
    operator: 'openai',
    surface: 'chatgpt',
    purpose: 'search_index',
    ua_tokens: Object.freeze(['OAI-SearchBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'openai:oai-searchbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'openai:gptbot',
    operator: 'openai',
    surface: 'training_corpus',
    purpose: 'training',
    ua_tokens: Object.freeze(['GPTBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'openai:gptbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'openai:chatgpt-user',
    operator: 'openai',
    surface: 'chatgpt',
    purpose: 'user_fetch',
    ua_tokens: Object.freeze(['ChatGPT-User']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'openai:chatgpt-user',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'ignores_user_triggered', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'openai:oai-adsbot',
    operator: 'openai',
    surface: 'chatgpt',
    purpose: 'ads_check',
    ua_tokens: Object.freeze(['OAI-AdsBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'openai:oai-adsbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'unknown', basis: 'unknown' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'openai:chatgpt-cloud-browser',
    operator: 'openai',
    surface: 'chatgpt',
    purpose: 'hosted_browser_agent',
    ua_tokens: Object.freeze([]),
    signature_agents: Object.freeze(['https://chatgpt.com']),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'http_sig',
        source_id: 'openai:chatgpt-cloud-browser-jwks',
        exhaustive_basis: 'none',
        exclusive_scope: 'token',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'unknown', basis: 'unknown' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Anthropic
  Object.freeze({
    actor_id: 'anthropic:claudebot',
    operator: 'anthropic',
    surface: 'training_corpus',
    purpose: 'training',
    ua_tokens: Object.freeze(['ClaudeBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'anthropic:bots',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'anthropic:claude-searchbot',
    operator: 'anthropic',
    surface: 'claude',
    purpose: 'search_index',
    ua_tokens: Object.freeze(['Claude-SearchBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'anthropic:bots',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'anthropic:claude-user',
    operator: 'anthropic',
    surface: 'claude',
    purpose: 'user_fetch',
    ua_tokens: Object.freeze(['Claude-User']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'anthropic:bots',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'ignores_user_triggered', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'anthropic:claude-agent',
    operator: 'anthropic',
    surface: 'claude',
    purpose: 'hosted_browser_agent',
    ua_tokens: Object.freeze(['Claude-Agent']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'sail_exclusive',
        source_id: 'anthropic:claude-agent-sail',
        exhaustive_basis: 'sail_flag',
        exclusive_scope: 'token',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Perplexity
  Object.freeze({
    actor_id: 'perplexity:perplexitybot',
    operator: 'perplexity',
    surface: 'perplexity',
    purpose: 'search_index',
    ua_tokens: Object.freeze(['PerplexityBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'perplexity:perplexitybot',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'perplexity:perplexity-user',
    operator: 'perplexity',
    surface: 'perplexity',
    purpose: 'user_fetch',
    ua_tokens: Object.freeze(['Perplexity-User']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'perplexity:perplexity-user',
        exhaustive_basis: 'none',
        exclusive_scope: 'none',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'ignores_user_triggered', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Google
  Object.freeze({
    actor_id: 'google:googlebot',
    operator: 'google',
    surface: 'google_search_ai',
    purpose: 'web_search',
    ua_tokens: Object.freeze(['Googlebot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'google:common-crawlers',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
      Object.freeze({
        method: 'fcrdns',
        fcrdns_suffixes: Object.freeze(['.googlebot.com', '.google.com', '.googleusercontent.com']),
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'google:google-agent',
    operator: 'google',
    surface: 'gemini_app',
    purpose: 'hosted_browser_agent',
    ua_tokens: Object.freeze(['Google-Agent']),
    signature_agents: Object.freeze(['https://agent.bot.goog']),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'http_sig',
        source_id: 'google:google-agent-jwks',
        exhaustive_basis: 'none',
        exclusive_scope: 'token',
      }),
      Object.freeze({
        method: 'ip_feed',
        source_id: 'google:user-triggered-agents',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'ignores_user_triggered', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'google:gemini-notebook',
    operator: 'google',
    surface: 'gemini_app',
    purpose: 'user_fetch',
    ua_tokens: Object.freeze(['Google-GeminiNotebook', 'Google-NotebookLM']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'google:user-triggered-fetchers',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'ignores_user_triggered', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Apple
  Object.freeze({
    actor_id: 'apple:applebot',
    operator: 'apple',
    surface: 'apple_intelligence',
    purpose: 'web_search',
    ua_tokens: Object.freeze(['Applebot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'apple:applebot',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
      Object.freeze({
        method: 'fcrdns',
        fcrdns_suffixes: Object.freeze(['.applebot.apple.com']),
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Microsoft / Bing
  Object.freeze({
    actor_id: 'bing:bingbot',
    operator: 'microsoft',
    surface: 'copilot_bing',
    purpose: 'web_search',
    ua_tokens: Object.freeze(['bingbot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'bing:bingbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
      Object.freeze({
        method: 'fcrdns',
        fcrdns_suffixes: Object.freeze(['.search.msn.com']),
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Amazon
  Object.freeze({
    actor_id: 'amazon:amazonbot',
    operator: 'amazon',
    surface: 'amazon_ai',
    purpose: 'search_index',
    ua_tokens: Object.freeze(['Amazonbot', 'Amzn-SearchBot', 'Amzn-User']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'amazon:amazonbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Meta (ASN consistent only — no published IP feed)
  Object.freeze({
    actor_id: 'meta:meta-externalagent',
    operator: 'meta',
    surface: 'meta_ai',
    purpose: 'training',
    ua_tokens: Object.freeze(['meta-externalagent', 'meta-webindexer', 'meta-externalfetcher']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'asn',
        asns: Object.freeze([32934]),
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'partial', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Common Crawl & You.com
  Object.freeze({
    actor_id: 'commoncrawl:ccbot',
    operator: 'commoncrawl',
    surface: 'training_corpus',
    purpose: 'training',
    ua_tokens: Object.freeze(['CCBot']),
    signature_agents: Object.freeze([]),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'ip_feed',
        source_id: 'commoncrawl:ccbot',
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
      Object.freeze({
        method: 'fcrdns',
        fcrdns_suffixes: Object.freeze(['.crawl.commoncrawl.org']),
        exhaustive_basis: 'none',
        exclusive_scope: 'operator',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: false, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),
  Object.freeze({
    actor_id: 'you:youbot',
    operator: 'you',
    surface: 'you_search',
    purpose: 'search_index',
    ua_tokens: Object.freeze(['YouBot']),
    signature_agents: Object.freeze(['https://you.com']),
    verification_methods: Object.freeze([
      Object.freeze({
        method: 'http_sig',
        source_id: 'you:youbot-jwks',
        exhaustive_basis: 'none',
        exclusive_scope: 'token',
      }),
      Object.freeze({
        method: 'fcrdns',
        fcrdns_suffixes: Object.freeze(['.search.you.com']),
        exhaustive_basis: 'none',
        exclusive_scope: 'token',
      }),
    ]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: null, basis: 'unknown' }),
    downloads_js_rate: Object.freeze({ value: null, basis: 'unknown' }),
  }),

  // Own instrument (UGOKI / LINKTH CRAWL signed lab)
  Object.freeze({
    actor_id: 'ugoki:crawl-lab',
    operator: 'ugoki_crawl',
    surface: 'own_instrument',
    purpose: 'preview',
    ua_tokens: Object.freeze(['UGOKILinkLab', 'LinkthCrawl']),
    signature_agents: Object.freeze(['https://crawl.ugokilink.jp']),
    verification_methods: Object.freeze([]),
    robots_scope: Object.freeze({ value: 'honours', basis: 'vendor_stated' }),
    executes_js: Object.freeze({ value: true, basis: 'vendor_stated' }),
    downloads_js_rate: Object.freeze({ value: 1, basis: 'measured' }),
    is_own_instrument: true,
  }),
])

// ---------------------------------------------------------------------------
// Registry Lookup Helpers
// ---------------------------------------------------------------------------

export function lookupPolicyOnlyToken(tokenOrUa: string): PolicyOnlyTokenEntry | null {
  const low = tokenOrUa.toLowerCase()
  for (const entry of POLICY_ONLY_REGISTRY) {
    if (low.includes(entry.token.toLowerCase())) {
      return entry
    }
  }
  return null
}

export function findActorById(actorId: string): ActorRegistryEntry | null {
  return ACTOR_REGISTRY.find((a) => a.actor_id === actorId) ?? null
}

export function matchDeclaredActorByUa(rawUa: string | null | undefined): ActorRegistryEntry | null {
  if (!rawUa) return null
  const low = rawUa.toLowerCase()

  // Policy-only tokens (Google-Extended, Applebot-Extended) are NEVER matched as HTTP actors (§7.1)
  if (lookupPolicyOnlyToken(rawUa) !== null) {
    // Only match if a real HTTP actor token ALSO appears (e.g. "Googlebot"); never match policy token itself
    const stripped = POLICY_ONLY_REGISTRY.reduce(
      (acc, p) => acc.replace(new RegExp(p.token, 'gi'), ''),
      rawUa,
    )
    if (!stripped.trim()) return null
    return matchDeclaredActorByUa(stripped)
  }

  // Prefer longest matching token (so `Claude-Agent` beats `Claude`, `OAI-SearchBot` beats generic)
  let best: ActorRegistryEntry | null = null
  let bestLen = 0
  for (const entry of ACTOR_REGISTRY) {
    for (const tok of entry.ua_tokens) {
      if (low.includes(tok.toLowerCase()) && tok.length > bestLen) {
        best = entry
        bestLen = tok.length
      }
    }
  }
  return best
}

export function matchDeclaredActorBySignatureAgent(
  signatureAgentUri: string | null | undefined,
): ActorRegistryEntry | null {
  if (!signatureAgentUri) return null
  const norm = signatureAgentUri.trim().replace(/\/+$/, '').toLowerCase()
  for (const entry of ACTOR_REGISTRY) {
    for (const uri of entry.signature_agents) {
      if (uri.replace(/\/+$/, '').toLowerCase() === norm) {
        return entry
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Standard Browser UA Reduction (§7.3)
// ---------------------------------------------------------------------------

export interface ReducedBrowserUa {
  readonly is_standard_browser: boolean
  readonly family: string
  readonly major_version: string
  readonly reduced_label: string
}

/**
 * 標準ブラウザ（Chrome/Safari/Firefox/Edge・LINE/Yahoo/Googleアプリ内ブラウザ含む）の
 * 名乗りを「系統＋メジャー版」へ縮約する (§7.3)。
 * 知らない語を含むだけでは自動操作の証拠にしない。
 */
export function reduceStandardBrowserUa(rawUa: string | null | undefined): ReducedBrowserUa {
  if (!rawUa || !rawUa.trim()) {
    return Object.freeze({
      is_standard_browser: false,
      family: 'empty',
      major_version: '0',
      reduced_label: 'empty/0',
    })
  }

  // Check known in-app browsers first (LINE, Yahoo Japan, Google App, Instagram, Facebook)
  const inAppPatterns: ReadonlyArray<{ readonly family: string; readonly re: RegExp }> = [
    { family: 'LINE_InApp', re: /\bLine\/(\d+)/i },
    { family: 'YahooJP_InApp', re: /\bYJApp(?:-[A-Z]+)?\/(\d+)/i },
    { family: 'GoogleApp_InApp', re: /\bGSA\/(\d+)/i },
    { family: 'Instagram_InApp', re: /\bInstagram\s+(\d+)/i },
    { family: 'FB_InApp', re: /\bFBAV\/(\d+)/i },
  ]
  for (const p of inAppPatterns) {
    const m = p.re.exec(rawUa)
    if (m) {
      return Object.freeze({
        is_standard_browser: true,
        family: p.family,
        major_version: m[1],
        reduced_label: `${p.family}/${m[1]}`,
      })
    }
  }

  // Standard desktop/mobile browsers (order matters: Edg > Chrome > Firefox > Safari)
  const browserPatterns: ReadonlyArray<{ readonly family: string; readonly re: RegExp }> = [
    { family: 'Edge', re: /\bEdgA?i?OS?\/(\d+)/i },
    { family: 'Chrome', re: /\b(?:Chrome|CriOS)\/(\d+)/i },
    { family: 'Firefox', re: /\b(?:Firefox|FxiOS)\/(\d+)/i },
    { family: 'Safari', re: /\bVersion\/(\d+)[^ ]*\s+(?:Mobile\/\S+\s+)?Safari\//i },
  ]

  // Only classify as standard browser if Mozilla/5.0 prefix is present and no known bot token matched
  if (/^Mozilla\/5\.0\s*\(/i.test(rawUa) && matchDeclaredActorByUa(rawUa) === null) {
    for (const p of browserPatterns) {
      const m = p.re.exec(rawUa)
      if (m) {
        return Object.freeze({
          is_standard_browser: true,
          family: p.family,
          major_version: m[1],
          reduced_label: `${p.family}/${m[1]}`,
        })
      }
    }
  }

  // Unknown non-browser UA: extract leading token name only (no raw tail persisted before quorum!)
  const leadMatch = /^([A-Za-z0-9._-]{1,48})(?:\/(\d+))?/.exec(rawUa.trim())
  const fam = leadMatch ? leadMatch[1] : 'unknown'
  const ver = leadMatch?.[2] ?? '0'
  return Object.freeze({
    is_standard_browser: false,
    family: fam,
    major_version: ver,
    reduced_label: `${fam}/${ver}`,
  })
}

// ---------------------------------------------------------------------------
// Unknown UA Quorum Tracker (10 req AND 3 distinct networks — §7.3)
// ---------------------------------------------------------------------------

export const UNKNOWN_UA_MIN_REQUESTS = 10
export const UNKNOWN_UA_MIN_NETWORKS = 3

export interface UnknownUaQuorumEntry {
  readonly token_key: string
  readonly request_count: number
  readonly distinct_network_count: number
  readonly quorum_reached: boolean
  /** Saved ONLY after >= 10 requests from >= 3 distinct networks (§7.3); strictly null before quorum */
  readonly review_sample_ua: string | null
  readonly first_seen_at: string
  readonly last_seen_at: string
}

export class UnknownUaQuorumTracker {
  private readonly entries = new Map<
    string,
    {
      requestCount: number
      networks: Set<string>
      reviewSampleUa: string | null
      firstSeenAt: string
      lastSeenAt: string
    }
  >()

  constructor(
    private readonly minRequests = UNKNOWN_UA_MIN_REQUESTS,
    private readonly minNetworks = UNKNOWN_UA_MIN_NETWORKS,
  ) {}

  record(params: {
    readonly raw_ua: string
    readonly network_key: string
    readonly observed_at: string
  }): UnknownUaQuorumEntry {
    const reduced = reduceStandardBrowserUa(params.raw_ua)
    const tokenKey = reduced.family.toLowerCase()

    let state = this.entries.get(tokenKey)
    if (!state) {
      state = {
        requestCount: 0,
        networks: new Set<string>(),
        reviewSampleUa: null,
        firstSeenAt: params.observed_at,
        lastSeenAt: params.observed_at,
      }
      this.entries.set(tokenKey, state)
    }

    state.requestCount++
    state.networks.add(params.network_key)
    state.lastSeenAt = params.observed_at

    const reached =
      state.requestCount >= this.minRequests && state.networks.size >= this.minNetworks
    if (reached && state.reviewSampleUa === null) {
      state.reviewSampleUa = params.raw_ua.slice(0, 512)
    }

    return Object.freeze({
      token_key: tokenKey,
      request_count: state.requestCount,
      distinct_network_count: state.networks.size,
      quorum_reached: reached,
      review_sample_ua: state.reviewSampleUa,
      first_seen_at: state.firstSeenAt,
      last_seen_at: state.lastSeenAt,
    })
  }

  getEntry(tokenKey: string): UnknownUaQuorumEntry | null {
    const state = this.entries.get(tokenKey.toLowerCase())
    if (!state) return null
    const reached =
      state.requestCount >= this.minRequests && state.networks.size >= this.minNetworks
    return Object.freeze({
      token_key: tokenKey.toLowerCase(),
      request_count: state.requestCount,
      distinct_network_count: state.networks.size,
      quorum_reached: reached,
      review_sample_ua: state.reviewSampleUa,
      first_seen_at: state.firstSeenAt,
      last_seen_at: state.lastSeenAt,
    })
  }

  listReadyForReview(): readonly UnknownUaQuorumEntry[] {
    const out: UnknownUaQuorumEntry[] = []
    for (const tokenKey of this.entries.keys()) {
      const entry = this.getEntry(tokenKey)
      if (entry && entry.quorum_reached) out.push(entry)
    }
    return Object.freeze(out)
  }
}
