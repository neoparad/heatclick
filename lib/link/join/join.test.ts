import { NotEntitledError } from '@/packages/contract/ledgers'
import { hash128, normText, segmentHtml } from '@/packages/contract/segmenter'
import {
  DEVICE_PROFILES,
  type ImmutableStructureSnapshot,
} from '@/lib/link/lab'

import {
  assertEscrowUseAllowed,
  computeBoundedRate,
  computeLayoutDriftMetrics,
  computePooledDwellTime,
  computePooledReachRate,
  detectPiiInEscrowText,
  evaluateClaimScopedGates,
  evaluateDriftAndRenderTrigger,
  evaluateNetworkWeightedQuorum,
  matchPvToSnapshot,
  selectMatchingSnapshotForFact,
  TextEscrowVault,
  UrlAliasGraph,
  type JoinQualityAttachment,
  type LayoutGeometryMap,
  type PvFingerprintBundle,
} from './index'

const APPROVED_D08 = () =>
  ({
    entitled: true,
    status: 'ok' as const,
    decisionId: 'D-08' as const,
    outcome: 'approved' as const,
    decidedAt: '2026-11-20',
  })

function buildSnapshotFromHtml(
  html: string,
  overrides: Partial<ImmutableStructureSnapshot> = {},
): ImmutableStructureSnapshot {
  const seg = segmentHtml(html, { url: 'https://example.jp/guide' })
  return Object.freeze({
    snapshot_id: 'snap_001',
    content_hash: 'h_001',
    tenant_id: 'tenant_a',
    site_id: 'site_1',
    page_id: 'page_1',
    url_id: 'u_1',
    url_key_v2: 'example.jp/guide',
    variant_set_key: 'default',
    identity_key: {
      link_grant_id: 'grant_1',
      producer: 'ugoki_second_executor',
      source_job_id: 'job_1',
      analysis_gen: 1,
      export_gen: 1,
      dataset_kind: 'structure_snapshot_v2',
      contract_ver: 'v2',
    },
    rendered_at: '2026-11-20T10:00:00.000Z',
    recorded_at: '2026-11-20T10:00:05.000Z',
    is_pre_change_baseline: false,
    baseline_reason: null,
    job_class: 'full',
    profile: DEVICE_PROFILES.desktop_chromium,
    segmenter_hash: seg.segmenter_hash,
    skel_fp: seg.skel_fp,
    struct_fp: seg.struct_fp,
    head_fp: seg.head_fp,
    css_fp: 'css_v1',
    res_fp: seg.res_fp,
    slot_fp: 'slot_v1',
    segmenter_output: seg,
    doc_h_px: 2000,
    section_geometries: null,
    element_details: Object.freeze([]),
    screenshot: null,
    volatile_sections: Object.freeze([]),
    css_volatile: false,
    ...overrides,
  })
}

const SAMPLE_HTML = `<!doctype html><html><head><title>Guide</title></head><body><main>
  <h2>料金プラン</h2><p>月額プランの比較と詳細を説明します。</p>
  <h2>よくある質問</h2><p>解約方法について説明します。</p>
  <a href="https://example.jp/signup">申し込む</a>
</main></body></html>`

// ===========================================================================
// 1. Exact Fingerprint Equality Join (matcher.ts)
// ===========================================================================

describe('Exact Fingerprint Equality Join (matcher.ts)', () => {
  test('joins ONLY on exact fingerprint equality declared by fact class, never by timestamp alone', () => {
    const snap = buildSnapshotFromHtml(SAMPLE_HTML)
    const sec0 = snap.segmenter_output!.sections[0]
    const el0 = snap.segmenter_output!.elements[0]

    const pv: PvFingerprintBundle = {
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      page_id: 'page_1',
      pv_id: 'pv_1',
      variant_set_key: 'default',
      observed_at: '2026-11-20T10:01:00.000Z',
      dom_state: 'ok',
      skel_fp: snap.skel_fp,
      css_fp: 'css_v1',
      head_fp: snap.head_fp,
      links_fp: snap.segmenter_output!.links_fp?.combined ?? null,
      res_fp: snap.res_fp,
      slot_fp: 'slot_v1',
      sections: [{ sec_fp: sec0.sec_fp, body_fp: sec0.body_fp, body_digest_128: sec0.body_digest_128 }],
      element_fps: [el0.el_fp],
    }

    // Matching section_text passes
    const textHit = matchPvToSnapshot({
      pv,
      snapshot: snap,
      fact_class: 'section_text',
      target_sec_fp: sec0.sec_fp,
    })
    expect(textHit.matched).toBe(true)
    expect(textHit.matched_keys).toEqual(['sec_fp', 'body_fp'])

    // Changed body_fp fails section_text EVEN IF observed_at is 1 second apart!
    const mutatedBodyPv: PvFingerprintBundle = {
      ...pv,
      sections: [{ sec_fp: sec0.sec_fp, body_fp: 'different_body_fp' }],
    }
    const textMiss = matchPvToSnapshot({
      pv: mutatedBodyPv,
      snapshot: snap,
      fact_class: 'section_text',
      target_sec_fp: sec0.sec_fp,
    })
    expect(textMiss.matched).toBe(false)
    expect(textMiss.reason).toBe('fingerprint_mismatch')

    // section_identity still matches when only body changed
    const idHit = matchPvToSnapshot({
      pv: mutatedBodyPv,
      snapshot: snap,
      fact_class: 'section_identity',
      target_sec_fp: sec0.sec_fp,
    })
    expect(idHit.matched).toBe(true)

    // private_scope MUST return not_collected
    const privRes = matchPvToSnapshot({
      pv: { ...pv, dom_state: 'private_scope' },
      snapshot: snap,
      fact_class: 'page_structure',
    })
    expect(privRes.status).toBe('not_collected')
    expect(privRes.matched).toBe(false)

    // Visual layout requires full_render + exact skel_fp + exact css_fp + G <= 0.08
    expect(
      matchPvToSnapshot({
        pv,
        snapshot: snap,
        fact_class: 'visual_layout',
        measured_geometry_drift_G: 0.05,
      }).matched,
    ).toBe(true)
    expect(
      matchPvToSnapshot({
        pv,
        snapshot: snap,
        fact_class: 'visual_layout',
        measured_geometry_drift_G: 0.09,
      }).reason,
    ).toBe('visual_geometry_drift_exceeded')
    expect(
      matchPvToSnapshot({
        pv,
        snapshot: buildSnapshotFromHtml(SAMPLE_HTML, { job_class: 'id_only' }),
        fact_class: 'visual_layout',
        measured_geometry_drift_G: 0.01,
      }).reason,
    ).toBe('visual_requires_full_render')

    // Lab-volatile section: carries identity ONLY, refuses text/audit carryover (§6.3)
    const volatileSnap = buildSnapshotFromHtml(SAMPLE_HTML, {
      volatile_sections: Object.freeze([sec0.sec_fp]),
    })
    expect(
      matchPvToSnapshot({
        pv,
        snapshot: volatileSnap,
        fact_class: 'section_identity',
        target_sec_fp: sec0.sec_fp,
      }).volatile_identity_only,
    ).toBe(true)
    expect(
      matchPvToSnapshot({
        pv,
        snapshot: volatileSnap,
        fact_class: 'section_text',
        target_sec_fp: sec0.sec_fp,
      }).reason,
    ).toBe('volatile_section_no_text_carryover')

    // selectMatchingSnapshotForFact picks exact-matching older snapshot over non-matching newer snapshot
    const wrongNewer = buildSnapshotFromHtml(SAMPLE_HTML, {
      snapshot_id: 'snap_newer_wrong_skel',
      skel_fp: 'other_skel',
      rendered_at: '2026-11-20T10:00:59.000Z',
    })
    const selected = selectMatchingSnapshotForFact({
      pv,
      snapshots: [wrongNewer, snap],
      fact_class: 'page_structure',
    })
    expect(selected.matched).toBe(true)
    expect(selected.snapshot_id).toBe('snap_001')
  })
})

// ===========================================================================
// 2. Drift Metrics (M_sec, O, G) & Re-render Triggers (drift.ts)
// ===========================================================================

describe('Layout Drift Metrics (M_sec, O, G) & Re-render Triggers', () => {
  const labLayout: LayoutGeometryMap = {
    doc_h_px: 1000,
    sections: [
      { sec_fp: 's1', ordinal: 0, top_px: 0, height_px: 250 },
      { sec_fp: 's2', ordinal: 1, top_px: 250, height_px: 250 },
      { sec_fp: 's3', ordinal: 2, top_px: 500, height_px: 250 },
      { sec_fp: 's4', ordinal: 3, top_px: 750, height_px: 250 },
    ],
  }

  test('subtracts pruned ad and consent banner heights so identical content layout yields G = 0', () => {
    // Field has 150px consent banner + 150px ad above s1, shifting all raw pixel tops by +300px
    const fieldWithAds: LayoutGeometryMap = {
      doc_h_px: 1300,
      total_pruned_consent_height_px: 150,
      total_pruned_ad_height_px: 150,
      sections: [
        { sec_fp: 's1', ordinal: 0, top_px: 300, height_px: 250, focal_ms: 4000, pruned_consent_height_above_px: 150, pruned_ad_height_above_px: 150 },
        { sec_fp: 's2', ordinal: 1, top_px: 550, height_px: 250, focal_ms: 3000, pruned_consent_height_above_px: 150, pruned_ad_height_above_px: 150 },
        { sec_fp: 's3', ordinal: 2, top_px: 800, height_px: 250, focal_ms: 2000, pruned_consent_height_above_px: 150, pruned_ad_height_above_px: 150 },
        { sec_fp: 's4', ordinal: 3, top_px: 1050, height_px: 250, focal_ms: 1000, pruned_consent_height_above_px: 150, pruned_ad_height_above_px: 150 },
      ],
    }

    const drift = computeLayoutDriftMetrics(fieldWithAds, labLayout)
    expect(drift.M_sec).toBeCloseTo(1, 6)
    expect(drift.M_sec_u).toBeCloseTo(1, 6)
    expect(drift.O).toBeCloseTo(0, 6)
    expect(drift.G).toBeCloseTo(0, 6)
    expect(drift.doc_h_rel_shift).toBeCloseTo(0, 6)
  })

  test('triggers identity_render on M_sec < 0.90 or O > 0.10, full_render on css/G/height/slot, skips volatile css, halts on lab_unreproducible', () => {
    const baseSnap = {
      snapshot_id: 'snap_full',
      job_class: 'full_render' as const,
      skel_fp: 'skel_1',
      css_fp: 'css_1',
      slot_fp: 'slot_1',
      css_volatile: false,
      layout: labLayout,
    }

    // Swapped order (s3 before s2) -> O = 1 - 3/4 = 0.25 > 0.10 -> identity_render
    const reorderedField: LayoutGeometryMap = {
      doc_h_px: 1000,
      sections: [
        { sec_fp: 's1', ordinal: 0, top_px: 0, height_px: 250, focal_ms: 1000 },
        { sec_fp: 's3', ordinal: 1, top_px: 250, height_px: 250, focal_ms: 1000 },
        { sec_fp: 's2', ordinal: 2, top_px: 500, height_px: 250, focal_ms: 1000 },
        { sec_fp: 's4', ordinal: 3, top_px: 750, height_px: 250, focal_ms: 1000 },
      ],
    }
    const orderDecision = evaluateDriftAndRenderTrigger({
      tenant_id: 't1',
      site_id: 's1',
      page_id: 'p1',
      variant_set_key: 'default',
      field_skel_fp: 'skel_1',
      field_css_fp: 'css_1',
      field_slot_fp: 'slot_1',
      field_unknown_body_fps: [],
      field_layout: reorderedField,
      lab_snapshot: baseSnap,
    })
    // Reordered sections also shift geometry G > 0.08 -> full_render!
    expect(orderDecision.drift!.O).toBeCloseTo(0.25, 6)
    expect(orderDecision.action).toBe('full_render')
    expect(orderDecision.visual_facts_valid).toBe(false)

    // Volatile CSS changed -> MUST NOT trigger full_render!
    const volatileCssDecision = evaluateDriftAndRenderTrigger({
      tenant_id: 't1',
      site_id: 's1',
      page_id: 'p1',
      variant_set_key: 'default',
      field_skel_fp: 'skel_1',
      field_css_fp: 'css_random_per_req',
      field_slot_fp: 'slot_1',
      field_unknown_body_fps: [],
      field_layout: labLayout,
      lab_snapshot: { ...baseSnap, css_volatile: true },
    })
    expect(volatileCssDecision.action).toBe('none')

    // Known skel_fp + unknown body_fp -> light_html_fetch first, then identity_render if absent in raw HTML
    const bodyLight = evaluateDriftAndRenderTrigger({
      tenant_id: 't1',
      site_id: 's1',
      page_id: 'p1',
      variant_set_key: 'default',
      field_skel_fp: 'skel_1',
      field_css_fp: 'css_1',
      field_slot_fp: 'slot_1',
      field_unknown_body_fps: ['body_new_99'],
      field_layout: labLayout,
      lab_snapshot: baseSnap,
    })
    expect(bodyLight.action).toBe('light_html_fetch')
    expect(bodyLight.visual_facts_valid).toBe(true)

    const bodyEscalate = evaluateDriftAndRenderTrigger({
      tenant_id: 't1',
      site_id: 's1',
      page_id: 'p1',
      variant_set_key: 'default',
      field_skel_fp: 'skel_1',
      field_css_fp: 'css_1',
      field_slot_fp: 'slot_1',
      field_unknown_body_fps: ['body_new_99'],
      field_layout: labLayout,
      lab_snapshot: baseSnap,
      light_html_fetch_lacked_new_body: true,
    })
    expect(bodyEscalate.action).toBe('identity_render')

    // lab_unreproducible halts spend immediately
    const halted = evaluateDriftAndRenderTrigger({
      tenant_id: 't1',
      site_id: 's1',
      page_id: 'p1',
      variant_set_key: 'default',
      field_skel_fp: 'skel_unknown',
      field_css_fp: 'css_2',
      field_slot_fp: 'slot_1',
      field_unknown_body_fps: [],
      field_layout: labLayout,
      lab_snapshot: baseSnap,
      lab_unreproducible_for_field_fp: true,
    })
    expect(halted.action).toBe('none')
    expect(halted.spend_halted_unreproducible).toBe(true)
  })
})

// ===========================================================================
// 3. Claim-Scoped Gates & Tenant-Scoped Partial Pooling (claim-gates.ts)
// ===========================================================================

describe('Claim-Scoped Gates & Hierarchical Partial Pooling (claim-gates.ts)', () => {
  test('marks uncomputable gates as unmet and enforces claim-specific requirements', () => {
    const uncomputableQuality: JoinQualityAttachment = {
      coverage: computeBoundedRate(0, 0),
      precision: computeBoundedRate(0, 0), // uncomputable -> unmet!
      drift: {
        M_sec: computeBoundedRate(95, 100),
        M_sec_u: computeBoundedRate(95, 100),
        O: 0.02,
        G: 0.04,
        positional_share: 0.05,
      },
      has_lab_or_escrow_text: true,
      has_valid_full_render: true,
      target_entity_matched: true,
    }

    const res = evaluateClaimScopedGates('section_own_metric', uncomputableQuality)
    expect(res.passed).toBe(false)
    expect(res.status).toBe('partial')
    expect(res.unmet_gates.some((g) => g.id === 'join.precision_lower_95')).toBe(true)

    const goodQuality: JoinQualityAttachment = {
      ...uncomputableQuality,
      coverage: computeBoundedRate(995, 1000),
      precision: computeBoundedRate(299, 300),
      drift: {
        M_sec: computeBoundedRate(980, 1000),
        M_sec_u: computeBoundedRate(970, 1000),
        O: 0.03,
        G: 0.05,
        positional_share: 0.1,
      },
    }
    expect(evaluateClaimScopedGates('page_relative_comparison', goodQuality).passed).toBe(true)
    expect(evaluateClaimScopedGates('visual_claim', goodQuality).passed).toBe(true)
    expect(
      evaluateClaimScopedGates('visual_claim', { ...goodQuality, has_valid_full_render: false })
        .passed,
    ).toBe(false)
  })

  test('uses width-based sufficiency (±10pt reach, ±25% dwell) and tenant-only partial pooling (weight >= 0.8 observed else inferred)', () => {
    // Low-traffic page (n=5) -> width > ±10pt -> pools with template_role -> site, weight < 0.8 -> inferred
    const pooled = computePooledReachRate({
      tenant_id: 'tenant_a',
      page: { tenant_id: 'tenant_a', successes: 4, trials: 5 },
      template_role: { tenant_id: 'tenant_a', successes: 60, trials: 100 },
      site: { tenant_id: 'tenant_a', successes: 500, trials: 1000 },
    })
    expect(pooled.used_partial_pooling).toBe(true)
    expect(pooled.pooling_weight).toBeLessThan(0.8)
    expect(pooled.evidence_level).toBe('inferred')
    expect(pooled.estimate).toBeGreaterThan(0.55)
    expect(pooled.estimate).toBeLessThan(0.8)

    // High-traffic page (n=200) -> width already <= ±10pt -> direct observed, pooling_weight = 1
    const direct = computePooledReachRate({
      tenant_id: 'tenant_a',
      page: { tenant_id: 'tenant_a', successes: 120, trials: 200 },
      site: { tenant_id: 'tenant_a', successes: 500, trials: 1000 },
    })
    expect(direct.used_partial_pooling).toBe(false)
    expect(direct.pooling_weight).toBe(1)
    expect(direct.evidence_level).toBe('observed')
    expect(direct.width_sufficient).toBe(true)

    // Cross-tenant pooling MUST throw!
    expect(() =>
      computePooledReachRate({
        tenant_id: 'tenant_a',
        page: { tenant_id: 'tenant_a', successes: 2, trials: 5 },
        site: { tenant_id: 'tenant_b', successes: 500, trials: 1000 },
      }),
    ).toThrow(/Cross-tenant/)

    // Dwell time relative width ±25%
    const dwellPooled = computePooledDwellTime({
      tenant_id: 'tenant_a',
      page: { tenant_id: 'tenant_a', n: 4, mean_ms: 12000, sd_ms: 9000 },
      template_role: { tenant_id: 'tenant_a', n: 80, mean_ms: 9000, sd_ms: 3500 },
      site: { tenant_id: 'tenant_a', n: 500, mean_ms: 8500, sd_ms: 4000 },
    })
    expect(dwellPooled.used_partial_pooling).toBe(true)
    expect(dwellPooled.evidence_level).toBe('inferred')
  })
})

// ===========================================================================
// 4. Network-Class Weighted Quorum & k-Anonymous Text Escrow (quorum-escrow.ts)
// ===========================================================================

describe('Network-Class Quorum Weighting & Text Escrow (D-08)', () => {
  test('downweights (never drops) over-cap PVs, reports downweighted_pv_share, and supports mobile CGNAT origin-signed sessions', () => {
    // 5 PVs from one fixed ISP network (cap=3) -> 2 PVs downweighted, share = 2/5 = 0.4
    const signals = Array.from({ length: 5 }, () => ({
      network_pseudonym: 'np_fixed_1',
      network_class: 'fixed_isp' as const,
      has_collector_token: true,
    }))
    const resSingleNet = evaluateNetworkWeightedQuorum({
      signals,
      remaining_daily_budget: 10,
    })
    expect(resSingleNet.quorum_met).toBe(false) // only 1 network
    expect(resSingleNet.downweighted_pv_count).toBe(2)
    expect(resSingleNet.downweighted_pv_share).toBeCloseTo(0.4, 6)
    expect(resSingleNet.effective_pv_weight).toBeGreaterThan(3) // downweighted, NOT dropped!

    // Japanese mobile carrier CGNAT with 2 distinct origin-signed sessions achieves quorum!
    const mobileSignals = [
      { network_pseudonym: 'np_docomo_1', network_class: 'mobile_carrier' as const, has_collector_token: true, origin_signed_session_key: 'sess_1' },
      { network_pseudonym: 'np_docomo_1', network_class: 'mobile_carrier' as const, has_collector_token: true, origin_signed_session_key: 'sess_1' },
      { network_pseudonym: 'np_docomo_1', network_class: 'mobile_carrier' as const, has_collector_token: true, origin_signed_session_key: 'sess_2' },
    ]
    const mobileRes = evaluateNetworkWeightedQuorum({
      signals: mobileSignals,
      remaining_daily_budget: 10,
    })
    expect(mobileRes.quorum_met).toBe(true)
    expect(mobileRes.confirmed_via).toBe('traffic_quorum')
  })

  test('Text Escrow enforces D-08 legal sign-off, PII rejection, 10PV/3net 128-bit digest quorum, zero PV refs, and analysis-only use', () => {
    const vault = new TextEscrowVault()
    const cleanText = '月額料金は税込3,300円で、初月は無料でお試しいただけます。'
    const digest128 = hash128(normText(cleanText))

    // Fails closed by default while D-08 is pending in live ledger
    expect(() =>
      vault.submitEscrowText({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        page_id: 'page_1',
        sec_fp: 'sec_1',
        claimed_body_digest_128: digest128,
        raw_section_text: cleanText,
        submitted_at: '2026-11-20T12:00:00Z',
        is_anonymous_public_scope: true,
        tenant_escrow_opt_in: true,
        consent_page_content_granted: true,
      }),
    ).toThrow(NotEntitledError)

    // PII text rejected even when D-08 approved
    expect(detectPiiInEscrowText('お問い合わせ: taro@example.jp / 090-1234-5678')).toHaveLength(2)
    const piiRes = vault.submitEscrowText({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      page_id: 'page_1',
      sec_fp: 'sec_1',
      claimed_body_digest_128: hash128(normText('連絡先は taro@example.jp です')),
      raw_section_text: '連絡先は taro@example.jp です',
      submitted_at: '2026-11-20T12:00:00Z',
      is_anonymous_public_scope: true,
      tenant_escrow_opt_in: true,
      consent_page_content_granted: true,
      decisionCheckOverride: APPROVED_D08,
    })
    expect(piiRes.accepted).toBe(false)
    expect(piiRes.rejection_reason).toBe('pii_detected')

    // Record 9 sightings across 3 networks -> still quorum_not_reached
    for (let i = 0; i < 9; i++) {
      vault.recordDigestSighting({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        page_id: 'page_1',
        sec_fp: 'sec_1',
        body_digest_128: digest128,
        network_pseudonym: `net_${i % 3}`,
        observed_at: '2026-11-20T11:00:00Z',
      })
    }
    expect(
      vault.submitEscrowText({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        page_id: 'page_1',
        sec_fp: 'sec_1',
        claimed_body_digest_128: digest128,
        raw_section_text: cleanText,
        submitted_at: '2026-11-20T12:00:00Z',
        is_anonymous_public_scope: true,
        tenant_escrow_opt_in: true,
        consent_page_content_granted: true,
        decisionCheckOverride: APPROVED_D08,
      }).rejection_reason,
    ).toBe('quorum_not_reached')

    // 10th sighting reaches quorum -> accepted!
    vault.recordDigestSighting({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      page_id: 'page_1',
      sec_fp: 'sec_1',
      body_digest_128: digest128,
      network_pseudonym: 'net_2',
      observed_at: '2026-11-20T11:30:00Z',
    })
    const okRes = vault.submitEscrowText({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      page_id: 'page_1',
      sec_fp: 'sec_1',
      claimed_body_digest_128: digest128,
      raw_section_text: cleanText,
      submitted_at: '2026-11-20T12:00:00Z',
      is_anonymous_public_scope: true,
      tenant_escrow_opt_in: true,
      consent_page_content_granted: true,
      decisionCheckOverride: APPROVED_D08,
    })
    expect(okRes.accepted).toBe(true)
    const rec = okRes.record!
    expect(rec.provenance).toBe('real_visit')
    expect(rec.evidence_level).toBe('inferred')
    // Zero PV/session/visitor reference fields
    expect('pv_id' in rec).toBe(false)
    expect('session_id' in rec).toBe(false)
    expect('visitor_id' in rec).toBe(false)

    // Allowed for inferred_analysis, STRICTLY forbidden for ai_citation / assistant_answer / auto_generation
    expect(() => assertEscrowUseAllowed(rec, 'inferred_analysis')).not.toThrow()
    expect(() => assertEscrowUseAllowed(rec, 'ai_citation')).toThrow(/prohibited/)
    expect(() => assertEscrowUseAllowed(rec, 'assistant_answer')).toThrow(/prohibited/)
    expect(() => assertEscrowUseAllowed(rec, 'auto_generation')).toThrow(/prohibited/)
  })
})

// ===========================================================================
// 5. Directed Timestamped URL Alias Graph (alias-graph.ts)
// ===========================================================================

describe('Directed Timestamped URL Alias Graph (alias-graph.ts)', () => {
  test('isolates tenants/sites and preserves historical consolidation after redirect retirement', () => {
    const graph = new UrlAliasGraph()

    // Cross-site or cross-tenant edge MUST throw
    expect(() =>
      graph.addEdge({
        tenant_id: 'tenant_a',
        site_id: 'site_1',
        to_site_id: 'site_2',
        from_url_key: 'a.jp/old',
        to_url_key: 'b.jp/new',
        kind: 'redirect',
        provenance: 'lab_confirmed',
        valid_from: '2026-10-01T00:00:00Z',
      }),
    ).toThrow(/cross tenant or site/)

    const edge = graph.addEdge({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      from_url_key: 'example.jp/old-path',
      to_url_key: 'example.jp/new-path',
      kind: 'redirect',
      provenance: 'lab_confirmed',
      valid_from: '2026-10-01T00:00:00Z',
    })

    // Retire redirect on Nov 15
    graph.retireEdge(edge.edge_id, '2026-11-15T00:00:00Z')

    // Historical query on Nov 10 STILL resolves old -> new (non-destructive!)
    const hist = graph.resolveAtTime({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      url_key: 'example.jp/old-path',
      as_of: '2026-11-10T00:00:00Z',
    })
    expect(hist.canonical_url_key).toBe('example.jp/new-path')
    expect(hist.hops).toHaveLength(1)

    // Post-retirement query on Nov 20 no longer follows retired redirect
    const post = graph.resolveAtTime({
      tenant_id: 'tenant_a',
      site_id: 'site_1',
      url_key: 'example.jp/old-path',
      as_of: '2026-11-20T00:00:00Z',
    })
    expect(post.canonical_url_key).toBe('example.jp/old-path')
    expect(post.hops).toHaveLength(0)
  })
})
