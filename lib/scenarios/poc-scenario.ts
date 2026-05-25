/**
 * M-Director (2026-05-25): Phase 1 PoC scenarios (hard-code, live 配信)
 *
 * Reference: linkscrawl/docs/fusion/team/m-director/prd.md §5 (Path A 採用後)
 *
 * Phase 1 strategy (Path A, Owner 2026-05-25 撤回後の確定方針):
 *   - status='live' = 条件が真になった visitor に対し A/B/C のうち traffic_split で
 *     決定された 1 variant を実際にページに表示する (DOM inject)。
 *   - Phase 2: /api/scenarios CRUD で PostgreSQL から動的に読む。
 *   - Phase 3: AI 自動提案 + 勝者自動学習 (仕様は Owner 厳密設計待ち)。
 *
 * §1.7.1 改訂依頼: 親 SSOT §1.7.1 (Codex Round 4 確定) は traffic allocation +
 *   variant execution を UGOKI 内製 ❌、VWO 委譲としているが、Owner 2026-05-25 で
 *   「Phase 1 内製配信」が確定したため §1.7.1 改訂を Owner 判断で実施する必要あり。
 *   それまでは本ファイルが Owner 直書きの hard-code = 親 SSOT 改訂前の例外として
 *   存在 (Phase 1 PoC scope に限定)。
 */

import type { Scenario } from './types'

// Stable UUIDs (client cache + ClickHouse rows reference same id across deploys)
const POC_BIHADASHOP_FIRST_VISIT_CART_INCENTIVE = '00000000-0000-4000-8000-00000000d001'

const NOW_ISO = '2026-05-25T00:00:00.000Z'

export const POC_SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: POC_BIHADASHOP_FIRST_VISIT_CART_INCENTIVE,
    tenant_id: 'linkth_internal',
    site_id: 'CIP_EcwUTHEZdIOAUqum',
    name: '初回 + organic + 60s + cart 未到達 → 10% OFF (A/B/C)',
    description:
      'Phase 1 PoC. status=live で実配信、A/B/C 3 variants を 34/33/33% で split。' +
      ' 1 visitor あたり同 variant に決定論的に固定 (visitor_id hash)。',
    condition_ast: {
      op: 'AND',
      children: [
        { op: 'EQ', field: 'utm_medium', value: 'organic' },
        { op: 'GTE', field: 'session_duration_sec', value: 60 },
        { op: 'GTE', field: 'page_views_in_session', value: 3 },
        { op: 'NOT_VISITED', field: 'url_path', value: '/cart' },
        { op: 'EQ', field: 'is_first_visit', value: true },
      ],
    },
    variants: [
      {
        id: 'A',
        content_type: 'image',
        image_url: 'https://ugokimap.com/static/poc/bihadashop-first10-popup.png',
        image_alt: '初回限定 10% OFF クーポン (コード: FIRST10)',
        image_width: 480,
        image_height: 320,
        cta_url: 'https://bihadashop.jp/products?promo=FIRST10',
        position: 'center',
        traffic_split: 34,
      },
      {
        id: 'B',
        content_type: 'html',
        html:
          '<div style="font-family:system-ui;text-align:center;">' +
          '<h3 style="margin:0 0 8px;font-size:18px;color:#0f1117;">初回限定 10% OFF</h3>' +
          '<div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:16px;color:#4f6bff;background:#eef1ff;padding:6px 12px;border-radius:6px;display:inline-block;font-weight:700;">FIRST10</div>' +
          '<p style="margin:12px 0 16px;font-size:13px;color:#5b6478;line-height:1.55;">ご新規様限定、初回購入が 10% OFF になります。</p>' +
          '</div>',
        cta_url: 'https://bihadashop.jp/products?promo=FIRST10',
        position: 'center',
        traffic_split: 33,
      },
      {
        id: 'C',
        content_type: 'image',
        image_url: 'https://ugokimap.com/static/poc/bihadashop-first10-sidebar.png',
        image_alt: 'FIRST10 クーポン (サイドバナー)',
        image_width: 320,
        image_height: 240,
        cta_url: 'https://bihadashop.jp/products?promo=FIRST10',
        position: 'bottom-right',
        traffic_split: 33,
      },
    ],
    status: 'live',
    evidence_level: 'planned',
    evidence_data: {
      basis: 'M-Director Phase 1 PoC (hard-code), Path A 実配信',
      observation_period_days: 14,
    },
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    created_by: 'm-director@ugokimap.com',
    archived_at: null,
  },
]

export function getPocScenariosForTenant(tenant_id: string, site_id: string): ReadonlyArray<Scenario> {
  return POC_SCENARIOS.filter((s) => s.tenant_id === tenant_id && s.site_id === site_id && s.archived_at === null)
}
