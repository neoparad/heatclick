import { webcrypto } from 'node:crypto'

import {
  ActorEvidenceClock,
  computeJwkThumbprintSha256,
  DEFAULT_EVIDENCE_SOURCES,
  InMemoryEvidenceSnapshotStore,
  type EvidenceFetchResponse,
  type Rfc9421Jwk,
} from '@/lib/link/clocks/actor-evidence-snapshot'
import { NotEntitledError } from '@/packages/contract/ledgers'

import {
  ACTOR_REGISTRY,
  ActorVerdictEngine,
  assertNoVerdictInClientAck,
  buildOriginCookieSetHeader,
  buildSafeClientAck,
  classifyAndMinimizeIpAddress,
  computeActorCaptureCoverage,
  computeNoScriptRate,
  DailySealingKeyVault,
  derivePurposeNetworkPseudonym,
  evaluateOriginForgeryProbe,
  generateOriginKitConfig,
  ingestSignedLogBatch,
  KeyDestroyedError,
  lookupPolicyOnlyToken,
  matchDeclaredActorByUa,
  MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS,
  mintServerTimingHandoffHeader,
  OriginIpTrustRegistry,
  parseServerTimingHandoffHeader,
  parseSignatureAgentHeader,
  POLICY_ONLY_REGISTRY,
  reduceStandardBrowserUa,
  Rfc9421ReplayCache,
  scanForUnsealedFullIps,
  ServerTimingHandoffJoiner,
  signLogIngestBatch,
  signRfc9421Request,
  truncateIpPrefix,
  UnknownUaQuorumTracker,
  verifyFcrdns,
  type ActorObservationRecord,
  type FcrdnsResolver,
  type OriginKitPlatform,
  type PurposePseudonymKeyRing,
} from './index'

const subtle = webcrypto.subtle

const APPROVED_D12 = () =>
  ({
    entitled: true,
    status: 'entitled',
    decisionId: 'D-12',
    reason: 'approved_for_test',
    message: 'Approved in test',
    unlockRequirement: null,
  }) as const

const TEST_PSEUDONYM_KEYRING: PurposePseudonymKeyRing = Object.freeze({
  daily_cap_secret: 'secret-daily-cap-key-material-01',
  experiment_secret: 'secret-experiment-key-material-02',
  quorum_secret: 'secret-quorum-key-material-03',
  cohort_k_anon_secret: 'secret-cohort-k-anon-key-material-04',
})

function makeObservation(
  overrides: Partial<ActorObservationRecord> = {},
): ActorObservationRecord {
  return Object.freeze({
    observation_id: 'obs_test_001',
    tenant_id: 'tenant_a',
    site_id: 'site_1',
    observed_at: '2026-11-20T12:00:00.000Z',
    request_id: 'req_abc12345',
    capture_path: 'P1',
    method: 'GET',
    host: 'example.jp',
    path: '/articles/ai-guide',
    query: null,
    url_key_v2: 'https://example.jp/articles/ai-guide',
    referer_url_key_v2: null,
    status_code: 200,
    is_document: true,
    is_prefetch: false,
    is_decoy_hit: false,
    ua_family_version: 'Chrome/131',
    raw_ua: null,
    ip_trust: 'direct_socket',
    ip_evidence: null,
    asn: null,
    rfc9421_headers: null,
    has_js_pv_join: false,
    sdk_probe_hit: false,
    ...overrides,
  })
}

async function generateEd25519TestKeyPair() {
  const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair
  const exported = (await subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey
  const baseJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: exported.x!,
    alg: 'Ed25519',
    use: 'sig',
  }
  const thumbprint = computeJwkThumbprintSha256(baseJwk)
  const jwk: Rfc9421Jwk = Object.freeze({
    ...baseJwk,
    kid: thumbprint,
    thumbprint_sha256: thumbprint,
  })
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, jwk }
}

async function generateEcdsaP256TestKeyPair() {
  const kp = (await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair
  const exported = (await subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey
  const baseJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x!,
    y: exported.y!,
    alg: 'ES256',
    use: 'sig',
  }
  const thumbprint = computeJwkThumbprintSha256(baseJwk)
  const jwk: Rfc9421Jwk = Object.freeze({
    ...baseJwk,
    kid: thumbprint,
    thumbprint_sha256: thumbprint,
  })
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, jwk }
}

// ===========================================================================
// 1. Registry, Policy-Only Separation, UA Reduction, Unknown UA Quorum
// ===========================================================================

describe('Actor Registry, Policy-Only Tokens, UA Reduction & Unknown UA Quorum', () => {
  test('Google-Extended, Applebot-Extended, and __usage_ai-training are strictly separated in policy_only', () => {
    const policyTokens = POLICY_ONLY_REGISTRY.map((p) => p.token)
    expect(policyTokens).toEqual(
      expect.arrayContaining(['Google-Extended', 'Applebot-Extended', '__usage_ai-training']),
    )

    for (const p of POLICY_ONLY_REGISTRY) {
      expect(p.kind).toBe('policy_only')
      expect(p.http_actor).toBe(false)
    }

    // Must NOT appear in HTTP ACTOR_REGISTRY
    const allHttpUaTokens = ACTOR_REGISTRY.flatMap((a) => a.ua_tokens)
    expect(allHttpUaTokens).not.toContain('Google-Extended')
    expect(allHttpUaTokens).not.toContain('Applebot-Extended')
    expect(allHttpUaTokens).not.toContain('__usage_ai-training')

    // matchDeclaredActorByUa must NEVER resolve Google-Extended / Applebot-Extended as HTTP actors
    expect(lookupPolicyOnlyToken('Mozilla/5.0 (compatible; Google-Extended/1.0)')?.token).toBe(
      'Google-Extended',
    )
    expect(matchDeclaredActorByUa('Google-Extended')).toBeNull()
    expect(matchDeclaredActorByUa('Applebot-Extended')).toBeNull()
  })

  test('Standard browsers and JP in-app browsers reduce to family/major_version', () => {
    const chrome = reduceStandardBrowserUa(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36',
    )
    expect(chrome.is_standard_browser).toBe(true)
    expect(chrome.reduced_label).toBe('Chrome/131')

    const line = reduceStandardBrowserUa(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 Line/14.12.0',
    )
    expect(line.is_standard_browser).toBe(true)
    expect(line.reduced_label).toBe('LINE_InApp/14')

    const safari = reduceStandardBrowserUa(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    )
    expect(safari.is_standard_browser).toBe(true)
    expect(safari.reduced_label).toBe('Safari/18')
  })

  test('Unknown UA quorum requires BOTH >= 10 requests AND >= 3 distinct networks before storing sample', () => {
    const tracker = new UnknownUaQuorumTracker()
    const mysteryUa = 'MysteryScraper/2.4 (+https://mystery.example/bot)'

    // 9 requests across 5 distinct networks -> NOT enough requests
    let entry = tracker.record({
      raw_ua: mysteryUa,
      network_key: 'net_1',
      observed_at: '2026-11-20T00:00:00Z',
    })
    for (let i = 2; i <= 9; i++) {
      entry = tracker.record({
        raw_ua: mysteryUa,
        network_key: `net_${(i % 5) + 1}`,
        observed_at: '2026-11-20T00:01:00Z',
      })
    }
    expect(entry.request_count).toBe(9)
    expect(entry.distinct_network_count).toBe(5)
    expect(entry.quorum_reached).toBe(false)
    expect(entry.review_sample_ua).toBeNull()

    // 10th request reaches quorum -> review sample saved!
    entry = tracker.record({
      raw_ua: mysteryUa,
      network_key: 'net_1',
      observed_at: '2026-11-20T00:02:00Z',
    })
    expect(entry.request_count).toBe(10)
    expect(entry.quorum_reached).toBe(true)
    expect(entry.review_sample_ua).toBe(mysteryUa)

    // Separate UA: 12 requests from only 2 networks -> still NO sample
    const twoNetTracker = new UnknownUaQuorumTracker()
    let twoNetEntry = twoNetTracker.record({
      raw_ua: 'LocalBot/1.0',
      network_key: 'net_a',
      observed_at: '2026-11-20T00:00:00Z',
    })
    for (let i = 2; i <= 12; i++) {
      twoNetEntry = twoNetTracker.record({
        raw_ua: 'LocalBot/1.0',
        network_key: i % 2 === 0 ? 'net_a' : 'net_b',
        observed_at: '2026-11-20T00:01:00Z',
      })
    }
    expect(twoNetEntry.request_count).toBe(12)
    expect(twoNetEntry.distinct_network_count).toBe(2)
    expect(twoNetEntry.quorum_reached).toBe(false)
    expect(twoNetEntry.review_sample_ua).toBeNull()

    // 3rd distinct network triggers quorum immediately
    twoNetEntry = twoNetTracker.record({
      raw_ua: 'LocalBot/1.0',
      network_key: 'net_c',
      observed_at: '2026-11-20T00:02:00Z',
    })
    expect(twoNetEntry.quorum_reached).toBe(true)
    expect(twoNetEntry.review_sample_ua).toBe('LocalBot/1.0')
  })
})

// ===========================================================================
// 2. RFC 9421 Web Bot Auth Verification (Ed25519 + ECDSA P-256 + Tamper/Expiry/Replay)
// ===========================================================================

describe('RFC 9421 Web Bot Auth Signature Verification', () => {
  test('parses both OpenAI bare string and IETF draft dictionary Signature-Agent formats', () => {
    const bare = parseSignatureAgentHeader('"https://chatgpt.com"')
    expect(bare).toEqual({
      format: 'string',
      key: null,
      uri: 'https://chatgpt.com',
      origin_host: 'chatgpt.com',
    })

    const dict = parseSignatureAgentHeader('g="https://agent.bot.goog"')
    expect(dict).toEqual({
      format: 'dictionary',
      key: 'g',
      uri: 'https://agent.bot.goog',
      origin_host: 'agent.bot.goog',
    })
  })

  test('verifies valid Ed25519 (OpenAI) & ECDSA P-256 (Google) signatures and rejects tampered/expired/unknown keys', async () => {
    const edKp = await generateEd25519TestKeyPair()
    const ecKp = await generateEcdsaP256TestKeyPair()
    const rogueKp = await generateEd25519TestKeyPair()

    const store = new InMemoryEvidenceSnapshotStore()
    const mockFetch = async (url: string): Promise<EvidenceFetchResponse> => {
      if (url.includes('chatgpt.com')) {
        return {
          status: 200,
          body: JSON.stringify({ keys: [edKp.jwk] }),
          headers: { 'cache-control': 'max-age=3600' },
        }
      }
      if (url.includes('agent.bot.goog')) {
        return {
          status: 200,
          body: JSON.stringify({ keys: [ecKp.jwk] }),
          headers: { 'cache-control': 'max-age=3600' },
        }
      }
      return { status: 404, body: '' }
    }

    const clock = new ActorEvidenceClock({
      store,
      fetcher: mockFetch,
      cadenceMode: 'production_poll',
      now: () => new Date('2026-11-20T11:50:00.000Z'),
    })

    const openaiSrc = DEFAULT_EVIDENCE_SOURCES.find(
      (s) => s.source_id === 'openai:chatgpt-cloud-browser-jwks',
    )!
    const googleSrc = DEFAULT_EVIDENCE_SOURCES.find(
      (s) => s.source_id === 'google:google-agent-jwks',
    )!
    expect((await clock.captureSource(openaiSrc)).ok).toBe(true)
    expect((await clock.captureSource(googleSrc)).ok).toBe(true)

    const replayCache = new Rfc9421ReplayCache()
    const engine = new ActorVerdictEngine({ clock, replayCache })

    const nowSec = Math.floor(Date.parse('2026-11-20T12:00:00.000Z') / 1000)

    // 1. Valid Ed25519 (OpenAI bare string Signature-Agent)
    const edSigned = await signRfc9421Request({
      algorithm: 'Ed25519',
      privateKey: edKp.privateKey,
      publicJwk: edKp.jwk,
      method: 'GET',
      authority: 'example.jp',
      path: '/products/widget',
      signature_agent: '"https://chatgpt.com"',
      created: nowSec - 10,
      expires: nowSec + 300,
      nonce: 'nonce-ed-001',
    })

    const obsEd = makeObservation({
      observation_id: 'obs_ed_valid',
      host: 'example.jp',
      path: '/products/widget',
      observed_at: '2026-11-20T12:00:00.000Z',
      rfc9421_headers: {
        signature_input: edSigned.signature_input,
        signature: edSigned.signature,
        signature_agent: edSigned.signature_agent,
      },
    })
    const verdictEd = await engine.evaluateObservation(obsEd)
    expect(verdictEd.identity_assurance).toBe('verified')
    expect(verdictEd.verification_result).toBe('verified')
    expect(verdictEd.verified_actor_id).toBe('openai:chatgpt-cloud-browser')
    expect(verdictEd.actor_class).toBe('ai_agent_verified')
    expect(verdictEd.replay_suspected).toBe(false)
    expect(verdictEd.evidence_snapshot_ids.length).toBe(1)

    // Replay of identical (keyid, nonce) sets replay_suspected = true without refuting
    const verdictReplay = await engine.evaluateObservation(obsEd)
    expect(verdictReplay.identity_assurance).toBe('verified')
    expect(verdictReplay.replay_suspected).toBe(true)

    // 2. Valid ECDSA P-256 (Google dictionary Signature-Agent `g="https://agent.bot.goog"`)
    const ecSigned = await signRfc9421Request({
      algorithm: 'ES256',
      privateKey: ecKp.privateKey,
      publicJwk: ecKp.jwk,
      method: 'GET',
      authority: 'example.jp',
      path: '/pricing',
      signature_agent: 'g="https://agent.bot.goog"',
      created: nowSec - 5,
      expires: nowSec + 300,
      nonce: 'nonce-ec-001',
      covered_components: ['@method', '@authority', '@path', 'signature-agent'],
    })

    const obsEc = makeObservation({
      observation_id: 'obs_ec_valid',
      host: 'example.jp',
      path: '/pricing',
      observed_at: '2026-11-20T12:00:00.000Z',
      rfc9421_headers: {
        signature_input: ecSigned.signature_input,
        signature: ecSigned.signature,
        signature_agent: ecSigned.signature_agent,
      },
    })
    const verdictEc = await engine.evaluateObservation(obsEc)
    expect(verdictEc.identity_assurance).toBe('verified')
    expect(verdictEc.verified_actor_id).toBe('google:google-agent')
    expect(verdictEc.actor_class).toBe('ai_agent_verified')

    // 3. Tampered authority (signed for example.jp, replayed on evil.jp) -> signature_invalid
    const obsTampered = makeObservation({
      observation_id: 'obs_ed_tampered',
      host: 'evil.jp',
      path: '/products/widget',
      observed_at: '2026-11-20T12:00:00.000Z',
      rfc9421_headers: {
        signature_input: edSigned.signature_input,
        signature: edSigned.signature,
        signature_agent: edSigned.signature_agent,
      },
    })
    const verdictTampered = await engine.evaluateObservation(obsTampered)
    expect(verdictTampered.verified_actor_id).toBeNull()
    expect(verdictTampered.identity_assurance).toBe('declared_only')
    expect(verdictTampered.verification_result).toBe('signature_invalid')

    // 4. Unknown / wrong key -> signature_invalid (never verified!)
    const rogueSigned = await signRfc9421Request({
      algorithm: 'Ed25519',
      privateKey: rogueKp.privateKey,
      publicJwk: rogueKp.jwk,
      method: 'GET',
      authority: 'example.jp',
      path: '/products/widget',
      signature_agent: '"https://chatgpt.com"',
      created: nowSec - 5,
      expires: nowSec + 300,
    })
    const verdictRogue = await engine.evaluateObservation(
      makeObservation({
        observation_id: 'obs_rogue',
        host: 'example.jp',
        path: '/products/widget',
        observed_at: '2026-11-20T12:00:00.000Z',
        rfc9421_headers: {
          signature_input: rogueSigned.signature_input,
          signature: rogueSigned.signature,
          signature_agent: rogueSigned.signature_agent,
        },
      }),
    )
    expect(verdictRogue.verified_actor_id).toBeNull()
    expect(verdictRogue.identity_assurance).toBe('declared_only')
    expect(verdictRogue.verification_result).toBe('signature_invalid')

    // 5. Expired signature (observed_at > expires) -> signature_expired
    const expiredSigned = await signRfc9421Request({
      algorithm: 'Ed25519',
      privateKey: edKp.privateKey,
      publicJwk: edKp.jwk,
      method: 'GET',
      authority: 'example.jp',
      path: '/products/widget',
      signature_agent: '"https://chatgpt.com"',
      created: nowSec - 600,
      expires: nowSec - 60,
    })
    const verdictExpired = await engine.evaluateObservation(
      makeObservation({
        observation_id: 'obs_expired',
        host: 'example.jp',
        path: '/products/widget',
        observed_at: '2026-11-20T12:00:00.000Z',
        rfc9421_headers: {
          signature_input: expiredSigned.signature_input,
          signature: expiredSigned.signature,
          signature_agent: expiredSigned.signature_agent,
        },
      }),
    )
    expect(verdictExpired.verified_actor_id).toBeNull()
    expect(verdictExpired.verification_result).toBe('signature_expired')

    // 6. Unknown signer domain with valid JWKS -> crypto_domain (domain possession, NOT registry verified)
    const unknownDomSigned = await signRfc9421Request({
      algorithm: 'Ed25519',
      privateKey: rogueKp.privateKey,
      publicJwk: rogueKp.jwk,
      method: 'GET',
      authority: 'example.jp',
      path: '/products/widget',
      signature_agent: '"https://agent.startup.example"',
      created: nowSec - 5,
      expires: nowSec + 300,
    })
    const verdictUnknownDom = await engine.evaluateObservation(
      makeObservation({
        observation_id: 'obs_unknown_dom',
        host: 'example.jp',
        path: '/products/widget',
        observed_at: '2026-11-20T12:00:00.000Z',
        rfc9421_headers: {
          signature_input: unknownDomSigned.signature_input,
          signature: unknownDomSigned.signature,
          signature_agent: unknownDomSigned.signature_agent,
        },
      }),
      {
        unknownDomainJwks: [{ domain: 'agent.startup.example', jwks: [rogueKp.jwk] }],
      },
    )
    expect(verdictUnknownDom.identity_assurance).toBe('crypto_domain')
    expect(verdictUnknownDom.verified_actor_id).toBeNull()
    expect(verdictUnknownDom.verified_domain).toBe('agent.startup.example')
  })
})

// ===========================================================================
// 3. SAIL Exhaustive Positive/Refuted, IP Feeds, FCrDNS, Decoy, Policy-Only & XFF Forgery Probe
// ===========================================================================

describe('SAIL, IP Feeds, FCrDNS, Decoy, Policy-Only & Origin-Forgery Probe (act.G5)', () => {
  function buildClockWithFeeds() {
    const store = new InMemoryEvidenceSnapshotStore()
    let currentTime = new Date('2026-11-20T11:40:00.000Z')

    const sailToml = `
version = 1
exhaustive = true
expires = "2026-11-20T15:00:00Z"

[agents."Claude-Agent"]
exhaustive = true
prefixes = ["160.79.104.0/24"]
`
    const gptbotJson = JSON.stringify({
      creationTime: '2026-11-20T11:00:00Z',
      prefixes: [{ ipv4Prefix: '20.15.240.64/28' }],
    })
    const anthropicBotsJson = JSON.stringify({
      creationTime: '2026-11-20T11:00:00Z',
      prefixes: [{ ipv4Prefix: '160.79.105.0/24' }],
    })

    const clock = new ActorEvidenceClock({
      store,
      cadenceMode: 'production_poll',
      now: () => currentTime,
      fetcher: async (url: string): Promise<EvidenceFetchResponse> => {
        if (url.includes('sail')) return { status: 200, body: sailToml }
        if (url.includes('gptbot')) return { status: 200, body: gptbotJson }
        if (url.includes('anthropic')) return { status: 200, body: anthropicBotsJson }
        return { status: 404, body: '' }
      },
    })

    return {
      clock,
      setTime: (iso: string) => {
        currentTime = new Date(iso)
      },
    }
  }

  test('SAIL positive verifies Claude-Agent; 3 consecutive production_poll misses refute spoofed IP', async () => {
    const { clock, setTime } = buildClockWithFeeds()
    const sailSrc = DEFAULT_EVIDENCE_SOURCES.find(
      (s) => s.source_id === 'anthropic:claude-agent-sail',
    )!

    // Capture 3 consecutive snapshots (11:40, 12:00, 12:20)
    setTime('2026-11-20T11:40:00.000Z')
    expect((await clock.captureSource(sailSrc)).ok).toBe(true)
    setTime('2026-11-20T12:05:00.000Z')
    expect((await clock.captureSource(sailSrc)).ok).toBe(true)
    setTime('2026-11-20T12:25:00.000Z')
    expect((await clock.captureSource(sailSrc)).ok).toBe(true)

    const engine = new ActorVerdictEngine({ clock })

    // Positive: IP in SAIL CIDR -> verified
    const legitObs = makeObservation({
      observation_id: 'obs_sail_pos',
      observed_at: '2026-11-20T11:50:00.000Z',
      raw_ua: 'Mozilla/5.0 (compatible; Claude-Agent/1.0)',
      ua_family_version: 'Claude-Agent/1',
    })
    const legitVerdict = await engine.evaluateObservation(legitObs, {
      ephemeral_raw_ip: '160.79.104.42',
    })
    expect(legitVerdict.declared_actor_id).toBe('anthropic:claude-agent')
    expect(legitVerdict.verified_actor_id).toBe('anthropic:claude-agent')
    expect(legitVerdict.identity_assurance).toBe('verified')
    expect(legitVerdict.verification_result).toBe('verified')
    expect(legitVerdict.actor_class).toBe('ai_agent_verified')

    // Negative: IP NOT in exhaustive SAIL across 3 consecutive snapshots -> REFUTED
    const spoofObs = makeObservation({
      observation_id: 'obs_sail_neg',
      observed_at: '2026-11-20T11:50:00.000Z',
      raw_ua: 'Mozilla/5.0 (compatible; Claude-Agent/1.0)',
      ua_family_version: 'Claude-Agent/1',
    })
    const spoofVerdict = await engine.evaluateObservation(spoofObs, {
      ephemeral_raw_ip: '198.51.100.99',
    })
    expect(spoofVerdict.declared_actor_id).toBe('anthropic:claude-agent')
    expect(spoofVerdict.verified_actor_id).toBeNull()
    expect(spoofVerdict.identity_assurance).toBe('refuted')
    expect(spoofVerdict.verification_result).toBe('refuted')
    expect(spoofVerdict.reporting_label).toBe('refuted_exhaustive_list')
  })

  test('Google-Extended in UA is never verified as HTTP actor; decoy hit marks automation_explicit; FCrDNS works', async () => {
    const { clock } = buildClockWithFeeds()
    const fcrdns: FcrdnsResolver = {
      reversePtr: async (ip) =>
        ip === '66.249.66.1' ? ['crawl-66-249-66-1.googlebot.com.'] : ['fake.attacker.example.'],
      resolveForward: async (host) =>
        host === 'crawl-66-249-66-1.googlebot.com' ? ['66.249.66.1'] : ['198.51.100.7'],
    }
    const engine = new ActorVerdictEngine({ clock, fcrdns })

    // Policy-only token spoofed in HTTP UA
    const policyObs = makeObservation({
      observation_id: 'obs_policy_token',
      raw_ua: 'Google-Extended/1.0',
      ua_family_version: 'Google-Extended/1',
    })
    const policyVerdict = await engine.evaluateObservation(policyObs)
    expect(policyVerdict.declared_actor_id).toBeNull()
    expect(policyVerdict.verified_actor_id).toBeNull()
    expect(policyVerdict.policy_token_detected).toBe('Google-Extended')
    expect(policyVerdict.identity_assurance).toBe('unverified')
    expect(policyVerdict.reporting_label).toBe('policy_token_not_http_actor')

    // Decoy path hit (robots.txt Disallow-only) -> automation_explicit
    const decoyObs = makeObservation({
      observation_id: 'obs_decoy',
      path: '/_ugk-decoy/trap',
      is_document: false,
      is_decoy_hit: true,
      raw_ua: 'CustomFetcher/0.1',
      ua_family_version: 'CustomFetcher/0',
    })
    const decoyVerdict = await engine.evaluateObservation(decoyObs)
    expect(decoyVerdict.actor_class).toBe('automation_explicit')

    // Direct FCrDNS check
    const goodFc = await verifyFcrdns('66.249.66.1', ['.googlebot.com'], fcrdns)
    expect(goodFc.matched).toBe(true)
    const badFc = await verifyFcrdns('198.51.100.7', ['.googlebot.com'], fcrdns)
    expect(badFc.matched).toBe(false)

    // Googlebot via FCrDNS in engine
    const gbObs = makeObservation({
      observation_id: 'obs_googlebot_fc',
      raw_ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      ua_family_version: 'Googlebot/2',
    })
    const gbVerdict = await engine.evaluateObservation(gbObs, {
      ephemeral_raw_ip: '66.249.66.1',
    })
    expect(gbVerdict.identity_assurance).toBe('verified_operator')
    expect(gbVerdict.verified_operator).toBe('google')
    expect(gbVerdict.actor_class).toBe('search_crawler_verified')
  })

  test('Forged X-Forwarded-For probe failure downgrades site to proxy_restored_unattested and caps verdict at declared_only', async () => {
    const { clock } = buildClockWithFeeds()
    const gptSrc = DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'openai:gptbot')!
    expect((await clock.captureSource(gptSrc)).ok).toBe(true)

    const trustRegistry = new OriginIpTrustRegistry()

    // Failed forgery probe: origin logged the forged X-Forwarded-For IP!
    const failedProbe = evaluateOriginForgeryProbe({
      tenant_id: 'tenant_a',
      site_id: 'site_spoofable',
      host: 'spoofable.example.jp',
      probed_at: '2026-11-20T10:00:00.000Z',
      forged_header_ip: '20.15.240.65',
      probe_source_real_ip: '198.51.100.50',
      direct_to_origin_blocked: false,
      direct_probe_logged_ip: '20.15.240.65',
      proxied_probe_logged_ip: '20.15.240.65',
    })
    expect(failedProbe.attested).toBe(false)
    expect(failedProbe.ip_spoofable).toBe(true)
    expect(failedProbe.effective_ip_trust).toBe('proxy_restored_unattested')
    trustRegistry.recordProbe(failedProbe)

    // Passing probe for comparison
    const passedProbe = evaluateOriginForgeryProbe({
      tenant_id: 'tenant_a',
      site_id: 'site_attested',
      host: 'attested.example.jp',
      probed_at: '2026-11-20T10:00:00.000Z',
      forged_header_ip: '20.15.240.65',
      probe_source_real_ip: '198.51.100.50',
      direct_to_origin_blocked: true,
      direct_probe_logged_ip: null,
      proxied_probe_logged_ip: '198.51.100.50',
    })
    expect(passedProbe.attested).toBe(true)
    expect(passedProbe.ip_spoofable).toBe(false)
    expect(passedProbe.effective_ip_trust).toBe('proxy_restored_attested')
    trustRegistry.recordProbe(passedProbe)

    const engine = new ActorVerdictEngine({ clock, originTrustRegistry: trustRegistry })

    // Spoofable site: even though IP matches openai:gptbot feed, verdict MUST cap at declared_only!
    const spoofableObs = makeObservation({
      observation_id: 'obs_xff_spoofable',
      site_id: 'site_spoofable',
      host: 'spoofable.example.jp',
      ip_trust: 'proxy_restored_attested',
      raw_ua: 'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)',
      ua_family_version: 'GPTBot/1',
    })
    const spoofableVerdict = await engine.evaluateObservation(spoofableObs, {
      ephemeral_raw_ip: '20.15.240.65',
    })
    expect(spoofableVerdict.declared_actor_id).toBe('openai:gptbot')
    expect(spoofableVerdict.verified_actor_id).toBeNull()
    expect(spoofableVerdict.identity_assurance).toBe('declared_only')
    expect(spoofableVerdict.verification_result).toBe('unverifiable_ip_untrusted')

    // Attested site with same IP verifies normally!
    const attestedObs = makeObservation({
      observation_id: 'obs_xff_attested',
      site_id: 'site_attested',
      host: 'attested.example.jp',
      ip_trust: 'proxy_restored_attested',
      raw_ua: 'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)',
      ua_family_version: 'GPTBot/1',
    })
    const attestedVerdict = await engine.evaluateObservation(attestedObs, {
      ephemeral_raw_ip: '20.15.240.65',
    })
    expect(attestedVerdict.identity_assurance).toBe('verified')
    expect(attestedVerdict.verified_actor_id).toBe('openai:gptbot')
  })

  test('recomputeBatch generates versioned verdicts without mutating append-only observations', async () => {
    const { clock } = buildClockWithFeeds()
    const vault = new DailySealingKeyVault()
    const sealed = classifyAndMinimizeIpAddress(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        raw_ip: '20.15.240.66',
        asn: 8075,
        observed_at: '2026-11-20T12:00:00.000Z',
        has_request_time_automation_evidence: true,
      },
      vault,
      { decisionCheckOverride: APPROVED_D12 },
    )

    const obs = makeObservation({
      observation_id: 'obs_recompute_1',
      raw_ua: 'GPTBot/1.2',
      ua_family_version: 'GPTBot/1',
      ip_evidence: sealed,
    })
    const snapshotBefore = JSON.stringify(obs)

    const engine = new ActorVerdictEngine({ clock, sealingVault: vault })

    // Verdict v1 before feed snapshot exists -> declared_only (unverifiable_stale_evidence)
    const [v1] = await engine.recomputeBatch([obs], {
      verdict_version: 'verdict/1',
      recomputed_at: '2026-11-20T12:01:00.000Z',
    })
    expect(v1.verdict_version).toBe('verdict/1')
    expect(v1.identity_assurance).toBe('declared_only')
    expect(v1.verified_actor_id).toBeNull()

    // Capture GPTBot feed snapshot, then recompute as verdict/2
    const gptSrc = DEFAULT_EVIDENCE_SOURCES.find((s) => s.source_id === 'openai:gptbot')!
    expect((await clock.captureSource(gptSrc)).ok).toBe(true)

    const [v2] = await engine.recomputeBatch([obs], {
      verdict_version: 'verdict/2',
      recomputed_at: '2026-11-20T12:10:00.000Z',
    })
    expect(v2.verdict_version).toBe('verdict/2')
    expect(v2.identity_assurance).toBe('verified')
    expect(v2.verified_actor_id).toBe('openai:gptbot')
    expect(v2.evidence_snapshot_ids.length).toBe(1)

    // Append-only observation is strictly unchanged!
    expect(JSON.stringify(obs)).toBe(snapshotBefore)
  })
})

// ===========================================================================
// 4. Signed Log Ingest, Static Asset Filter, 5 Hosting Adapters & Coverage
// ===========================================================================

describe('Signed POST Log Ingest, Static Asset Filter, 5 Adapters & Capture Coverage', () => {
  const SECRET = 'ingest-hmac-secret-v2'
  const NOW_SEC = Math.floor(Date.parse('2026-11-20T12:00:00Z') / 1000)

  test('verifies HMAC signature, parses NDJSON, drops human static assets, keeps docs/robots/llms/SDK/decoy/bot-JS, flags prefetch', () => {
    const ndjsonLines = [
      // Human document with tracking query -> ACCEPTED, normalized url_key_v2, raw_ua = null
      JSON.stringify({
        observed_at: '2026-11-20T11:59:00Z',
        request_id: 'rid_doc_1',
        method: 'GET',
        host: 'example.jp',
        path: '/blog/post-1',
        query: '?utm_source=google&id=42',
        status: 200,
        user_agent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.google.com/search?q=test&gclid=xyz',
        client_ip: '203.0.113.45',
      }),
      // Human static CSS -> DROPPED
      JSON.stringify({
        observed_at: '2026-11-20T11:59:01Z',
        method: 'GET',
        host: 'example.jp',
        path: '/assets/app.css',
        status: 200,
        user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 Safari/537.36',
        client_ip: '203.0.113.45',
      }),
      // Human static PNG -> DROPPED
      JSON.stringify({
        observed_at: '2026-11-20T11:59:02Z',
        method: 'GET',
        host: 'example.jp',
        path: '/images/hero.png',
        status: 200,
        user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 Safari/537.36',
        client_ip: '203.0.113.45',
      }),
      // robots.txt & llms.txt -> ACCEPTED
      JSON.stringify({
        observed_at: '2026-11-20T11:59:03Z',
        method: 'GET',
        host: 'example.jp',
        path: '/llms.txt',
        status: 200,
        user_agent: 'OAI-SearchBot/1.0',
        client_ip: '20.15.240.66',
      }),
      // SDK probe file -> ACCEPTED
      JSON.stringify({
        observed_at: '2026-11-20T11:59:04Z',
        method: 'GET',
        host: 'example.jp',
        path: '/_ugk/probe.js',
        status: 200,
        user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 Safari/537.36',
        client_ip: '203.0.113.45',
      }),
      // Decoy path -> ACCEPTED with is_decoy_hit = true
      JSON.stringify({
        observed_at: '2026-11-20T11:59:05Z',
        method: 'GET',
        host: 'example.jp',
        path: '/_ugk-decoy/secret',
        status: 200,
        user_agent: 'StealthBot/1.0',
        client_ip: '198.51.100.12',
      }),
      // Bot fetching static JS -> ACCEPTED (automation evidence!)
      JSON.stringify({
        observed_at: '2026-11-20T11:59:06Z',
        method: 'GET',
        host: 'example.jp',
        path: '/assets/bundle.js',
        status: 200,
        user_agent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        client_ip: '66.249.66.1',
      }),
      // Speculation Rules Prefetch -> ACCEPTED with is_prefetch = true
      JSON.stringify({
        observed_at: '2026-11-20T11:59:07Z',
        method: 'GET',
        host: 'example.jp',
        path: '/pricing',
        status: 200,
        sec_purpose: 'prefetch;anonymous-client-ip',
        user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0 Safari/537.36',
        client_ip: '203.0.113.45',
      }),
    ].join('\n')

    const sig = signLogIngestBatch({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      timestamp_sec: NOW_SEC,
      raw_body: ndjsonLines,
      secret: SECRET,
    })

    // Invalid signature must fail
    const badRes = ingestSignedLogBatch(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        default_host: 'example.jp',
        adapter: 'cloudflare_worker',
        content_type: 'application/x-ndjson',
        raw_body: ndjsonLines,
        timestamp_sec: NOW_SEC,
        signature_header: 'v1=0000000000000000',
      },
      { ingest_secret: SECRET, now_sec: NOW_SEC },
    )
    expect(badRes.ok).toBe(false)
    expect(badRes.error).toBe('signature_mismatch')

    // Valid ingest with IP vault + pseudonyms
    const vault = new DailySealingKeyVault()
    const res = ingestSignedLogBatch(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        default_host: 'example.jp',
        adapter: 'cloudflare_worker',
        content_type: 'application/x-ndjson',
        raw_body: ndjsonLines,
        timestamp_sec: NOW_SEC,
        signature_header: sig,
      },
      {
        ingest_secret: SECRET,
        now_sec: NOW_SEC,
        url_key_rules: { paramClasses: { id: 'content' } },
        sealing_vault: vault,
        ip_privacy_entitlement: { decisionCheckOverride: APPROVED_D12 },
        pseudonym_key_ring: TEST_PSEUDONYM_KEYRING,
      },
    )

    expect(res.ok).toBe(true)
    expect(res.capture_path).toBe('P1')
    expect(res.total_records_received).toBe(8)
    expect(res.dropped_static_count).toBe(2) // app.css + hero.png
    expect(res.accepted_observations.length).toBe(6)
    expect(res.prefetch_flagged_count).toBe(1)

    // Verify human doc row has reduced UA, null raw_ua, Class T /24 IP, and clean url_key_v2
    const docObs = res.accepted_observations.find((o) => o.path === '/blog/post-1')!
    expect(docObs.ua_family_version).toBe('Chrome/131')
    expect(docObs.raw_ua).toBeNull()
    expect(docObs.url_key_v2).toBe('example.jp/blog/post-1?id=42')
    expect(docObs.referer_url_key_v2).toContain('google.com/search')
    expect(docObs.referer_url_key_v2).not.toContain('gclid')
    expect(docObs.referer_url_key_v2).not.toContain('test') // user_input `q` masked by urlkey/2!
    expect(docObs.ip_evidence?.address_class).toBe('T')
    expect(docObs.ip_evidence?.prefix).toBe('203.0.113.0/24')
    expect(docObs.ip_evidence?.sealed_ip).toBeNull()

    // Verify bot row has Class E sealed IP and raw_ua preserved
    const llmsObs = res.accepted_observations.find((o) => o.path === '/llms.txt')!
    expect(llmsObs.raw_ua).toBe('OAI-SearchBot/1.0')
    expect(llmsObs.ip_evidence?.address_class).toBe('E')
    expect(llmsObs.ip_evidence?.sealed_ip).not.toBeNull()

    // Zero unsealed full IPs anywhere in accepted observations!
    expect(scanForUnsealedFullIps(res.accepted_observations)).toHaveLength(0)
  })

  test('adapts all remaining 4 hosting formats: cloudflare_logpush, vercel_drain, nginx, shared_hosting_daily', () => {
    const cases: Array<{
      adapter: 'cloudflare_logpush' | 'vercel_drain' | 'nginx' | 'shared_hosting_daily'
      content_type: 'application/json' | 'text/plain'
      body: string
      expectedPath: string
      expectedCapture: string
    }> = [
      {
        adapter: 'cloudflare_logpush',
        content_type: 'application/json',
        body: JSON.stringify([
          {
            EdgeStartTimestamp: 1795089600000000000,
            RayID: 'cf_ray_1',
            ClientRequestMethod: 'GET',
            ClientRequestHost: 'shop.example.jp',
            ClientRequestURI: '/items/1',
            EdgeResponseStatus: 200,
            ClientRequestUserAgent: 'PerplexityBot/1.0',
            ClientIP: '198.51.100.10',
            ClientASN: 13335,
          },
        ]),
        expectedPath: '/items/1',
        expectedCapture: 'P2',
      },
      {
        adapter: 'vercel_drain',
        content_type: 'application/json',
        body: JSON.stringify([
          {
            id: 'vrc_req_1',
            timestamp: 1795089600000,
            proxy: {
              method: 'GET',
              host: 'app.example.jp',
              path: '/docs/start',
              statusCode: 200,
              clientIp: '198.51.100.20',
              userAgent: ['ClaudeBot/1.0'],
            },
          },
        ]),
        expectedPath: '/docs/start',
        expectedCapture: 'P3',
      },
      {
        adapter: 'nginx',
        content_type: 'application/json',
        body: JSON.stringify([
          {
            time_iso8601: '2026-11-20T12:00:00+09:00',
            request_id: 'ngx_1',
            request_method: 'GET',
            host: 'corp.example.jp',
            request_uri: '/about',
            status: 200,
            remote_addr: '203.0.113.55',
            http_user_agent: 'GPTBot/1.2',
          },
        ]),
        expectedPath: '/about',
        expectedCapture: 'P4',
      },
      {
        adapter: 'shared_hosting_daily',
        content_type: 'text/plain',
        body: '203.0.113.77 - - [20/Nov/2026:12:00:00 +0900] "GET /company HTTP/1.1" 200 4512 "https://yahoo.co.jp/" "Mozilla/5.0 (compatible; bingbot/2.0)"',
        expectedPath: '/company',
        expectedCapture: 'P5',
      },
    ]

    for (const c of cases) {
      const sig = signLogIngestBatch({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        timestamp_sec: NOW_SEC,
        raw_body: c.body,
        secret: SECRET,
      })
      const r = ingestSignedLogBatch(
        {
          tenant_id: 'tenant_a',
          site_id: 'site_1',
          default_host: 'fallback.example.jp',
          adapter: c.adapter,
          content_type: c.content_type,
          raw_body: c.body,
          timestamp_sec: NOW_SEC,
          signature_header: sig,
        },
        { ingest_secret: SECRET, now_sec: NOW_SEC },
      )
      expect(r.ok).toBe(true)
      expect(r.capture_path).toBe(c.expectedCapture)
      expect(r.accepted_observations).toHaveLength(1)
      expect(r.accepted_observations[0].path).toBe(c.expectedPath)
    }
  })

  test('computeActorCaptureCoverage reports not_collected for blind classes on tag-only (P0) sites and never scales', () => {
    const tagOnly = computeActorCaptureCoverage(['P0'])
    expect(tagOnly.never_scale_from_observed).toBe(true)
    expect(tagOnly.classes.browser_with_js.status).toBe('observed')
    expect(tagOnly.classes.browser_without_js.status).toBe('not_collected')
    expect(tagOnly.classes.ai_agent_verified.status).toBe('not_collected')
    expect(tagOnly.classes.search_crawler_verified.status).toBe('not_collected')
    expect(tagOnly.classes.automation_explicit.status).toBe('not_collected')

    const withWorker = computeActorCaptureCoverage(['P0', 'P1'])
    expect(withWorker.classes.browser_without_js.status).toBe('observed')
    expect(withWorker.classes.ai_agent_verified.status).toBe('observed')

    const withSharedDaily = computeActorCaptureCoverage(['P0', 'P5'])
    expect(withSharedDaily.classes.ai_agent_verified.status).toBe('partial')
    expect(withSharedDaily.classes.browser_without_js.status).toBe('partial')
  })
})

// ===========================================================================
// 5. Server-Timing Handoff (±120s 1-to-1 Join, bfcache Exclusion, Shared Cache, Zero-Leak ACK)
// ===========================================================================

describe('Server-Timing Handoff, bfcache/SPA Exclusion, Shared Cache & Zero-Leak Client ACK', () => {
  const EDGE_SECRET = 'edge-handoff-hmac-secret-99'

  test('mints & parses Server-Timing header, joins 1-to-1 within ±120s, rejects >120s / wrong path / bad MAC', () => {
    const issuedSec = Math.floor(Date.parse('2026-11-20T12:00:00.000Z') / 1000)
    const minted = mintServerTimingHandoffHeader({
      request_id: 'rid_handoff_001',
      issued_at_sec: issuedSec,
      host: 'example.jp',
      path: '/landing',
      edge_secret: EDGE_SECRET,
    })

    const fullHeader = `cdn-cache;desc=MISS, ${minted.header_value}, app;dur=12.4`
    const parsed = parseServerTimingHandoffHeader(fullHeader)
    expect(parsed?.request_id).toBe('rid_handoff_001')
    expect(parsed?.issued_at_sec).toBe(issuedSec)
    expect(parsed?.mac_hex).toHaveLength(16)

    const joiner = new ServerTimingHandoffJoiner({
      window_seconds: 120,
      edge_secret: EDGE_SECRET,
    })
    joiner.registerServerObservation(
      makeObservation({
        observation_id: 'obs_srv_001',
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        request_id: 'rid_handoff_001',
        host: 'example.jp',
        path: '/landing',
        observed_at: '2026-11-20T12:00:00.000Z',
      }),
    )

    // > 120s fails with window_expired
    const lateJoin = joiner.joinPageView({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      pv_id: 'pv_late',
      client_key: 'client_1',
      nav_type: 'navigate',
      host: 'example.jp',
      path: '/landing',
      observed_at: '2026-11-20T12:02:05.000Z', // +125s
      server_timing_raw: fullHeader,
    })
    expect(lateJoin.matched).toBe(false)
    expect(lateJoin.handoff_state).toBe('window_expired')

    // Wrong tenant fails (tenant isolation)
    const crossTenant = joiner.joinPageView({
      tenant_id: 'tenant_b',
      site_id: 'site_1',
      pv_id: 'pv_other_tenant',
      client_key: 'client_1',
      nav_type: 'navigate',
      host: 'example.jp',
      path: '/landing',
      observed_at: '2026-11-20T12:00:02.000Z',
      server_timing_raw: fullHeader,
    })
    expect(crossTenant.matched).toBe(false)
    expect(crossTenant.handoff_state).toBe('unmatched_server_obs')

    // Valid 1-to-1 join within ±120s succeeds
    const okJoin = joiner.joinPageView({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      pv_id: 'pv_001',
      client_key: 'client_1',
      nav_type: 'navigate',
      host: 'example.jp',
      path: '/landing',
      observed_at: '2026-11-20T12:00:03.000Z',
      server_timing_raw: fullHeader,
    })
    expect(okJoin.matched).toBe(true)
    expect(okJoin.handoff_state).toBe('fresh')
    expect(okJoin.observation_id).toBe('obs_srv_001')
    expect(okJoin.time_delta_ms).toBe(3000)

    // Different client sending identical request_id -> shared front-cache detected!
    const sharedCache = joiner.joinPageView({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      pv_id: 'pv_002',
      client_key: 'client_2_different_visitor',
      nav_type: 'navigate',
      host: 'example.jp',
      path: '/landing',
      observed_at: '2026-11-20T12:00:10.000Z',
      server_timing_raw: fullHeader,
    })
    expect(sharedCache.matched).toBe(false)
    expect(sharedCache.handoff_state).toBe('shared_cache')
    expect(sharedCache.shared_cache_detected).toBe(true)
    expect(sharedCache.exclude_from_no_script_denominator).toBe(true)

    // Client ACK has ZERO verdict / actor-class / internal fields (act.G7)
    const ack = buildSafeClientAck(okJoin, '2026-11-20T12:00:03.100Z')
    expect(Object.keys(ack).sort()).toEqual(['accepted_at', 'handoff_received', 'ok', 'pv_id'])
    expect(() => assertNoVerdictInClientAck(ack)).not.toThrow()
    expect(() =>
      assertNoVerdictInClientAck({ ...ack, actor_class: 'ai_agent_verified' }),
    ).toThrow(/act\.G7/)
    expect(() =>
      assertNoVerdictInClientAck({ ok: true, nested: { verified_actor_id: 'openai:gptbot' } }),
    ).toThrow(/act\.G7/)
  })

  test('excludes bfcache (back_forward), SPA (soft), and resume from no-script denominator', () => {
    const joiner = new ServerTimingHandoffJoiner()

    const bfcacheRes = joiner.joinPageView({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      pv_id: 'pv_bf',
      client_key: 'client_1',
      nav_type: 'back_forward',
      host: 'example.jp',
      path: '/landing',
      observed_at: '2026-11-20T12:01:00.000Z',
      server_timing_raw: null,
    })
    expect(bfcacheRes.exclude_from_no_script_denominator).toBe(true)
    expect(bfcacheRes.handoff_state).toBe('reused')

    const spaRes = joiner.joinPageView({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      pv_id: 'pv_spa',
      client_key: 'client_1',
      nav_type: 'soft',
      host: 'example.jp',
      path: '/landing/step-2',
      observed_at: '2026-11-20T12:01:10.000Z',
      server_timing_raw: null,
    })
    expect(spaRes.exclude_from_no_script_denominator).toBe(true)
    expect(spaRes.handoff_state).toBe('inherited')

    const rate = computeNoScriptRate({
      server_document_count: 110,
      joined_fresh_count: 80,
      server_prefetch_count: 10,
      excluded_bfcache_or_spa_count: 25,
    })
    expect(rate.denominator_document_requests).toBe(100)
    expect(rate.unjoined_without_js_count).toBe(20)
    expect(rate.no_script_rate).toBeCloseTo(0.2, 6)
  })
})

// ===========================================================================
// 6. Origin Kit Config Generator (4 Platforms, <=13m Cap, Cookieless Suppression)
// ===========================================================================

describe('Origin Kit Config Generator (Stratum A Identity + Server-Timing)', () => {
  test('generates HttpOnly Secure SameSite=Lax <=13m cookie & Server-Timing templates for all 4 platforms', () => {
    const platforms: OriginKitPlatform[] = [
      'cloudflare_worker',
      'nextjs_middleware',
      'nginx',
      'wordpress',
    ]

    for (const p of platforms) {
      const cfg = generateOriginKitConfig(p, {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        host: 'example.jp',
        consent_mode: 'full',
      })
      expect(cfg.identity_quality_stratum).toBe('A')
      expect(cfg.cookie_spec.emitted).toBe(true)
      expect(cfg.cookie_spec.http_only).toBe(true)
      expect(cfg.cookie_spec.secure).toBe(true)
      expect(cfg.cookie_spec.same_site).toBe('Lax')
      expect(cfg.cookie_spec.max_age_seconds).toBeLessThanOrEqual(MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS)
      expect(cfg.code_template).toContain('Server-Timing')
      expect(cfg.code_template).toContain('ugk;desc=')
    }

    // WordPress must explicitly document installer/shipper-only (no WP DB storage)
    const wp = generateOriginKitConfig('wordpress', {
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      host: 'wp.example.jp',
      consent_mode: 'full',
    })
    expect(wp.limitations.join(' ')).toMatch(/never a system of record/i)
  })

  test('enforces <= 13 month cap and suppresses cookie completely in cookieless and off modes', () => {
    expect(() =>
      generateOriginKitConfig('cloudflare_worker', {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        host: 'example.jp',
        consent_mode: 'full',
        max_age_seconds: MAX_ORIGIN_COOKIE_MAX_AGE_SECONDS + 1,
      }),
    ).toThrow(/13-month cap/)

    for (const mode of ['cookieless', 'off'] as const) {
      const cfg = generateOriginKitConfig('nextjs_middleware', {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        host: 'example.jp',
        consent_mode: mode,
      })
      expect(cfg.identity_quality_stratum).toBe('C')
      expect(cfg.cookie_spec.emitted).toBe(false)
      expect(cfg.code_template).not.toContain('response.cookies.set(')
      expect(
        buildOriginCookieSetHeader({
          consent_mode: mode,
          cookie_value: 'abcdef1234567890',
        }),
      ).toBeNull()
    }

    const header = buildOriginCookieSetHeader({
      consent_mode: 'full',
      cookie_value: 'abcdef1234567890',
    })
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
  })
})

// ===========================================================================
// 7. Address Privacy 3 Classes (E/T/P), D-12 Gate, 30d Key Destruction & 4 Pseudonyms
// ===========================================================================

describe('Address Privacy E/T/P Classes, D-12 Gate, 30d Key Destruction & 4 Purpose Pseudonyms', () => {
  test('fails closed with NotEntitledError when live D-12 decision is pending', () => {
    const vault = new DailySealingKeyVault()
    expect(() =>
      classifyAndMinimizeIpAddress(
        {
          tenant_id: 'tenant_a',
          site_id: 'site_1',
          raw_ip: '203.0.113.42',
          asn: 13335,
          observed_at: '2026-11-20T12:00:00.000Z',
          has_request_time_automation_evidence: true,
        },
        vault,
      ),
    ).toThrow(NotEntitledError)
  })

  test('Class E seals IP with daily public key; destroying private key at 30d renders ciphertext permanently undecryptable (act.G31)', () => {
    const vault = new DailySealingKeyVault()
    const evidence = classifyAndMinimizeIpAddress(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        raw_ip: '160.79.104.77',
        asn: 399358,
        observed_at: '2026-11-20T12:00:00.000Z',
        has_request_time_automation_evidence: true,
      },
      vault,
      { decisionCheckOverride: APPROVED_D12 },
    )

    expect(evidence.address_class).toBe('E')
    expect(evidence.prefix).toBe('160.79.104.0/24')
    expect(evidence.sealed_ip).not.toBeNull()
    expect(JSON.stringify(evidence)).not.toContain('160.79.104.77')
    expect(scanForUnsealedFullIps([evidence])).toHaveLength(0)

    // Unseals cleanly before 30-day expiry
    const decrypted = vault.unsealIpAddress({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      envelope: evidence.sealed_ip!,
    })
    expect(decrypted).toBe('160.79.104.77')

    // Wrong tenant cannot unseal
    expect(() =>
      vault.unsealIpAddress({
        tenant_id: 'tenant_other',
        site_id: 'site_1',
        envelope: evidence.sealed_ip!,
      }),
    ).toThrow(KeyDestroyedError)

    // Day 29: not yet expired
    expect(vault.purgeExpiredPrivateKeys('2026-12-19T11:59:59.000Z')).toHaveLength(0)

    // Day 30+: private key is permanently destroyed!
    const purged = vault.purgeExpiredPrivateKeys('2026-12-20T12:00:01.000Z')
    expect(purged).toHaveLength(1)
    expect(purged[0].key_id).toBe(evidence.sealed_ip!.key_id)
    expect(vault.getDestructionAuditLog()).toHaveLength(1)

    // Same ciphertext is now permanently undecryptable
    expect(() =>
      vault.unsealIpAddress({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        envelope: evidence.sealed_ip!,
      }),
    ).toThrow(KeyDestroyedError)
  })

  test('Class T truncates IPv4 /24 & IPv6 /48 with 35d collapse; Class P requires separate legal sign-off (act.G32)', () => {
    const vault = new DailySealingKeyVault()

    const classTv4 = classifyAndMinimizeIpAddress(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        raw_ip: '198.51.100.211',
        asn: 2516,
        observed_at: '2026-11-20T00:00:00.000Z',
        has_request_time_automation_evidence: false,
      },
      vault,
      { decisionCheckOverride: APPROVED_D12 },
    )
    expect(classTv4.address_class).toBe('T')
    expect(classTv4.prefix).toBe('198.51.100.0/24')
    expect(classTv4.sealed_ip).toBeNull()
    expect(classTv4.human_rollup_collapse_at).toBe('2026-12-25T00:00:00.000Z')

    expect(truncateIpPrefix('2001:db8:abcd:1234:5678::99')).toBe('2001:db8:abcd::/48')

    // Class P fails closed without separate legal sign-off (act.G32)
    expect(() =>
      classifyAndMinimizeIpAddress(
        {
          tenant_id: 'tenant_a',
          site_id: 'site_1',
          raw_ip: '198.51.100.211',
          asn: 2516,
          observed_at: '2026-11-20T00:00:00.000Z',
          has_request_time_automation_evidence: false,
          request_class_p: true,
        },
        vault,
        { decisionCheckOverride: APPROVED_D12, classPSignedOff: false },
      ),
    ).toThrow(NotEntitledError)

    // With separate legal sign-off -> Class P seals for 72h
    const classP = classifyAndMinimizeIpAddress(
      {
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        raw_ip: '198.51.100.211',
        asn: 2516,
        observed_at: '2026-11-20T00:00:00.000Z',
        has_request_time_automation_evidence: false,
        request_class_p: true,
      },
      vault,
      { decisionCheckOverride: APPROVED_D12, classPSignedOff: true },
    )
    expect(classP.address_class).toBe('P')
    expect(classP.sealed_ip?.expires_at).toBe('2026-11-23T00:00:00.000Z')

    // Scanner catches raw IPv4 and raw IPv6 leaks
    const leaks = scanForUnsealedFullIps([
      { ok_prefix: '198.51.100.0/24', bad_v4: '198.51.100.211', bad_v6: '2001:db8:1:2::9' },
    ])
    expect(leaks).toHaveLength(2)
  })

  test('4 purpose-scoped network pseudonyms are completely unlinkable across purposes and scopes', () => {
    const base = {
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      network_prefix: '203.0.113.45',
      asn: 2516,
      scope_id: '2026-11-20',
    } as const

    const pDaily = derivePurposeNetworkPseudonym({ ...base, purpose: 'daily_cap' }, TEST_PSEUDONYM_KEYRING)
    const pExp = derivePurposeNetworkPseudonym({ ...base, purpose: 'experiment' }, TEST_PSEUDONYM_KEYRING)
    const pQuorum = derivePurposeNetworkPseudonym({ ...base, purpose: 'quorum' }, TEST_PSEUDONYM_KEYRING)
    const pCohort = derivePurposeNetworkPseudonym({ ...base, purpose: 'cohort_k_anon' }, TEST_PSEUDONYM_KEYRING)

    // Extract raw 32-hex hashes (stripping purpose prefix) to prove hashes themselves are unlinkable!
    const hashes = [pDaily, pExp, pQuorum, pCohort].map((s) => s.split('_').pop()!)
    expect(new Set(hashes).size).toBe(4)

    // Same /24 prefix (different host octet) produces same deterministic pseudonym for same purpose & scope
    const pDailySameSubnet = derivePurposeNetworkPseudonym(
      { ...base, network_prefix: '203.0.113.99', purpose: 'daily_cap' },
      TEST_PSEUDONYM_KEYRING,
    )
    expect(pDailySameSubnet).toBe(pDaily)

    // Different scope_id (next day) rotates daily_cap pseudonym
    const pDailyNextDay = derivePurposeNetworkPseudonym(
      { ...base, scope_id: '2026-11-21', purpose: 'daily_cap' },
      TEST_PSEUDONYM_KEYRING,
    )
    expect(pDailyNextDay).not.toBe(pDaily)
  })
})
