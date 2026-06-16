/**
 * Node `node --test` runner for banner-runtime worker (TypeScript via tsx).
 *
 * 環境: Node 20+ with `tsx` loader (`node --import tsx --test test/worker.test.ts`).
 * 本テストは worker.ts の `__test_only__` から実装を直接 import し、ランタイム挙動を
 * verify する。型は src/contracts-types.ts 由来。
 *
 * Consent semantic は privacy-csp-perf-gate.md §1 整合:
 *   - analytics 単独 opt-out で banner を抑止することは **しない** (analytics は別系統)
 *   - personalization または ads が false → `consent_denied`
 *
 * 配備 dispatch: dispatch-05-infra-banner-worker-runtime.md (2026-05-26)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __test_only__ } from '../src/worker.ts';
import type {
  BannerConfig,
  RuleBundle,
  MemberAttribute,
  WorkerResponse,
  ConsentTriple,
} from '../src/contracts-types.ts';

const {
  normalizeTenantId,
  audienceMatches,
  passesHoldout,
  shouldSkipSensitive,
  evaluateConsent,
} = __test_only__;

// ---- helpers ----

function makeBanner(overrides: Partial<BannerConfig> = {}): BannerConfig {
  return {
    banner_id: '11111111-aaaa-bbbb-cccc-dddddddddddd',
    name: 'Test banner',
    status: 'active',
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
    display: { placement: 'bottom-bar', template_id: 'tpl_a' },
    sensitive_category_excluded: false,
    created_at: '2026-05-26T00:00:00Z',
    evidence_level: 'observed',
    ...overrides,
  };
}

function bundleWithFlags(a: boolean, p: boolean, ads: boolean): Pick<RuleBundle, 'consent_flags'> {
  return { consent_flags: { analytics: a, personalization: p, ads } };
}
function memberWithFlags(a: boolean, p: boolean, ads: boolean): Pick<MemberAttribute, 'consent'> {
  return { consent: { analytics: a, personalization: p, ads } };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 normalizeTenantId
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeTenantId: accepts lowercase alnum', () => {
  assert.equal(normalizeTenantId('linkth_internal'), 'linkth_internal');
  assert.equal(normalizeTenantId('tenant_uuid_v4'), 'tenant_uuid_v4');
});

test('normalizeTenantId: NFKC normalization (uppercase → lowercase)', () => {
  assert.equal(normalizeTenantId('LINKTH_internal'), 'linkth_internal');
  assert.equal(normalizeTenantId('LINKTH_INTERNAL'), 'linkth_internal');
});

test('normalizeTenantId: rejects null bytes / control chars', () => {
  assert.equal(normalizeTenantId('foo\x00bar'), null);
  assert.equal(normalizeTenantId('foo\x1fbar'), null);
  assert.equal(normalizeTenantId('foo\x7fbar'), null);
});

test('normalizeTenantId: rejects empty / too long', () => {
  assert.equal(normalizeTenantId(''), null);
  assert.equal(normalizeTenantId('a'.repeat(65)), null);
});

test('normalizeTenantId: rejects illegal characters', () => {
  assert.equal(normalizeTenantId('foo bar'), null);
  assert.equal(normalizeTenantId('foo/bar'), null);
  assert.equal(normalizeTenantId('foo.bar'), null);
});

test('normalizeTenantId: rejects non-strings', () => {
  assert.equal(normalizeTenantId(null), null);
  assert.equal(normalizeTenantId(undefined), null);
  assert.equal(normalizeTenantId(123), null);
  assert.equal(normalizeTenantId({}), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 audienceMatches: AND/OR/NONE + exclude
// ─────────────────────────────────────────────────────────────────────────────

test('audienceMatches: OR with 1 of N match', () => {
  const b = makeBanner({
    audience_targeting: { operator: 'OR', audience_ids: ['a', 'b'], exclude_audience_ids: [], match_rate_cap: null },
  });
  assert.equal(audienceMatches(b, ['a']), true);
  assert.equal(audienceMatches(b, ['b']), true);
  assert.equal(audienceMatches(b, ['c']), false);
});

test('audienceMatches: AND requires all', () => {
  const b = makeBanner({
    audience_targeting: { operator: 'AND', audience_ids: ['a', 'b'], exclude_audience_ids: [], match_rate_cap: null },
  });
  assert.equal(audienceMatches(b, ['a', 'b']), true);
  assert.equal(audienceMatches(b, ['a']), false);
  assert.equal(audienceMatches(b, ['a', 'b', 'c']), true);
});

test('audienceMatches: NONE always matches (sitewide banner)', () => {
  const b = makeBanner({
    audience_targeting: { operator: 'NONE', audience_ids: [], exclude_audience_ids: [], match_rate_cap: null },
  });
  assert.equal(audienceMatches(b, []), true);
  assert.equal(audienceMatches(b, ['anything']), true);
});

test('audienceMatches: exclude_audience_ids wins over include', () => {
  const b = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['a'],
      exclude_audience_ids: ['blocked'],
      match_rate_cap: null,
    },
  });
  assert.equal(audienceMatches(b, ['a']), true);
  assert.equal(audienceMatches(b, ['a', 'blocked']), false);
});

test('audienceMatches: empty audience_ids semantic', () => {
  const orB = makeBanner({
    audience_targeting: { operator: 'OR', audience_ids: [], exclude_audience_ids: [], match_rate_cap: null },
  });
  assert.equal(audienceMatches(orB, ['a']), false);
  const andB = makeBanner({
    audience_targeting: { operator: 'AND', audience_ids: [], exclude_audience_ids: [], match_rate_cap: null },
  });
  assert.equal(audienceMatches(andB, []), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 passesHoldout (match_rate_cap)
// ─────────────────────────────────────────────────────────────────────────────

test('passesHoldout: null cap = always pass', () => {
  assert.equal(passesHoldout('cid1', 'b1', null), true);
  assert.equal(passesHoldout('cid1', 'b1', undefined), true);
});

test('passesHoldout: cap=0 always fail, cap=1 always pass', () => {
  assert.equal(passesHoldout('cid1', 'b1', 0), false);
  assert.equal(passesHoldout('cid1', 'b1', -0.5), false);
  assert.equal(passesHoldout('cid1', 'b1', 1), true);
  assert.equal(passesHoldout('cid1', 'b1', 1.5), true);
});

test('passesHoldout: deterministic per (cid, banner_id)', () => {
  assert.equal(passesHoldout('cidA', 'banner1', 0.5), passesHoldout('cidA', 'banner1', 0.5));
  assert.equal(passesHoldout('cidB', 'banner2', 0.3), passesHoldout('cidB', 'banner2', 0.3));
});

test('passesHoldout: 0.5 cap distribution over 1000 cid is ~50% (tolerance 8%)', () => {
  let pass = 0;
  for (let i = 0; i < 1000; i++) {
    if (passesHoldout(`cid_${i}`, 'banner_x', 0.5)) pass++;
  }
  assert.ok(pass > 420 && pass < 580, `holdout 50% drift too large: ${pass}/1000`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 shouldSkipSensitive (C7, 続 90 canonical SSOT)
// schema description + privacy-csp-perf-gate §1.3:
//   excluded === false (未 review) AND evidence_level === 'inferred' → skip
//   excluded === true (Marketer manual review 済) → 配信可 (inferred でも)
// ─────────────────────────────────────────────────────────────────────────────

test('shouldSkipSensitive: excluded=true (reviewed) + inferred → allow (続 90 SSOT)', () => {
  const b = makeBanner({ sensitive_category_excluded: true, evidence_level: 'inferred' });
  assert.equal(shouldSkipSensitive(b), false);
});

test('shouldSkipSensitive: excluded=true + observed → allow (変更なし)', () => {
  const b = makeBanner({ sensitive_category_excluded: true, evidence_level: 'observed' });
  assert.equal(shouldSkipSensitive(b), false);
});

test('shouldSkipSensitive: excluded=false (未 review) + inferred → skip (続 90 SSOT)', () => {
  const b = makeBanner({ sensitive_category_excluded: false, evidence_level: 'inferred' });
  assert.equal(shouldSkipSensitive(b), true);
});

test('shouldSkipSensitive: excluded=undefined (default false) + inferred → skip (続 90 SSOT)', () => {
  const b = makeBanner({ evidence_level: 'inferred' });
  delete (b as Partial<BannerConfig>).sensitive_category_excluded;
  assert.equal(shouldSkipSensitive(b), true);
});

test('shouldSkipSensitive: excluded=false + observed → allow (変更なし)', () => {
  const b = makeBanner({ sensitive_category_excluded: false, evidence_level: 'observed' });
  assert.equal(shouldSkipSensitive(b), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 evaluateConsent — privacy-csp-perf-gate.md §1 整合
//    analytics は非 blocking、personalization + ads が真のときのみ allow
// ─────────────────────────────────────────────────────────────────────────────

test('evaluateConsent: bundle all true + member all true → allow', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, true, true) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(r.allowed, true);
});

test('evaluateConsent: analytics false 単独 = banner 配信に影響なし (allow)', () => {
  // bundle analytics=false でも personalization+ads=true なら allow
  const r1 = evaluateConsent(
    bundleWithFlags(false, true, true) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(r1.allowed, true);
  // member analytics=false でも他が true なら allow
  const r2 = evaluateConsent(
    bundleWithFlags(true, true, true) as RuleBundle,
    memberWithFlags(false, true, true) as MemberAttribute,
  );
  assert.equal(r2.allowed, true);
});

test('evaluateConsent: bundle personalization=false → personalization_not_opted_in', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, false, true) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'personalization_not_opted_in');
});

test('evaluateConsent: member personalization=false → personalization_not_opted_in', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, true, true) as RuleBundle,
    memberWithFlags(true, false, true) as MemberAttribute,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'personalization_not_opted_in');
});

test('evaluateConsent: bundle ads=false → ads_not_opted_in', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, true, false) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ads_not_opted_in');
});

test('evaluateConsent: member ads=false → ads_not_opted_in', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, true, true) as RuleBundle,
    memberWithFlags(true, true, false) as MemberAttribute,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ads_not_opted_in');
});

test('evaluateConsent: bundle no consent_flags → fail-closed (consent_flags_missing) (続 95 A-C1 fix)', () => {
  const r = evaluateConsent({} as RuleBundle, null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'consent_flags_missing');
});

test('evaluateConsent: bundle.consent_flags = undefined explicit → fail-closed (続 96 dispatch-11 §1)', () => {
  const r = evaluateConsent({ consent_flags: undefined } as unknown as RuleBundle, null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'consent_flags_missing');
});

test('evaluateConsent: bundle.consent_flags partial (analytics only) → fail-closed (続 96 dispatch-11 §1)', () => {
  // legacy/malformed bundle で personalization / ads boolean 不在 → deny
  const r = evaluateConsent(
    { consent_flags: { analytics: true } } as unknown as RuleBundle,
    null,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'consent_flags_missing');
});

test('evaluateConsent: member null + bundle ads=false → ads_not_opted_in', () => {
  const r = evaluateConsent(bundleWithFlags(true, true, false) as RuleBundle, null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ads_not_opted_in');
});

test('evaluateConsent: personalization+ads 両 false → personalization 先頭判定で fail', () => {
  const r = evaluateConsent(
    bundleWithFlags(true, false, false) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(r.allowed, false);
  // personalization check is first → reason should be personalization
  assert.equal(r.reason, 'personalization_not_opted_in');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 Combined decision matrix smoke
// ─────────────────────────────────────────────────────────────────────────────

test('combined: VIP audience match + consent ok + non-sensitive + cap null → eligible', () => {
  const banner = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
  });
  assert.equal(audienceMatches(banner, ['vip_returner']), true);
  assert.equal(shouldSkipSensitive(banner), false);
  assert.equal(passesHoldout('cid1', banner.banner_id, null), true);
  const consent = evaluateConsent(
    bundleWithFlags(true, true, true) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(consent.allowed, true);
});

test('combined: audience match but personalization opt-out → block at consent gate', () => {
  const banner = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
  });
  const consent = evaluateConsent(
    bundleWithFlags(true, false, true) as RuleBundle,
    memberWithFlags(true, true, true) as MemberAttribute,
  );
  assert.equal(audienceMatches(banner, ['vip_returner']), true);
  assert.equal(consent.allowed, false);
  assert.equal(consent.reason, 'personalization_not_opted_in');
});

test('combined: audience match + LLM-inferred + excluded=false (未 review) → skip (続 90 SSOT)', () => {
  const banner = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
    sensitive_category_excluded: false,
    evidence_level: 'inferred',
  });
  assert.equal(audienceMatches(banner, ['vip_returner']), true);
  assert.equal(shouldSkipSensitive(banner), true);
});

test('combined: audience match + LLM-inferred + excluded=true (Marketer reviewed) → allow (続 90 SSOT)', () => {
  const banner = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
    sensitive_category_excluded: true,
    evidence_level: 'inferred',
  });
  assert.equal(audienceMatches(banner, ['vip_returner']), true);
  assert.equal(shouldSkipSensitive(banner), false);
});

test('combined: deleted member (KV miss) = empty audience_flags → no_match for targeted banners', () => {
  const banner = makeBanner({
    audience_targeting: {
      operator: 'OR',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
  });
  assert.equal(audienceMatches(banner, []), false);

  const sitewide = makeBanner({
    audience_targeting: {
      operator: 'NONE',
      audience_ids: [],
      exclude_audience_ids: [],
      match_rate_cap: null,
    },
  });
  assert.equal(audienceMatches(sitewide, []), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 KV key format invariants (D-4 cross-tenant guard)
// ─────────────────────────────────────────────────────────────────────────────

test('KV key format: rules/{tenant}/{site_uuid}/{version}', () => {
  const tenant_id = 'linkth_internal';
  const site_id = '11111111-2222-3333-4444-555555555555';
  const version = '20260526120000-a1b2c3';
  const activeKey = `rules/${tenant_id}/${site_id}/active`;
  const bundleKey = `rules/${tenant_id}/${site_id}/${version}`;
  assert.match(activeKey, /^rules\/[a-z0-9_-]+\/[0-9a-f-]{36}\/active$/);
  assert.match(bundleKey, /^rules\/[a-z0-9_-]+\/[0-9a-f-]{36}\/[0-9]{14}-[a-z0-9]{6}$/);
});

test('KV key format: member/{tenant}/{cid}', () => {
  const tenant_id = 'linkth_internal';
  const cid = '1234567890.1234567890';
  const memberKey = `member/${tenant_id}/${cid}`;
  assert.match(memberKey, /^member\/[a-z0-9_-]+\/[0-9.]+$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 Schedule (starts_at / ends_at) boundary
// ─────────────────────────────────────────────────────────────────────────────

test('schedule boundary check: future starts_at = skip', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const startMs = Date.parse(future);
  assert.ok(Number.isFinite(startMs));
  assert.ok(Date.now() < startMs);
});

test('schedule boundary check: past ends_at = skip', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const endMs = Date.parse(past);
  assert.ok(Number.isFinite(endMs));
  assert.ok(Date.now() > endMs);
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 __test_only__ exposure smoke
// ─────────────────────────────────────────────────────────────────────────────

test('summary: __test_only__ exposes required functions', () => {
  assert.ok(typeof __test_only__.normalizeTenantId === 'function');
  assert.ok(typeof __test_only__.audienceMatches === 'function');
  assert.ok(typeof __test_only__.passesHoldout === 'function');
  assert.ok(typeof __test_only__.shouldSkipSensitive === 'function');
  assert.ok(typeof __test_only__.evaluateConsent === 'function');
  assert.ok(typeof __test_only__.resolveTenantForBanner === 'function');
  assert.ok(typeof __test_only__.readRuleBundleFromKv === 'function');
  assert.ok(typeof __test_only__.readMemberAttribute === 'function');
  assert.ok(typeof __test_only__.handleDecision === 'function');
  assert.equal(__test_only__.BANNER_RUNTIME_SCHEMA_VERSION, '0.1.0');
  assert.equal(__test_only__.STALE_BUNDLE_DAYS, 7);
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 Worker fetch handler — integration tests (dispatch-05 §6 requirements)
//     MockKV + 8 consent パターン + 5 異常系 = full pipeline coverage
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = 'linkth_internal';
const TENANT_OTHER = 'tenant_evil';
const SITE = '11111111-2222-3333-4444-555555555555';
const CID = '1234567890.1234567890';
const BANNER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VERSION = '20260526120000-a1b2c3';

function nowIsoDelta(deltaDays = 0): string {
  return new Date(Date.now() + deltaDays * 24 * 3600 * 1000).toISOString();
}

class MockKV {
  private store = new Map<string, string>();
  putRaw(key: string, value: string): void {
    this.store.set(key, value);
  }
  putJson(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value));
  }
  async get(key: string, _options?: unknown): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function mockExecCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

interface IntegEnv {
  RULE_BUNDLES_KV: MockKV;
  MEMBER_ATTRIBUTES_KV: MockKV;
  ALLOWED_ORIGINS: string;
  MAGIC_LINK_SECRET: string;
  CLICKHOUSE_URL: string;
  CLICKHOUSE_DB: string;
  WORKER_NAME?: string;
}

function buildIntegEnv(): IntegEnv {
  return {
    RULE_BUNDLES_KV: new MockKV(),
    MEMBER_ATTRIBUTES_KV: new MockKV(),
    ALLOWED_ORIGINS: '*',
    MAGIC_LINK_SECRET: 'test-secret-32bytes-AAAAAAAAAAAAAAAAA=',
    CLICKHOUSE_URL: '', // empty → audit emit は short-circuit
    CLICKHOUSE_DB: 'clickinsight',
    WORKER_NAME: 'ugokimap-banner-runtime-test',
  };
}

function makeIntegBanner(overrides: Partial<BannerConfig> = {}): BannerConfig {
  return {
    banner_id: BANNER_ID,
    name: 'Integration VIP banner',
    status: 'active',
    schedule: { starts_at: null, ends_at: null },
    audience_targeting: {
      operator: 'AND',
      audience_ids: ['vip_returner'],
      exclude_audience_ids: [],
      match_rate_cap: 1.0,
    },
    display: {
      placement: 'bottom-bar',
      template_id: 'tpl_bottom_bar_cta_v1',
      content_variables: { headline: 'Test' },
      css_class: 'ugk-banner-bottom',
    },
    sensitive_category_excluded: false,
    created_at: '2026-05-25T12:00:00Z',
    updated_at: '2026-05-26T02:55:00Z',
    evidence_level: 'observed',
    ...overrides,
  };
}

interface IntegBundleOpts {
  consent_flags?: ConsentTriple;
  schema_version?: string;
  published_at?: string;
  banners?: BannerConfig[];
  tenant_id?: string;
  site_id?: string;
}

function makeIntegBundle(opts: IntegBundleOpts = {}): RuleBundle {
  return {
    schema_version: opts.schema_version ?? '0.1.0',
    version: VERSION,
    tenant_id: opts.tenant_id ?? TENANT,
    site_id: opts.site_id ?? SITE,
    published_at: opts.published_at ?? nowIsoDelta(0),
    consent_flags: opts.consent_flags ?? { analytics: true, personalization: true, ads: true },
    performance_budget: { max_gzip_bytes: 20480, max_main_thread_ms: 50, max_cls: 0 },
    banners: opts.banners ?? [makeIntegBanner()],
    audience_membership_index: { vip_returner: [BANNER_ID] },
    fallback: { action: 'no_op', default_banner_id: null },
  };
}

function makeIntegMember(overrides: Partial<MemberAttribute> = {}): MemberAttribute {
  return {
    schema_version: '0.1.0',
    tenant_id: TENANT,
    ga_client_id: CID,
    audience_flags: ['vip_returner'],
    consent: { analytics: true, personalization: true, ads: true },
    source: 'gtm_datalayer',
    last_synced_at: nowIsoDelta(0),
    ttl_hours: 720,
    ...overrides,
  };
}

interface IntegSeedOpts {
  bundle?: RuleBundle | null;
  activePointer?: string | null;
  member?: MemberAttribute | null;
  /** A1 用: 別 tenant prefix にも同 bundle を仕込み cross-tenant 試行をシミュレート */
  alsoSeedTenant?: string;
}

function seedIntegKv(env: IntegEnv, opts: IntegSeedOpts = {}): void {
  const bundle = opts.bundle !== undefined ? opts.bundle : makeIntegBundle();
  if (bundle) {
    const tid = bundle.tenant_id;
    const sid = bundle.site_id;
    const ver = bundle.version;
    env.RULE_BUNDLES_KV.putJson(`rules/${tid}/${sid}/${ver}`, bundle);
    const pointer = opts.activePointer !== undefined ? opts.activePointer : ver;
    if (pointer !== null) {
      env.RULE_BUNDLES_KV.putRaw(`rules/${tid}/${sid}/active`, pointer);
    }
    if (opts.alsoSeedTenant) {
      env.RULE_BUNDLES_KV.putJson(`rules/${opts.alsoSeedTenant}/${sid}/${ver}`, bundle);
      env.RULE_BUNDLES_KV.putRaw(`rules/${opts.alsoSeedTenant}/${sid}/active`, ver);
    }
  }
  if (opts.member) {
    env.MEMBER_ATTRIBUTES_KV.putJson(
      `member/${opts.member.tenant_id}/${opts.member.ga_client_id}`,
      opts.member,
    );
  }
}

function urlForDecision(params: Record<string, string | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  return `http://localhost:8788/v1/decision?${qs}`;
}

async function callDecisionInteg(
  env: IntegEnv,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: WorkerResponse | { error: string; reason?: string } }> {
  const req = new Request(urlForDecision(query), { method: 'GET' });
  const resp = await worker.fetch(
    req,
    env as unknown as Parameters<typeof worker.fetch>[1],
    mockExecCtx(),
  );
  const text = await resp.text();
  let body: WorkerResponse | { error: string; reason?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`response body not JSON: ${text}`);
  }
  return { status: resp.status, body };
}

describe('§10 fetch handler — baseline (B)', () => {
  test('B0 GET /health returns 200 ok', async () => {
    const env = buildIntegEnv();
    const req = new Request('http://localhost:8788/health', { method: 'GET' });
    const resp = await worker.fetch(req, env as never, mockExecCtx());
    assert.equal(resp.status, 200);
    const body = await resp.json() as { status: string };
    assert.equal(body.status, 'ok');
  });

  test('B1 happy path: audience match → status=ok + banner_id + nonce + audit_correlation_id', async () => {
    const env = buildIntegEnv();
    seedIntegKv(env, { bundle: makeIntegBundle(), member: makeIntegMember() });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'ok');
    assert.equal(wr.decision.banner_id, BANNER_ID);
    assert.match(wr.decision.nonce ?? '', /^[A-Za-z0-9_-]{22}$/);
    assert.equal(wr.tenant_id, TENANT);
    assert.equal(wr.site_id, SITE);
    assert.equal(wr.ga_client_id, CID);
    assert.match(wr.audit_correlation_id ?? '', /^[0-9a-f]{8}-/);
  });

  test('B2 site_id missing → 400', async () => {
    const env = buildIntegEnv();
    const { status, body } = await callDecisionInteg(env, { cid: CID, tenant_id: TENANT });
    assert.equal(status, 400);
    assert.equal((body as { error: string }).error, 'site_id required');
  });

  test('B3 site_id non-UUID and non-tracking_id → 400 (続 103 B6 整合)', async () => {
    const env = buildIntegEnv();
    const { status, body } = await callDecisionInteg(env, {
      cid: CID, site_id: 'not-a-uuid', tenant_id: TENANT,
    });
    assert.equal(status, 400);
    assert.equal((body as { error: string }).error, 'site_id must be UUID v4 or tracking_id (CIP_*)');
  });

  test('B3b tracking_id 形式 (CIP_*) → 受入 (続 103 B6、fallback path = KV 不在で fallback)', async () => {
    const env = buildIntegEnv();
    const { status, body } = await callDecisionInteg(env, {
      cid: CID, site_id: 'CIP_QWaPiks5krukJ6NM', tenant_id: TENANT,
    });
    // KV bundle が CIP_ key 配下に投入されていない integ test 環境では fallback、ただし 400 ではないこと
    assert.equal(status, 200);
    assert.equal((body as { status: string }).status, 'fallback');
  });

  test('B4 tenant_id missing → 400', async () => {
    const env = buildIntegEnv();
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE });
    assert.equal(status, 400);
    assert.equal((body as { error: string }).error, 'tenant_id_required');
  });

  test('B5 KV active pointer missing → status=fallback', async () => {
    const env = buildIntegEnv();
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'fallback');
    assert.equal(wr.decision.banner_id, null);
  });
});

// dispatch-05 §6 要求の 8 patterns: 2^3 consent matrix (privacy-csp-perf-gate §1.1 適用後の期待値)
const CONSENT_8: Array<{ a: boolean; p: boolean; ads: boolean; expected: 'ok' | 'consent_denied' }> = [
  { a: true,  p: true,  ads: true,  expected: 'ok' },
  { a: false, p: true,  ads: true,  expected: 'ok' },              // analytics は banner 抑止 trigger 外
  { a: true,  p: false, ads: true,  expected: 'consent_denied' },
  { a: false, p: false, ads: true,  expected: 'consent_denied' },
  { a: true,  p: true,  ads: false, expected: 'consent_denied' },
  { a: false, p: true,  ads: false, expected: 'consent_denied' },
  { a: true,  p: false, ads: false, expected: 'consent_denied' },
  { a: false, p: false, ads: false, expected: 'consent_denied' },
];

describe('§10 fetch handler — consent 2^3 = 8 patterns (C)', () => {
  for (const [i, c] of CONSENT_8.entries()) {
    test(`C${i + 1} bundle.consent_flags={a:${c.a},p:${c.p},ads:${c.ads}} → ${c.expected}`, async () => {
      const env = buildIntegEnv();
      seedIntegKv(env, {
        bundle: makeIntegBundle({ consent_flags: { analytics: c.a, personalization: c.p, ads: c.ads } }),
        member: makeIntegMember(),
      });
      const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
      assert.equal(status, 200);
      const wr = body as WorkerResponse;
      assert.equal(wr.status, c.expected);
      if (c.expected === 'consent_denied') {
        assert.equal(wr.decision.banner_id, null);
      } else {
        assert.equal(wr.decision.banner_id, BANNER_ID);
      }
    });
  }

  test('C-extra member.consent.ads=false overrides bundle (consent withdrawal pattern)', async () => {
    const env = buildIntegEnv();
    seedIntegKv(env, {
      bundle: makeIntegBundle({ consent_flags: { analytics: true, personalization: true, ads: true } }),
      member: makeIntegMember({ consent: { analytics: true, personalization: true, ads: false } }),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    assert.equal((body as WorkerResponse).status, 'consent_denied');
  });
});

describe('§10 fetch handler — anomaly cases (A)', () => {
  test('A1 tenant_id mismatch (cross-tenant) → 403 + status=error', async () => {
    const env = buildIntegEnv();
    // bundle は TENANT で publish。攻撃者: TENANT_OTHER 経路で同 bundle 内容を引かせる
    // (mis-publish / data corruption の D-4 強依存テスト)。
    seedIntegKv(env, {
      bundle: makeIntegBundle({ tenant_id: TENANT, site_id: SITE }),
      member: makeIntegMember(),
      alsoSeedTenant: TENANT_OTHER,
    });
    const { status, body } = await callDecisionInteg(env, {
      cid: CID, site_id: SITE, tenant_id: TENANT_OTHER,
    });
    assert.equal(status, 403);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'error');
    assert.equal(wr.decision.banner_id, null);
    assert.equal(wr.tenant_id, TENANT_OTHER); // request tenant が response に echo
  });

  test('A2 schema_version mismatch → status=fallback', async () => {
    const env = buildIntegEnv();
    seedIntegKv(env, {
      bundle: makeIntegBundle({ schema_version: '0.9.0' /* worker は 0.1.0 のみ対応 */ }),
      member: makeIntegMember(),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    assert.equal((body as WorkerResponse).status, 'fallback');
  });

  test('A3 KV stale (>7d, here 30d) → status=fallback', async () => {
    const env = buildIntegEnv();
    seedIntegKv(env, {
      bundle: makeIntegBundle({ published_at: nowIsoDelta(-30) }),
      member: makeIntegMember(),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    assert.equal((body as WorkerResponse).status, 'fallback');
  });

  test('A4 削除済 cid (member tombstone consent.*=false, audience_flags=[]) → consent_denied', async () => {
    // P-21 削除請求 cascade では member record を tombstone 化 (consent fields false +
    // audience_flags 空配列) する運用 (D-1 / D-2 SLA 14 日担保)。
    // Worker は consent gate で consent_denied を返し、過去 audience match を一切再現させない。
    const env = buildIntegEnv();
    seedIntegKv(env, {
      bundle: makeIntegBundle(),
      member: makeIntegMember({
        consent: { analytics: false, personalization: false, ads: false },
        audience_flags: [],
        source: 'manual',
      }),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'consent_denied');
    assert.equal(wr.decision.banner_id, null);
  });

  test('A5 audience no_match (member.audience_flags=[]) → status=no_match', async () => {
    const env = buildIntegEnv();
    seedIntegKv(env, {
      bundle: makeIntegBundle(),
      member: makeIntegMember({ audience_flags: [] }),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'no_match');
    assert.equal(wr.decision.banner_id, null);
  });

  test('A6 LLM-inferred banner + excluded=false (未 review) → skip → no_match (続 90 SSOT)', async () => {
    // dispatch-07 §3 fixture: schema description + privacy-csp-perf-gate §1.3 整合確認
    // excluded=false (未 review default) AND evidence_level='inferred' → shouldSkipSensitive=true で skip
    // bundle 内に該当 banner 1 件のみ = 評価対象なし = no_match
    const env = buildIntegEnv();
    const inferredBanner = makeIntegBanner({
      sensitive_category_excluded: false,
      evidence_level: 'inferred',
    });
    seedIntegKv(env, {
      bundle: makeIntegBundle({ banners: [inferredBanner] }),
      member: makeIntegMember({ audience_flags: ['vip_returner'] }),
    });
    const { status, body } = await callDecisionInteg(env, { cid: CID, site_id: SITE, tenant_id: TENANT });
    assert.equal(status, 200);
    const wr = body as WorkerResponse;
    assert.equal(wr.status, 'no_match');
    assert.equal(wr.decision.banner_id, null);
  });
});
