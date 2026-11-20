import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ActorEvidenceClock,
  DEFAULT_EVIDENCE_SOURCES,
  FileSystemEvidenceSnapshotStore,
  InMemoryEvidenceSnapshotStore,
  POLICY_ONLY_TOKENS,
  SnapshotImmutabilityError,
  computeJwkThumbprintSha256,
  diffSnapshots,
  matchIpInCidrs,
  parseCidr,
  parseIpJsonFeed,
  parseRfc9421Jwks,
  parseSailTomlFeed,
  type EvidenceFetchResponse,
  type EvidenceFetcher,
  type EvidenceSourceDefinition,
} from './actor-evidence-snapshot'

const OPENAI_SEARCHBOT_DAY1 = JSON.stringify({
  creationTime: '2026-11-19T00:00:00Z',
  prefixes: [
    { ipv4Prefix: '20.15.240.64/28' },
    { ipv4Prefix: '13.65.240.240/28' },
    { ipv6Prefix: '2603:1030:20e:3::/64' },
  ],
})

const OPENAI_SEARCHBOT_DAY2 = JSON.stringify({
  creationTime: '2026-11-20T00:00:00Z',
  prefixes: [
    { ipv4Prefix: '20.15.240.64/28' },
    { ipv4Prefix: '52.230.152.0/24' },
    { ipv4Prefix: '52.230.152.128/25' },
    { ipv6Prefix: '2603:1030:20e:3::/64' },
  ],
})

const ANTHROPIC_BOTS_DAY1 = JSON.stringify({
  creationTime: '2026-10-20T00:00:00Z',
  prefixes: [{ ipv4Prefix: '160.79.104.0/23' }],
})

const ANTHROPIC_SAIL_DAY1 = `
# Anthropic SAIL — draft-kelley-webbotauth-sail-00
modified = "2026-11-20T00:00:00Z"
ttl_seconds = 3600

[agents."Claude-Agent"]
exhaustive = true
exclusive = true
ipv4 = [
  "160.79.104.10/32",
  "160.79.104.11/32",
]
ipv6 = [
  "2607:6bc0:0000:0000::1/128",
]
`

const ANTHROPIC_SAIL_DAY2 = `
modified = "2026-11-20T00:20:00Z"
ttl_seconds = 3600

[agents."Claude-Agent"]
exhaustive = true
exclusive = true
ipv4 = [
  "160.79.104.10/32",
  "160.79.104.12/32",
]
`

const OPENAI_JWKS_DAY1 = JSON.stringify({
  keys: [
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      kid: 'openai-2025-key',
      nbf: Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000),
      exp: Math.floor(Date.parse('2026-11-25T00:00:00Z') / 1000),
      signature_agent: 'https://chatgpt.com',
      purpose: 'ai',
    },
  ],
})

const OPENAI_JWKS_DAY2_ROTATED = JSON.stringify({
  keys: [
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '22rZBZLyDsgWT_8UzXRIPh8idwQbqjNmsxJbbQdIVSp',
      kid: 'openai-2026-key',
      nbf: Math.floor(Date.parse('2026-11-20T00:00:00Z') / 1000),
      exp: Math.floor(Date.parse('2027-11-25T00:00:00Z') / 1000),
      signature_agent: 'https://chatgpt.com',
      purpose: 'ai',
    },
  ],
})

const PERPLEXITY_DAY1 = JSON.stringify({
  creationTime: '2026-10-28T00:00:00Z',
  prefixes: [{ ipv4Prefix: '107.20.236.150/32' }],
})

const GOOGLE_COMMON_DAY1 = JSON.stringify({
  creationTime: '2026-11-20T00:00:00Z',
  prefixes: [{ ipv4Prefix: '66.249.64.0/19' }, { ipv6Prefix: '2001:4860:4801::/48' }],
})

const APPLE_DAY1 = JSON.stringify({
  creationTime: '2026-11-20T00:00:00Z',
  prefixes: [{ ipv4Prefix: '17.58.0.0/16' }],
})

const BING_DAY1 = JSON.stringify({
  creationTime: '2026-11-20T00:00:00Z',
  prefixes: [{ ipv4Prefix: '40.77.167.0/24' }],
})

const AMAZON_DAY1 = JSON.stringify({
  creationTime: '2026-11-20T00:00:00Z',
  prefixes: [{ ipv4Prefix: '54.236.1.0/24' }],
})

function makeMockFetcher(
  routes: Record<string, EvidenceFetchResponse | (() => EvidenceFetchResponse)>,
): EvidenceFetcher {
  return async (url) => {
    const entry = routes[url]
    if (!entry) {
      return { status: 404, body: 'Not Found' }
    }
    return typeof entry === 'function' ? entry() : entry
  }
}

describe('Bundle 0-D: Actor Evidence Snapshot Clock (lib/link/clocks)', () => {
  describe('Registry & Parsers', () => {
    it('registers all required major AI & search providers and excludes robots-only tokens', () => {
      const providers = new Set(DEFAULT_EVIDENCE_SOURCES.map((s) => s.provider))
      expect(providers.has('openai')).toBe(true)
      expect(providers.has('anthropic')).toBe(true)
      expect(providers.has('perplexity')).toBe(true)
      expect(providers.has('google')).toBe(true)
      expect(providers.has('apple')).toBe(true)
      expect(providers.has('bing')).toBe(true)
      expect(providers.has('amazon')).toBe(true)

      const allTokens = DEFAULT_EVIDENCE_SOURCES.flatMap((s) => [...s.actor_tokens])
      expect(allTokens).toContain('OAI-SearchBot')
      expect(allTokens).toContain('GPTBot')
      expect(allTokens).toContain('ChatGPT-User')
      expect(allTokens).toContain('ClaudeBot')
      expect(allTokens).toContain('Claude-Agent')
      expect(allTokens).toContain('PerplexityBot')
      expect(allTokens).toContain('Googlebot')
      expect(allTokens).toContain('Applebot')
      expect(allTokens).toContain('bingbot')
      expect(allTokens).toContain('Amazonbot')

      // Policy-only robots tokens must NEVER be registered as HTTP actor feeds
      for (const policyTok of POLICY_ONLY_TOKENS) {
        expect(allTokens).not.toContain(policyTok)
      }
      expect(POLICY_ONLY_TOKENS).toContain('Google-Extended')
      expect(POLICY_ONLY_TOKENS).toContain('Applebot-Extended')
    })

    it('parses IPv4/IPv6 CIDRs with canonicalization and longest-prefix matching', () => {
      expect(parseCidr('192.0.2.55/24')?.canonical).toBe('192.0.2.0/24')
      expect(parseCidr('192.0.2.55')?.canonical).toBe('192.0.2.55/32')
      expect(parseCidr('2001:0db8:0000:0000:0000:0000:0000:0001/64')?.canonical).toBe(
        '2001:db8::/64',
      )
      expect(parseCidr('::ffff:192.0.2.1/128')?.canonical).toBe('::ffff:c000:201/128')
      expect(parseCidr('999.0.0.1/24')).toBeNull()
      expect(parseCidr('192.0.2.1/33')).toBeNull()
      expect(parseCidr('2001:db8:::1/64')).toBeNull()

      const lpm = matchIpInCidrs('52.230.152.200', ['52.230.152.0/24', '52.230.152.128/25'])
      expect(lpm).toEqual({
        matched: true,
        matchedCidr: '52.230.152.128/25',
        prefixLength: 25,
      })

      const v6Hit = matchIpInCidrs('2603:1030:20e:3::cafe', ['2603:1030:20e:3::/64'])
      expect(v6Hit).toEqual({
        matched: true,
        matchedCidr: '2603:1030:20e:3::/64',
        prefixLength: 64,
      })
    })

    it('parses IP JSON, SAIL TOML, and RFC 9421 JWKS feeds deterministically', () => {
      const ipParsed = parseIpJsonFeed(OPENAI_SEARCHBOT_DAY1)
      expect(ipParsed.creation_time).toBe('2026-11-19T00:00:00Z')
      expect(ipParsed.cidrs).toEqual([
        '13.65.240.240/28',
        '20.15.240.64/28',
        '2603:1030:20e:3::/64',
      ])

      const sailParsed = parseSailTomlFeed(ANTHROPIC_SAIL_DAY1, 'Claude-Agent')
      expect(sailParsed.is_exhaustive_override).toBe(true)
      expect(sailParsed.exclusive_scope_override).toBe('token')
      expect(sailParsed.ttl_seconds_override).toBe(3600)
      expect(sailParsed.cidrs).toEqual([
        '160.79.104.10/32',
        '160.79.104.11/32',
        '2607:6bc0::1/128',
      ])

      const jwksParsed = parseRfc9421Jwks(OPENAI_JWKS_DAY1)
      expect(jwksParsed.jwks).toHaveLength(1)
      expect(jwksParsed.jwks[0].kty).toBe('OKP')
      expect(jwksParsed.jwks[0].crv).toBe('Ed25519')
      expect(jwksParsed.jwks[0].signature_agent).toBe('https://chatgpt.com')
      expect(jwksParsed.jwks[0].thumbprint_sha256).toBe(
        computeJwkThumbprintSha256({
          kty: 'OKP',
          crv: 'Ed25519',
          x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        }),
      )
    })
  })

  describe('Daily Snapshot Capture, Diff Detection & Alerts', () => {
    const testSources: readonly EvidenceSourceDefinition[] = DEFAULT_EVIDENCE_SOURCES.filter((s) =>
      [
        'openai:oai-searchbot',
        'openai:chatgpt-cloud-browser-jwks',
        'anthropic:bots',
        'anthropic:claude-agent-sail',
        'perplexity:perplexitybot',
        'google:common-crawlers',
        'apple:applebot',
        'bing:bingbot',
        'amazon:amazonbot',
      ].includes(s.source_id),
    )

    it('captures immutable daily snapshots across all providers with mock fetcher and detects diffs & alerts', async () => {
      const store = new InMemoryEvidenceSnapshotStore()
      let currentTime = new Date('2026-11-20T00:00:00.000Z')
      let day = 1

      const fetcher = makeMockFetcher({
        'https://openai.com/searchbot.json': () => ({
          status: 200,
          body: day === 1 ? OPENAI_SEARCHBOT_DAY1 : OPENAI_SEARCHBOT_DAY2,
          headers: { 'cache-control': 'max-age=28800', etag: `"v${day}"` },
        }),
        'https://chatgpt.com/.well-known/http-message-signatures-directory': () => ({
          status: 200,
          body: day === 1 ? OPENAI_JWKS_DAY1 : OPENAI_JWKS_DAY2_ROTATED,
          headers: { 'cache-control': 'max-age=86400' },
        }),
        'https://claude.com/crawling/bots.json': { status: 200, body: ANTHROPIC_BOTS_DAY1 },
        'https://claude.com/.well-known/sail': () => ({
          status: 200,
          body: day === 1 ? ANTHROPIC_SAIL_DAY1 : ANTHROPIC_SAIL_DAY2,
        }),
        'https://www.perplexity.ai/perplexitybot.json': { status: 200, body: PERPLEXITY_DAY1 },
        'https://developers.google.com/static/crawling/ipranges/common-crawlers.json': {
          status: 200,
          body: GOOGLE_COMMON_DAY1,
        },
        'https://search.developer.apple.com/applebot.json': { status: 200, body: APPLE_DAY1 },
        'https://www.bing.com/toolbox/bingbot.json': { status: 200, body: BING_DAY1 },
        'https://developer.amazon.com/amazonbot/ip-addresses/amazonbot.json': {
          status: 200,
          body: AMAZON_DAY1,
        },
      })

      const clock = new ActorEvidenceClock({
        store,
        sources: testSources,
        fetcher,
        now: () => currentTime,
        cadenceMode: 'nightly_wave0',
      })

      // Day 1 capture
      const day1Results = await clock.captureAll()
      expect(day1Results).toHaveLength(testSources.length)
      expect(day1Results.every((r) => r.ok)).toBe(true)

      const oaiDay1 = day1Results.find((r) => r.source_id === 'openai:oai-searchbot')!
      expect(oaiDay1.snapshot).not.toBeNull()
      expect(oaiDay1.snapshot!.fetched_at).toBe('2026-11-20T00:00:00.000Z')
      expect(oaiDay1.snapshot!.provider).toBe('openai')
      expect(oaiDay1.snapshot!.source_url).toBe('https://openai.com/searchbot.json')
      expect(oaiDay1.snapshot!.is_exhaustive).toBe(false)
      expect(oaiDay1.snapshot!.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.isFrozen(oaiDay1.snapshot)).toBe(true)
      expect(Object.isFrozen(oaiDay1.snapshot!.cidrs)).toBe(true)

      // OpenAI JWKS key expires 2026-11-25 (5 days away) -> key_expiring_soon alert!
      const jwksDay1 = day1Results.find((r) => r.source_id === 'openai:chatgpt-cloud-browser-jwks')!
      expect(jwksDay1.alerts.some((a) => a.kind === 'key_expiring_soon')).toBe(true)

      // Day 2 capture
      day = 2
      currentTime = new Date('2026-11-21T00:00:00.000Z')
      const day2Results = await clock.captureAll()
      expect(day2Results.every((r) => r.ok)).toBe(true)

      const oaiDay2 = day2Results.find((r) => r.source_id === 'openai:oai-searchbot')!
      expect(oaiDay2.diff!.content_changed).toBe(true)
      expect(oaiDay2.diff!.added_cidrs).toEqual(['52.230.152.0/24', '52.230.152.128/25'])
      expect(oaiDay2.diff!.removed_cidrs).toEqual(['13.65.240.240/28'])
      // Churn = (2 + 1) / max(3, 4) = 0.75 > 0.20 -> prefix_churn_exceeded alert!
      expect(oaiDay2.diff!.cidr_churn_ratio).toBeCloseTo(0.75, 5)
      expect(oaiDay2.alerts.some((a) => a.kind === 'prefix_churn_exceeded')).toBe(true)

      // Perplexity unchanged -> content_changed = false, no churn alert
      const pplxDay2 = day2Results.find((r) => r.source_id === 'perplexity:perplexitybot')!
      expect(pplxDay2.diff!.content_changed).toBe(false)
      expect(pplxDay2.diff!.added_cidrs).toEqual([])
      expect(pplxDay2.diff!.removed_cidrs).toEqual([])
      expect(pplxDay2.alerts).toHaveLength(0)

      // JWKS rotated -> 1 key added, 1 removed, no expiring_soon alert on new 2027 key
      const jwksDay2 = day2Results.find((r) => r.source_id === 'openai:chatgpt-cloud-browser-jwks')!
      expect(jwksDay2.diff!.added_key_thumbprints).toHaveLength(1)
      expect(jwksDay2.diff!.removed_key_thumbprints).toHaveLength(1)
      expect(jwksDay2.alerts).toHaveLength(0)
    })

    it('isolates per-source fetch failures and enforces JWKS security guardrails', async () => {
      const store = new InMemoryEvidenceSnapshotStore()
      const sources: EvidenceSourceDefinition[] = [
        DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'openai:gptbot')!,
        DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'openai:chatgpt-cloud-browser-jwks')!,
        DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'apple:applebot')!,
      ]

      const fetcher: EvidenceFetcher = async (url) => {
        if (url.includes('gptbot.json')) {
          return { status: 503, body: 'Service Unavailable' }
        }
        if (url.includes('http-message-signatures-directory')) {
          // Redirect on JWKS must be rejected!
          return { status: 200, body: OPENAI_JWKS_DAY1, redirected: true }
        }
        return { status: 200, body: APPLE_DAY1 }
      }

      const clock = new ActorEvidenceClock({
        store,
        sources,
        fetcher,
        now: () => new Date('2026-11-20T00:00:00.000Z'),
      })

      const results = await clock.captureAll()
      expect(results[0].ok).toBe(false)
      expect(results[0].alerts[0].kind).toBe('fetch_failed')
      expect(results[1].ok).toBe(false)
      expect(results[1].error).toContain('redirects')
      expect(results[2].ok).toBe(true)
      expect(results[2].snapshot?.provider).toBe('apple')
    })

    it('rejects tampering / overwriting existing snapshots in both InMemory and FileSystem stores', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ugk-clock-test-'))
      try {
        const memStore = new InMemoryEvidenceSnapshotStore()
        const fsStore = new FileSystemEvidenceSnapshotStore(tmpDir)
        const src = DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'apple:applebot')!
        const fixedDate = new Date('2026-11-20T00:00:00.000Z')

        const clockMem = new ActorEvidenceClock({
          store: memStore,
          sources: [src],
          fetcher: makeMockFetcher({ [src.source_url]: { status: 200, body: APPLE_DAY1 } }),
          now: () => fixedDate,
        })
        const res = await clockMem.captureSource(src)
        expect(res.ok).toBe(true)
        const snap = res.snapshot!

        // Exact idempotent append succeeds
        await expect(memStore.append(snap)).resolves.toBeUndefined()
        // Tampered sha256 with same snapshot_id MUST throw SnapshotImmutabilityError
        await expect(
          memStore.append({
            ...snap,
            sha256: '0'.repeat(64),
          }),
        ).rejects.toThrow(SnapshotImmutabilityError)

        // FileSystem store persistence & immutability
        await fsStore.append(snap)
        const loaded = await fsStore.listBySource(src.source_id)
        expect(loaded).toHaveLength(1)
        expect(loaded[0].sha256).toBe(snap.sha256)
        expect(loaded[0].cidrs).toEqual(['17.58.0.0/16'])

        // Tampered snapshot with same file path fails immutability check
        await expect(
          fsStore.append({
            ...snap,
            snapshot_id: 'tampered-id',
          }),
        ).rejects.toThrow(SnapshotImmutabilityError)
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('Historical Point-in-Time CIDR & RFC 9421 Key Queries', () => {
    it('answers point-in-time CIDR queries accurately across IP rotation, retro lookback, late_published, and staleness', async () => {
      const store = new InMemoryEvidenceSnapshotStore()
      const oaiSrc = DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'openai:oai-searchbot')!
      const anthBotsSrc = DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'anthropic:bots')!

      let nowIso = '2026-11-20T00:00:00.000Z'
      let oaiBody = OPENAI_SEARCHBOT_DAY1

      const clock = new ActorEvidenceClock({
        store,
        sources: [oaiSrc, anthBotsSrc],
        fetcher: makeMockFetcher({
          [oaiSrc.source_url]: () => ({
            status: 200,
            body: oaiBody,
            headers: { 'cache-control': 'max-age=86400' },
          }),
          [anthBotsSrc.source_url]: {
            status: 200,
            body: ANTHROPIC_BOTS_DAY1,
            headers: { 'cache-control': 'max-age=86400' },
          },
        }),
        now: () => new Date(nowIso),
      })

      // Day 1 capture (2026-11-20)
      await clock.captureAll()

      // Day 2 capture (2026-11-21) — 13.65.240.240/28 removed, 52.230.152.0/24 & /25 added
      nowIso = '2026-11-21T00:00:00.000Z'
      oaiBody = OPENAI_SEARCHBOT_DAY2
      await clock.captureAll()

      // 1) IP 13.65.240.245 was valid on Day 1
      const day1Hit = await clock.lookupIpAtTime({
        ip: '13.65.240.245',
        at: '2026-11-20T12:00:00.000Z',
        provider: 'openai',
      })
      expect(day1Hit.matched).toBe(true)
      expect(day1Hit.verification_result).toBe('verified')
      expect(day1Hit.matched_cidr).toBe('13.65.240.240/28')
      expect(day1Hit.snapshot_fetched_at).toBe('2026-11-20T00:00:00.000Z')

      // 2) Same IP 13.65.240.245 is NOT in Day 2 snapshot -> feed_miss (OpenAI feed is non-exhaustive)
      const day2Miss = await clock.lookupIpAtTime({
        ip: '13.65.240.245',
        at: '2026-11-21T12:00:00.000Z',
        provider: 'openai',
      })
      expect(day2Miss.matched).toBe(false)
      expect(day2Miss.verification_result).toBe('feed_miss')

      // 3) IP 52.230.152.200 was NOT in Day 1, appeared in Day 2 -> Day 1 query returns late_published!
      const day1Late = await clock.lookupIpAtTime({
        ip: '52.230.152.200',
        at: '2026-11-20T18:00:00.000Z',
        provider: 'openai',
      })
      expect(day1Late.matched).toBe(false)
      expect(day1Late.verification_result).toBe('late_published')
      expect(day1Late.matched_cidr).toBe('52.230.152.128/25')

      // 4) Same IP 52.230.152.200 on Day 2 -> verified with longest prefix /25 (not /24)
      const day2Hit = await clock.lookupIpAtTime({
        ip: '52.230.152.200',
        at: '2026-11-21T06:00:00.000Z',
        provider: 'openai',
      })
      expect(day2Hit.matched).toBe(true)
      expect(day2Hit.verification_result).toBe('verified')
      expect(day2Hit.matched_cidr).toBe('52.230.152.128/25')
      expect(day2Hit.prefix_length).toBe(25)

      // 5) Retroactive query BEFORE archive started (2026-11-15) -> verified_retro with snapshot_distance_days = 5
      const retroHit = await clock.lookupIpAtTime({
        ip: '20.15.240.70',
        at: '2026-11-15T00:00:00.000Z',
        provider: 'openai',
      })
      expect(retroHit.matched).toBe(true)
      expect(retroHit.verification_result).toBe('verified_retro')
      expect(retroHit.snapshot_distance_days).toBe(5)

      // 6) Stale query after valid_until (2026-11-25 without newer snapshot) -> unverifiable_stale_evidence
      const stale = await clock.lookupIpAtTime({
        ip: '20.15.240.70',
        at: '2026-11-25T00:00:00.000Z',
        provider: 'openai',
      })
      expect(stale.matched).toBe(false)
      expect(stale.verification_result).toBe('unverifiable_stale_evidence')

      // 7) Anthropic shared operator-level bots.json -> verified_operator when querying specific token
      const anthHit = await clock.lookupIpAtTime({
        ip: '160.79.104.200',
        at: '2026-11-20T10:00:00.000Z',
        actor_token: 'ClaudeBot',
      })
      expect(anthHit.matched).toBe(true)
      expect(anthHit.verification_result).toBe('verified_operator')
    })

    it('respects §13.1 nightly_wave0 vs production_poll rule for exhaustive SAIL refuted verdicts', async () => {
      const sailSrc = DEFAULT_EVIDENCE_SOURCES.find(
        (s) => s.source_id === 'anthropic:claude-agent-sail',
      )!

      // Case A: nightly_wave0 — even with 3 consecutive misses on exhaustive SAIL, must NOT refute (§13.1)
      const storeWave0 = new InMemoryEvidenceSnapshotStore()
      let t0 = Date.parse('2026-11-20T00:00:00.000Z')
      const clockWave0 = new ActorEvidenceClock({
        store: storeWave0,
        sources: [sailSrc],
        fetcher: makeMockFetcher({ [sailSrc.source_url]: { status: 200, body: ANTHROPIC_SAIL_DAY1 } }),
        now: () => new Date(t0),
        cadenceMode: 'nightly_wave0',
      })
      for (let i = 0; i < 3; i++) {
        await clockWave0.captureSource(sailSrc)
        t0 += 20 * 60 * 1000
      }

      const wave0Miss = await clockWave0.lookupIpAtTime({
        ip: '198.51.100.99',
        at: '2026-11-20T00:05:00.000Z',
        source_id: sailSrc.source_id,
      })
      expect(wave0Miss.matched).toBe(false)
      expect(wave0Miss.consecutive_misses).toBe(3)
      expect(wave0Miss.verification_result).toBe('feed_miss')

      // Case B: production_poll — 3 consecutive misses on exhaustive SAIL yields `refuted`
      const storeProd = new InMemoryEvidenceSnapshotStore()
      let t1 = Date.parse('2026-11-20T00:00:00.000Z')
      const clockProd = new ActorEvidenceClock({
        store: storeProd,
        sources: [sailSrc],
        fetcher: makeMockFetcher({ [sailSrc.source_url]: { status: 200, body: ANTHROPIC_SAIL_DAY1 } }),
        now: () => new Date(t1),
        cadenceMode: 'production_poll',
      })
      await clockProd.captureSource(sailSrc)
      t1 += 20 * 60 * 1000
      await clockProd.captureSource(sailSrc)

      // Only 2 snapshots so far -> still feed_miss (needs 3 consecutive misses!)
      const onlyTwoMisses = await clockProd.lookupIpAtTime({
        ip: '198.51.100.99',
        at: '2026-11-20T00:05:00.000Z',
        source_id: sailSrc.source_id,
      })
      expect(onlyTwoMisses.consecutive_misses).toBe(2)
      expect(onlyTwoMisses.verification_result).toBe('feed_miss')

      // 3rd snapshot -> now 3 consecutive misses -> refuted!
      t1 += 20 * 60 * 1000
      await clockProd.captureSource(sailSrc)
      const threeMisses = await clockProd.lookupIpAtTime({
        ip: '198.51.100.99',
        at: '2026-11-20T00:05:00.000Z',
        source_id: sailSrc.source_id,
      })
      expect(threeMisses.consecutive_misses).toBe(3)
      expect(threeMisses.verification_result).toBe('refuted')
      expect(threeMisses.is_exhaustive).toBe(true)

      // Positive verification on listed IPv6 address
      const positiveV6 = await clockProd.lookupIpAtTime({
        ip: '2607:6bc0::1',
        at: '2026-11-20T00:05:00.000Z',
        source_id: sailSrc.source_id,
      })
      expect(positiveV6.matched).toBe(true)
      expect(positiveV6.verification_result).toBe('verified')
      expect(positiveV6.matched_cidr).toBe('2607:6bc0::1/128')
    })

    it('looks up historical RFC 9421 signing keys across key rotation and expiration windows', async () => {
      const store = new InMemoryEvidenceSnapshotStore()
      const jwksSrc = DEFAULT_EVIDENCE_SOURCES.find(
        (s) => s.source_id === 'openai:chatgpt-cloud-browser-jwks',
      )!
      let nowIso = '2026-11-20T00:00:00.000Z'
      let body = OPENAI_JWKS_DAY1

      const clock = new ActorEvidenceClock({
        store,
        sources: [jwksSrc],
        fetcher: makeMockFetcher({
          [jwksSrc.source_url]: () => ({
            status: 200,
            body,
            headers: { 'cache-control': 'max-age=86400' },
          }),
        }),
        now: () => new Date(nowIso),
      })

      const snap1 = (await clock.captureSource(jwksSrc)).snapshot!
      const oldThumbprint = snap1.jwks[0].thumbprint_sha256

      nowIso = '2026-11-21T00:00:00.000Z'
      body = OPENAI_JWKS_DAY2_ROTATED
      const snap2 = (await clock.captureSource(jwksSrc)).snapshot!
      const newThumbprint = snap2.jwks[0].thumbprint_sha256

      const diff = diffSnapshots(snap1, snap2)
      expect(diff.added_key_thumbprints).toEqual([newThumbprint])
      expect(diff.removed_key_thumbprints).toEqual([oldThumbprint])

      // Lookup old key on Day 1 -> valid!
      const day1OldKey = await clock.lookupKeyAtTime({
        thumbprint_or_kid: oldThumbprint,
        at: '2026-11-20T12:00:00.000Z',
        provider: 'openai',
      })
      expect(day1OldKey.found).toBe(true)
      expect(day1OldKey.valid_at_time).toBe(true)
      expect(day1OldKey.reason).toBe('valid')
      expect(day1OldKey.snapshot_id).toBe(snap1.snapshot_id)

      // Lookup old key on Day 2 (after rotation) -> not_found!
      const day2OldKey = await clock.lookupKeyAtTime({
        thumbprint_or_kid: oldThumbprint,
        at: '2026-11-21T12:00:00.000Z',
        provider: 'openai',
      })
      expect(day2OldKey.found).toBe(false)
      expect(day2OldKey.reason).toBe('not_found')

      // Lookup new key by kid on Day 2 -> valid!
      const day2NewKey = await clock.lookupKeyAtTime({
        thumbprint_or_kid: 'openai-2026-key',
        at: '2026-11-21T12:00:00.000Z',
        provider: 'openai',
      })
      expect(day2NewKey.found).toBe(true)
      expect(day2NewKey.valid_at_time).toBe(true)
      expect(day2NewKey.key?.thumbprint_sha256).toBe(newThumbprint)
    })
  })
})
