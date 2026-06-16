/**
 * AISEO Phase 1 fixture: 内部リンク提案 sample data
 *
 * 用途: linkscrawl/data/internal_link/<site>/proposals_*.json が未配備の期間 (Phase 1 dev 段階) に
 *       loader が返す stub data。LINKSCRAWL_DATA_ROOT env 未設定 OR data file 不在時のみ使用。
 *
 * Phase 2 で linkscrawl 実 agent 出力が ClickHouse に流れ始めた時点で本 fixture は削除予定。
 * decisions.md 続 AISEO-1 §5 で本判断を記録。
 */

import type { InternalLinkProposal } from '../types'

const TENANT = 'linkth_internal'
const SITE = 'wakegai' // Phase 1 dogfood site
const NOW_ISO = '2026-05-26T14:50:00.000Z'

export const FIXTURE_INTERNAL_LINK_PROPOSALS: InternalLinkProposal[] = [
  {
    proposal_id: 'fixture-il-001',
    tenant_id: TENANT,
    site_id: SITE,
    source_url: 'https://wakegai.jp/column/divorce/divorce-house-loan/',
    source_title: '離婚時の住宅ローンはどうする?',
    target_url: 'https://wakegai.jp/knowledge/kyouyu-mochibun/divorce/divorce-bunkatu/',
    target_title: '離婚時の財産分与の基本',
    anchor_text: '財産分与の基本',
    context_snippet: '住宅ローンの扱いは、財産分与の基本ルールに沿って決まります。',
    confidence: 0.87,
    proposed_at: NOW_ISO,
    status: 'pending',
    approved_by: null,
    approved_at: null,
    applied_at: null,
  },
  {
    proposal_id: 'fixture-il-002',
    tenant_id: TENANT,
    site_id: SITE,
    source_url: 'https://wakegai.jp/column/inheritance/inheritance-share/',
    source_title: '相続持分とは',
    target_url: 'https://wakegai.jp/knowledge/kyouyu-mochibun/inheritance/inheritance-tax/',
    target_title: '相続税の計算方法',
    anchor_text: '相続税の計算',
    context_snippet: '持分を取得した場合、相続税の計算が必要になります。',
    confidence: 0.81,
    proposed_at: NOW_ISO,
    status: 'pending',
    approved_by: null,
    approved_at: null,
    applied_at: null,
  },
  {
    proposal_id: 'fixture-il-003',
    tenant_id: TENANT,
    site_id: SITE,
    source_url: 'https://wakegai.jp/column/buy-sell/share-sell-procedure/',
    source_title: '共有持分の売却手続き',
    target_url: 'https://wakegai.jp/knowledge/kyouyu-mochibun/buy-sell/share-buyer/',
    target_title: '共有持分の買主の選び方',
    anchor_text: '買主の選び方',
    context_snippet: '売却にあたっては信頼できる買主の選び方が重要です。',
    confidence: 0.76,
    proposed_at: NOW_ISO,
    status: 'pending',
    approved_by: null,
    approved_at: null,
    applied_at: null,
  },
  {
    proposal_id: 'fixture-il-004',
    tenant_id: TENANT,
    site_id: SITE,
    source_url: 'https://wakegai.jp/column/law-tax/share-tax-saving/',
    source_title: '共有持分の節税ポイント',
    target_url: 'https://wakegai.jp/knowledge/kyouyu-mochibun/law-tax/share-deduction/',
    target_title: '共有持分の控除制度',
    anchor_text: '控除制度',
    context_snippet: '節税には公的な控除制度の活用が有効です。',
    confidence: 0.72,
    proposed_at: NOW_ISO,
    status: 'pending',
    approved_by: null,
    approved_at: null,
    applied_at: null,
  },
  {
    proposal_id: 'fixture-il-005',
    tenant_id: TENANT,
    site_id: SITE,
    source_url: 'https://wakegai.jp/column/basic-knowledge/share-basic/',
    source_title: '共有持分とは何か',
    target_url: 'https://wakegai.jp/knowledge/kyouyu-mochibun/basic-knowledge/share-definition/',
    target_title: '共有持分の法的定義',
    anchor_text: '法的定義',
    context_snippet: '共有持分の正確な法的定義を押さえておきましょう。',
    confidence: 0.69,
    proposed_at: NOW_ISO,
    status: 'pending',
    approved_by: null,
    approved_at: null,
    applied_at: null,
  },
]
