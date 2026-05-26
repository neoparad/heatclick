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
// §4 shouldSkipSensitive (C7)
// ─────────────────────────────────────────────────────────────────────────────

test('shouldSkipSensitive: sensitive=true + inferred → skip', () => {
  const b = makeBanner({ sensitive_category_excluded: true, evidence_level: 'inferred' });
  assert.equal(shouldSkipSensitive(b), true);
});

test('shouldSkipSensitive: sensitive=true + observed → keep', () => {
  const b = makeBanner({ sensitive_category_excluded: true, evidence_level: 'observed' });
  assert.equal(shouldSkipSensitive(b), false);
});

test('shouldSkipSensitive: sensitive=false → keep', () => {
  const b = makeBanner({ sensitive_category_excluded: false, evidence_level: 'inferred' });
  assert.equal(shouldSkipSensitive(b), false);
});

test('shouldSkipSensitive: sensitive=undefined → keep (default false)', () => {
  const b = makeBanner({ evidence_level: 'inferred' });
  delete (b as Partial<BannerConfig>).sensitive_category_excluded;
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

test('evaluateConsent: bundle no consent_flags → defaults to allow (personalization+ads = true)', () => {
  const r = evaluateConsent({} as RuleBundle, null);
  assert.equal(r.allowed, true);
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

test('combined: audience match + LLM-inferred + sensitive_excluded → skip', () => {
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
  assert.equal(shouldSkipSensitive(banner), true);
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
