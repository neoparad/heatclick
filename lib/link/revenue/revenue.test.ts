import { webcrypto } from 'node:crypto'

import { NotEntitledError } from '@/packages/contract/ledgers'

import {
  AffiliateRolloutGuard,
  assertNoGrossMarginLeak,
  buildAttributedRevenueRecord,
  decorateAffiliateUrl,
  EcCatalogService,
  EcMemberSummaryStore,
  estimateSmallSampleApprovalRate,
  evaluateJoinG13Gate,
  evaluateProductExtractionGate,
  extractAffiliateKeyFromUrl,
  extractProductAttributes,
  filterUnavailableProductsAtEdge,
  InMemoryStrongUnavailableStore,
  isRegisteredAffiliateHost,
  projectExpectedRevenue,
  settleConversionRevenue,
  signEcWebhookPayload,
  signOfflineAffiliateAllowlist,
  type DailyClickReconciliationRow,
  type EcSkuFullPayload,
  type OfflineAffiliateAllowlistPayload,
} from './index'

const subtle = webcrypto.subtle

const APPROVED_D11 = () =>
  ({
    entitled: true,
    status: 'ok' as const,
    decisionId: 'D-11' as const,
    outcome: 'approved' as const,
    decidedAt: '2026-11-20',
  })

// ===========================================================================
// 1. Affiliate Registry, 5-Tier Revenue, Offline Allowlist & Rollout Guard
// ===========================================================================

describe('Affiliate Registry, 5-Tier Granularity, Offline-Signed Allowlist & Rollout Guard', () => {
  test('extracts network:program:product keys and blocks CRAWL access to registered affiliate hosts', () => {
    expect(isRegisteredAffiliateHost('px.a8.net')).toBe(true)
    expect(isRegisteredAffiliateHost('hb.afl.rakuten.co.jp')).toBe(true)
    expect(isRegisteredAffiliateHost('example.jp')).toBe(false)

    const a8 = extractAffiliateKeyFromUrl('https://px.a8.net/svt/ejp?a8mat=3T1234+ABCD+5678&sku=planA')
    expect(a8.matched).toBe(true)
    expect(a8.affiliate_key).toBe('a8:3T1234+ABCD+5678:planA')

    const amz = extractAffiliateKeyFromUrl('https://www.amazon.co.jp/dp/B08XYZ1234?tag=mytag-22')
    expect(amz.affiliate_key).toBe('amazon_jp:mytag-22:B08XYZ1234')
  })

  test('enforces 5-tier attribution evidence: Tier 4 single-click is strictly inferred, Tier 5 excluded from slot/ML', () => {
    const t1 = buildAttributedRevenueRecord({
      attribution_id: 'a1',
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      affiliate_key: 'a8:p1:item1',
      tier: 1,
      slot_id: 'slot_hero',
      click_id: 'clk_1',
      amount_jpy: 3000,
      candidate_click_count: 1,
      revenue_settled: true,
    })
    expect(t1.revenue_observation_evidence).toBe('observed')
    expect(t1.attribution_evidence).toBe('observed')
    expect(t1.not_slot_metric).toBe(false)

    // Tier 4 EVEN WITH 1 SINGLE CANDIDATE CLICK MUST BE `inferred` for attribution while revenue observation is `observed`!
    const t4Single = buildAttributedRevenueRecord({
      attribution_id: 'a4',
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'rakuten',
      affiliate_key: 'rakuten:p1:item1',
      tier: 4,
      slot_id: 'slot_mid',
      click_id: 'clk_2',
      amount_jpy: 1200,
      candidate_click_count: 1,
      revenue_settled: true,
    })
    expect(t4Single.revenue_observation_evidence).toBe('observed')
    expect(t4Single.attribution_evidence).toBe('inferred')
    expect(t4Single.method).toBe('tier4_time_window_single_click')

    // Tier 5 program x day proration -> inferred, allocated, excluded from slot eval & ML training
    const t5 = buildAttributedRevenueRecord({
      attribution_id: 'a5',
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'amazon_jp',
      affiliate_key: 'amazon_jp:tag:item1',
      tier: 5,
      slot_id: null,
      click_id: null,
      amount_jpy: 500,
      candidate_click_count: 15,
      revenue_settled: true,
    })
    expect(t5.attribution_evidence).toBe('inferred')
    expect(t5.allocated).toBe(true)
    expect(t5.not_slot_metric).toBe(true)
    expect(t5.not_training_label).toBe(true)
  })

  test('verifies Ed25519 offline-signed allowlist, requires D-11 + passkey, rejects unlisted params & overwrites', async () => {
    const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as webcrypto.CryptoKeyPair
    const payload: OfflineAffiliateAllowlistPayload = {
      release_version: 'aff-allow/1',
      issued_at: '2026-11-01T00:00:00Z',
      expires_at: '2026-12-31T00:00:00Z',
      allowed_params_by_network: { a8: ['id1', 'id2'] },
      approved_preset_ids: { 't1|s1|amazon_jp': ['own-tag-01-22'] },
    }
    const signed = await signOfflineAffiliateAllowlist(payload, kp.privateKey, kp.publicKey)
    const approval = {
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      approved_by_passkey: true,
      passkey_assertion_id: 'pk_001',
      approved_at: '2026-11-20T00:00:00Z',
      via_autonomous_envelope: false as const,
    }

    // Live D-11 pending -> fails closed with NotEntitledError
    await expect(
      decorateAffiliateUrl({
        tenant_id: 't1',
        site_id: 's1',
        network_id: 'a8',
        original_url: 'https://px.a8.net/svt/ejp?a8mat=123',
        param_name: 'id1',
        param_value: 'slotA',
        signed_allowlist: signed,
        pinned_public_key_spki_b64: signed.public_key_spki_b64,
        approval,
        now_iso: '2026-11-20T12:00:00Z',
      }),
    ).rejects.toThrow(NotEntitledError)

    // Allowed param succeeds without altering destination/existing params
    const ok = await decorateAffiliateUrl({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      original_url: 'https://px.a8.net/svt/ejp?a8mat=123',
      param_name: 'id1',
      param_value: 'slotA',
      signed_allowlist: signed,
      pinned_public_key_spki_b64: signed.public_key_spki_b64,
      approval,
      now_iso: '2026-11-20T12:00:00Z',
      decisionCheckOverride: APPROVED_D11,
    })
    expect(ok.decorated).toBe(true)
    expect(ok.url).toBe('https://px.a8.net/svt/ejp?a8mat=123&id1=slotA')

    // Unlisted param rejected
    const unlisted = await decorateAffiliateUrl({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      original_url: 'https://px.a8.net/svt/ejp?a8mat=123',
      param_name: 'evil_param',
      param_value: 'hijack',
      signed_allowlist: signed,
      pinned_public_key_spki_b64: signed.public_key_spki_b64,
      approval,
      now_iso: '2026-11-20T12:00:00Z',
      decisionCheckOverride: APPROVED_D11,
    })
    expect(unlisted.decorated).toBe(false)
    expect(unlisted.rejection_reason).toBe('param_not_in_offline_allowlist')

    // Overwriting existing param rejected
    const overwrite = await decorateAffiliateUrl({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      original_url: 'https://px.a8.net/svt/ejp?a8mat=123&id1=existing',
      param_name: 'id1',
      param_value: 'slotA',
      signed_allowlist: signed,
      pinned_public_key_spki_b64: signed.public_key_spki_b64,
      approval,
      now_iso: '2026-11-20T12:00:00Z',
      decisionCheckOverride: APPROVED_D11,
    })
    expect(overwrite.decorated).toBe(false)
    expect(overwrite.rejection_reason).toBe('existing_param_overwrite_prohibited')

    // Tier 2 preset ID rejects unapproved third-party tag
    const badPreset = await decorateAffiliateUrl({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'amazon_jp',
      original_url: 'https://www.amazon.co.jp/dp/B08XYZ1234',
      param_name: 'tag',
      param_value: 'attacker-tag-22',
      is_tier2_preset_id: true,
      signed_allowlist: signed,
      pinned_public_key_spki_b64: signed.public_key_spki_b64,
      approval: { ...approval, network_id: 'amazon_jp' },
      now_iso: '2026-11-20T12:00:00Z',
      decisionCheckOverride: APPROVED_D11,
    })
    expect(badPreset.decorated).toBe(false)
    expect(badPreset.rejection_reason).toBe('preset_id_not_approved')
  })

  test('enforces >=5% permanent holdout, <=10% initial rollout, and daily click-ratio auto-halt per network', () => {
    const guard = new AffiliateRolloutGuard()

    expect(() =>
      guard.configureNetwork({
        tenant_id: 't1',
        site_id: 's1',
        network_id: 'a8',
        phase: 'initial',
        rollout_share: 0.25, // > 10% initial cap!
      }),
    ).toThrow(/<= 0.1/)

    expect(() =>
      guard.configureNetwork({
        tenant_id: 't1',
        site_id: 's1',
        network_id: 'a8',
        phase: 'expanded',
        rollout_share: 0.9,
        permanent_holdout_share: 0.02, // < 5% holdout!
      }),
    ).toThrow(/>= 0.05/)

    guard.configureNetwork({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      phase: 'initial',
      rollout_share: 0.1,
    })
    guard.configureNetwork({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'afb',
      phase: 'initial',
      rollout_share: 0.1,
    })

    // Daily ratio deviation on a8 (50 / 100 = 0.50 < 0.85) halts ONLY a8, not afb!
    const haltRes = guard.evaluateDailyClickRatio({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      own_counted_clicks: 100,
      network_reported_clicks: 50,
    })
    expect(haltRes.auto_halted).toBe(true)
    expect(guard.getState('t1', 's1', 'a8')?.phase).toBe('auto_halted')
    expect(guard.getState('t1', 's1', 'afb')?.phase).toBe('initial')
    expect(
      guard.assignClickArm({ tenant_id: 't1', site_id: 's1', network_id: 'a8', click_id: 'c1' })
        .arm,
    ).toBe('halted')
  })
})

// ===========================================================================
// 2. Delay Model & join.G13 Reconciliation Gate
// ===========================================================================

describe('Conversion Delay Model & join.G13 Click Reconciliation', () => {
  test('estimates small-sample approval rate smoothly and replaces inferred projection with observed settlement', () => {
    const smallSample = estimateSmallSampleApprovalRate({ approved_count: 1, rejected_count: 0 })
    expect(smallSample.posterior_mean).toBeGreaterThan(0.7)
    expect(smallSample.posterior_mean).toBeLessThan(0.9) // shrunk, not jumping to 1.0!

    const proj = projectExpectedRevenue({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      elapsed_days: 3,
      observed_pending_jpy: 10000,
      historical_approved_count: 8,
      historical_rejected_count: 2,
    })
    expect(proj.evidence_level).toBe('inferred')
    expect(proj.is_settled).toBe(false)
    expect(proj.expected_settled_jpy).toBeGreaterThan(10000)

    const settled = settleConversionRevenue(
      {
        conversion_id: 'cv_1',
        tenant_id: 't1',
        site_id: 's1',
        network_id: 'a8',
        gross_amount_jpy: 10000,
        status: 'pending',
        settled_amount_jpy: null,
        expected_amount_jpy: proj.expected_settled_jpy,
        evidence_level: 'inferred',
        updated_at: '2026-11-20T00:00:00Z',
      },
      { status: 'approved', settled_amount_jpy: 9500, settled_at: '2026-12-01T00:00:00Z' },
    )
    expect(settled.evidence_level).toBe('observed')
    expect(settled.settled_amount_jpy).toBe(9500)
  })

  test('join.G13 passes on >=14d, >=200 network clicks, paired 95% CI in [0.85, 1.15], excluding lab/panel windows', () => {
    const rows: DailyClickReconciliationRow[] = []
    for (let d = 1; d <= 15; d++) {
      const date = `2026-11-${String(d).padStart(2, '0')}`
      rows.push({
        tenant_id: 't1',
        site_id: 's1',
        network_id: 'a8',
        device_class: 'mobile',
        date,
        own_clicks: 20,
        network_clicks: d % 2 === 0 ? 19 : 21, // ~1.00 ratio, tight paired discrepancy!
      })
    }
    // Add extreme lab/panel outlier row that MUST be excluded
    rows.push({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      device_class: 'mobile',
      date: '2026-11-16',
      own_clicks: 500,
      network_clicks: 0,
      is_lab_or_panel_window: true,
    })

    const passRes = evaluateJoinG13Gate({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      device_class: 'mobile',
      rows,
    })
    expect(passRes.passed).toBe(true)
    expect(passRes.status).toBe('pass')
    expect(passRes.excluded_lab_or_panel_rows).toBe(1)
    expect(passRes.days_included).toBe(15)
    expect(passRes.ci95_lower!).toBeGreaterThanOrEqual(0.85)
    expect(passRes.ci95_upper!).toBeLessThanOrEqual(1.15)

    // Only 10 days -> insufficient_data
    const shortRes = evaluateJoinG13Gate({
      tenant_id: 't1',
      site_id: 's1',
      network_id: 'a8',
      device_class: 'mobile',
      rows: rows.slice(0, 10),
    })
    expect(shortRes.passed).toBe(false)
    expect(shortRes.status).toBe('insufficient_data')
  })
})

// ===========================================================================
// 3. Physical EC Catalog, Triple Sold-Out Filter, Margin Isolation, Member Suppression & Extraction Gate
// ===========================================================================

describe('Physical EC Catalog (§8.13), Member Suppression Epoch & Product Extraction Gate (§8.5)', () => {
  const PROD_SECRET = 'ec-products-write-secret'
  const ORDER_SECRET = 'ec-orders-write-secret'

  const baseSku = (overrides: Partial<EcSkuFullPayload> = {}): EcSkuFullPayload => ({
    sku_id: 'sku_red_m',
    parent_product_id: 'prod_jacket',
    sku_version: 1,
    title: '防水ジャケット',
    product_url: 'https://shop.example.jp/items/jacket?utm_source=x',
    image_url: 'https://shop.example.jp/img/jacket.jpg',
    in_stock: true,
    stock_quantity: 5,
    published: true,
    sale_start_at: null,
    sale_end_at: null,
    price: 19800,
    currency: 'JPY',
    category: 'outerwear',
    brand: 'NorthPeak',
    durability: 'durable',
    repurchase_cycle_days: null,
    sensitive_category: false,
    gross_margin: 8500,
    updated_at: '2026-11-20T12:00:00Z',
    ...overrides,
  })

  test('handles full SKU webhook versioning, rejects partials, returns 503 on store failure, isolates gross_margin, and enforces freshness/gap fail-closed', () => {
    const strongStore = new InMemoryStrongUnavailableStore()
    const memberStore = new EcMemberSummaryStore()
    const ec = new EcCatalogService({
      products_write_secret: PROD_SECRET,
      orders_write_secret: ORDER_SECRET,
      strong_store: strongStore,
      member_store: memberStore,
      stock_freshness_ttl_ms: 3600_000,
      price_freshness_ttl_ms: 7200_000,
      heartbeat_ttl_ms: 900_000,
    })

    // 1. Ingest full feed with 2 child SKUs + gross margin
    const feedRes = ec.ingestFullProductFeed({
      tenant_id: 't1',
      site_id: 'shop1',
      synced_at: '2026-11-20T12:00:00Z',
      items: [
        baseSku({ sku_id: 'sku_red_m', sku_version: 2, in_stock: true, gross_margin: 8500 }),
        baseSku({ sku_id: 'sku_blue_l', sku_version: 2, in_stock: false, gross_margin: 8500 }),
      ],
    })
    expect(feedRes.http_status).toBe(200)

    // Gross margin available ONLY server-side, NEVER in browser projection!
    expect(ec.getServerOnlyGrossMargin('t1', 'shop1', 'sku_red_m')).toBe(8500)
    const proj = ec.toBrowserProductProjection('t1', 'shop1', 'prod_jacket', '2026-11-20T12:05:00Z')!
    expect(proj.available).toBe(true)
    expect(proj.price).toBe(19800)
    expect('gross_margin' in proj).toBe(false)
    expect(() => assertNoGrossMarginLeak(proj)).not.toThrow()
    expect(() => assertNoGrossMarginLeak({ ...proj, gross_margin: 8500 })).toThrow(/gross margin/i)

    // 2. Partial SKU webhook MUST be rejected (400)
    const ts = 1795089900
    const partialBody = JSON.stringify({ sku_id: 'sku_red_m', in_stock: false })
    const partialRes = ec.ingestSkuDeltaWebhook(
      {
        tenant_id: 't1',
        site_id: 'shop1',
        event_id: 'ev_partial',
        sku: { sku_id: 'sku_red_m', in_stock: false },
        raw_body: partialBody,
        auth: {
          scope: 'products:write',
          timestamp_sec: ts,
          signature: signEcWebhookPayload({
            tenant_id: 't1',
            site_id: 'shop1',
            scope: 'products:write',
            timestamp_sec: ts,
            raw_body: partialBody,
            secret: PROD_SECRET,
          }),
        },
      },
      '2026-11-20T12:05:00Z',
    )
    expect(partialRes.http_status).toBe(400)

    // 3. Stale sku_version (v1 <= v2) safely ignored
    const staleSku = baseSku({ sku_id: 'sku_red_m', sku_version: 1, in_stock: false })
    const staleBody = JSON.stringify(staleSku)
    const staleRes = ec.ingestSkuDeltaWebhook(
      {
        tenant_id: 't1',
        site_id: 'shop1',
        event_id: 'ev_stale',
        sequence_no: 1,
        sku: staleSku,
        raw_body: staleBody,
        auth: {
          scope: 'products:write',
          timestamp_sec: ts,
          signature: signEcWebhookPayload({
            tenant_id: 't1',
            site_id: 'shop1',
            scope: 'products:write',
            timestamp_sec: ts,
            raw_body: staleBody,
            secret: PROD_SECRET,
          }),
        },
      },
      '2026-11-20T12:05:00Z',
    )
    expect(staleRes.http_status).toBe(200)
    expect(staleRes.stale_version_ignored).toBe(true)
    expect(ec.evaluateParentProductState('t1', 'shop1', 'prod_jacket', '2026-11-20T12:05:00Z').available).toBe(true)

    // 4. Strong store failure returns 503 and rolls back in-memory state
    strongStore.failNextCommit = true
    const soldOutSku = baseSku({ sku_id: 'sku_red_m', sku_version: 3, in_stock: false })
    const soldOutBody = JSON.stringify(soldOutSku)
    const fail503 = ec.ingestSkuDeltaWebhook(
      {
        tenant_id: 't1',
        site_id: 'shop1',
        event_id: 'ev_soldout_retry',
        sequence_no: 2,
        sku: soldOutSku,
        raw_body: soldOutBody,
        auth: {
          scope: 'products:write',
          timestamp_sec: ts,
          signature: signEcWebhookPayload({
            tenant_id: 't1',
            site_id: 'shop1',
            scope: 'products:write',
            timestamp_sec: ts,
            raw_body: soldOutBody,
            secret: PROD_SECRET,
          }),
        },
      },
      '2026-11-20T12:06:00Z',
    )
    expect(fail503.http_status).toBe(503)

    // Retry succeeds -> parent product now unavailable because BOTH child SKUs are out of stock!
    const okSoldOut = ec.ingestSkuDeltaWebhook(
      {
        tenant_id: 't1',
        site_id: 'shop1',
        event_id: 'ev_soldout_retry',
        sequence_no: 2,
        sku: soldOutSku,
        raw_body: soldOutBody,
        auth: {
          scope: 'products:write',
          timestamp_sec: ts,
          signature: signEcWebhookPayload({
            tenant_id: 't1',
            site_id: 'shop1',
            scope: 'products:write',
            timestamp_sec: ts,
            raw_body: soldOutBody,
            secret: PROD_SECRET,
          }),
        },
      },
      '2026-11-20T12:06:05Z',
    )
    expect(okSoldOut.http_status).toBe(200)
    expect(okSoldOut.applied).toBe(true)

    // 5. Triple Sold-Out Exclusion APIs (browser page_id-only / edge HTML / reverse URL index)
    ec.registerPageProductPlacement({
      tenant_id: 't1',
      site_id: 'shop1',
      page_id: 'page_top',
      page_url: 'https://shop.example.jp/winter-picks',
      product_ids: ['prod_jacket'],
    })
    const browserCheck = ec.checkPageProductsForBrowser({
      tenant_id: 't1',
      site_id: 'shop1',
      page_id: 'page_top',
      now_iso: '2026-11-20T12:07:00Z',
    })
    expect(browserCheck.works_under_consent_off).toBe(true)
    expect(browserCheck.requires_visitor_info).toBe(false)
    expect(browserCheck.unavailable_product_ids).toEqual(['prod_jacket'])

    const edgeFiltered = filterUnavailableProductsAtEdge(
      '<div class="grid"><article data-ugk-product-id="prod_jacket">Jacket</article><article data-ugk-product-id="prod_hat">Hat</article></div>',
      browserCheck.unavailable_product_ids,
    )
    expect(edgeFiltered.removed_count).toBe(1)
    expect(edgeFiltered.html).not.toContain('prod_jacket')
    expect(edgeFiltered.html).toContain('prod_hat')

    const reverse = ec.getPagesFeaturingProduct('t1', 'shop1', 'prod_jacket')
    expect(reverse.affected_page_urls).toEqual(['shop.example.jp/winter-picks'])
    expect(reverse.counts_against_7day_reorder_limit).toBe(false)

    // 6. Heartbeat expiration fails closed to unavailable + hides stale price!
    const restocked = ec.ingestFullProductFeed({
      tenant_id: 't1',
      site_id: 'shop1',
      synced_at: '2026-11-20T12:10:00Z',
      items: [baseSku({ sku_id: 'sku_red_m', sku_version: 4, in_stock: true, updated_at: '2026-11-20T12:10:00Z' })],
    })
    expect(restocked.http_status).toBe(200)
    // 3 hours later (> 15m heartbeat & > 2h price TTL) -> unavailable & hide_price=true!
    const expiredProj = ec.toBrowserProductProjection(
      't1',
      'shop1',
      'prod_jacket',
      '2026-11-20T15:30:00Z',
    )!
    expect(expiredProj.available).toBe(false)
    expect(expiredProj.hide_price).toBe(true)
    expect(expiredProj.price).toBeNull()
  })

  test('Member suppression_epoch blocks nightly rebuild, order replay, historical backfill & backup restore from resurrecting deleted member', () => {
    const store = new EcMemberSummaryStore()

    // Initial write at epoch 1
    const init = store.upsertSummary({
      tenant_id: 't1',
      site_id: 'shop1',
      member_key: 'mem_hash_1',
      data_epoch: 1,
      write_source: 'nightly_summary_rebuild',
      recent_purchased_product_ids: ['p1'],
      category_affinity: { skincare: 0.9 },
      upcoming_repurchase_product_ids: ['p1'],
      excluded_product_ids: ['p1'],
      source_retention_expires_at: '2027-11-20T00:00:00Z',
      updated_at: '2026-11-20T01:00:00Z',
    })
    expect(init.accepted).toBe(true)

    // Dual consent required for read
    expect(
      store.readSummaryForRecommendation({
        tenant_id: 't1',
        site_id: 'shop1',
        member_key: 'mem_hash_1',
        consent_member_link: true,
        consent_personalisation: false,
        now_iso: '2026-11-20T02:00:00Z',
      }).summary,
    ).toBeNull()

    // Record member deletion -> strong suppression_epoch = 2, summary deleted
    const mark = store.recordMemberSuppression({
      tenant_id: 't1',
      site_id: 'shop1',
      member_key: 'mem_hash_1',
      reason: 'deletion_request',
      suppressed_at: '2026-11-20T03:00:00Z',
    })
    expect(mark.suppression_epoch).toBe(2)

    // Stale nightly rebuild / order replay / historical backfill / backup restore (epoch <= 2) ALL REJECTED!
    for (const src of [
      'nightly_summary_rebuild',
      'historical_order_backfill',
      'backup_restore',
    ] as const) {
      const attempt = store.upsertSummary({
        tenant_id: 't1',
        site_id: 'shop1',
        member_key: 'mem_hash_1',
        data_epoch: 2,
        write_source: src,
        recent_purchased_product_ids: ['p1'],
        category_affinity: { skincare: 0.9 },
        upcoming_repurchase_product_ids: [],
        excluded_product_ids: [],
        source_retention_expires_at: '2027-11-20T00:00:00Z',
        updated_at: '2026-11-20T04:00:00Z',
      })
      expect(attempt.accepted).toBe(false)
      expect(attempt.rejection_reason).toBe('rejected_by_suppression_epoch')
    }

    const orderReplay = store.applyOrderNotification({
      tenant_id: 't1',
      site_id: 'shop1',
      member_key: 'mem_hash_1',
      order_status: 'placed',
      product_ids: ['p2'],
      data_epoch: 1,
      occurred_at: '2026-11-20T04:00:00Z',
    })
    expect(orderReplay.accepted).toBe(false)
    expect(orderReplay.rejection_reason).toBe('rejected_by_suppression_epoch')
  })

  test('extracts product attributes and enforces 200-sample >= 0.90 95% lower-bound gate (§8.5)', () => {
    const attrs = extractProductAttributes({
      json_ld_objects: [
        {
          '@type': 'Product',
          name: '美容液プレミアム',
          sku: 'SERUM-01',
          brand: { name: 'KireiLab' },
          offers: { price: 4980, priceCurrency: 'JPY' },
        },
      ],
      affiliate_links: ['https://px.a8.net/svt/ejp?a8mat=999&sku=SERUM-01'],
      comparison_table_rows: [{ attribute: '容量', value: '50ml' }],
    })
    expect(attrs.product_name).toBe('美容液プレミアム')
    expect(attrs.price).toBe(4980)
    expect(attrs.affiliate_key).toBe('a8:999:SERUM-01')
    expect(attrs.specs['容量']).toBe('50ml')

    // 195/200 -> accuracy 0.975, lower_95 > 0.90 -> PASS
    const passSamples = Array.from({ length: 200 }, (_, i) => ({
      sample_id: `s_${i}`,
      exact_match: i < 195,
    }))
    const gatePass = evaluateProductExtractionGate(passSamples)
    expect(gatePass.passed).toBe(true)
    expect(gatePass.lower_95!).toBeGreaterThanOrEqual(0.9)

    // 180/200 -> point est 0.90, but 95% LOWER BOUND < 0.90 -> FAIL!
    const failSamples = Array.from({ length: 200 }, (_, i) => ({
      sample_id: `s_${i}`,
      exact_match: i < 180,
    }))
    expect(evaluateProductExtractionGate(failSamples).passed).toBe(false)

    // 150/150 -> < 200 human labels -> insufficient_data
    const tooFew = Array.from({ length: 150 }, (_, i) => ({
      sample_id: `s_${i}`,
      exact_match: true,
    }))
    expect(evaluateProductExtractionGate(tooFew).status).toBe('insufficient_data')
  })
})
