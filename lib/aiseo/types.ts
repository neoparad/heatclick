/**
 * AISEO product 共通型定義 (Phase 1)
 *
 * AISEO-Director SSOT: linkscrawl/docs/fusion/team/aiseo-director/data-model.md
 *
 * Phase 1 では既存 linkscrawl scripts 出力 JSON を直読みする (integration-map.md §2)、
 * 本 file はその schema (Zod + 派生型) を定義する。Phase 2 で ClickHouse 表に同 schema を
 * 写像予定 (data-model.md §2.1)。
 *
 * tenant_id / site_id は AISEO Phase 1 (dogfood = linkth_internal × wakegai 単一) でも
 * 必須 parameter として持つ (CLAUDE.md §7 / 親 SSOT §3.8.1 遵守、Phase 3 multi-tenant 拡張時に
 * 後方互換性を維持するため)。
 */

import { z } from 'zod'

/**
 * 内部リンク提案 1 件 (linkscrawl/scripts/internal_link_agent.py 出力)
 *
 * 既存 agent JSON schema (現時点 推定、実 data 配備時に再確認):
 * - source_url: 提案元 page URL
 * - target_url: 提案先 page URL
 * - anchor_text: 提案アンカーテキスト
 * - confidence: 0-1 の信頼度 (cosine similarity 由来)
 * - context_snippet: 挿入位置周辺の本文抜粋 (省略可能、Phase 2 で必須化予定)
 */
export const InternalLinkProposalSchema = z.object({
  proposal_id: z.string(),
  tenant_id: z.string(),
  site_id: z.string(),
  source_url: z.string().url(),
  source_title: z.string().nullable(),
  target_url: z.string().url(),
  target_title: z.string().nullable(),
  anchor_text: z.string(),
  context_snippet: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  proposed_at: z.string(), // ISO8601
  status: z.enum(['pending', 'approved', 'applied', 'rejected']),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  applied_at: z.string().nullable(),
})

export type InternalLinkProposal = z.infer<typeof InternalLinkProposalSchema>

/**
 * Evidence Level (CLAUDE.md §4 / 親 SSOT §1.6 原則 2 / §1.8.2)
 *
 * AISEO Phase 1 で表示する全データに必須。内部リンク提案 1 件は
 * 「agent が cosine similarity から推定した値」なので `inferred` がデフォルト、
 * 人手 approve 後 (Phase 2) は `observed`、WordPress 適用済 (Phase 2.5) は `proven`。
 */
export const EvidenceLevelSchema = z.enum(['proven', 'observed', 'inferred', 'planned'])
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>

/**
 * loader 戻り型: proposals + meta (生成時刻 / source path / Evidence Level)
 */
export interface InternalLinkProposalsBatch {
  tenant_id: string
  site_id: string
  proposals: InternalLinkProposal[]
  /** 元 JSON file path もしくは fixture モード時は 'fixture://...' */
  source: string
  /** Phase 1 = 全件 inferred 固定、Phase 2 で per-proposal に変動 */
  evidence_level: EvidenceLevel
  /** loader が batch を解決した時刻 (ISO8601) */
  loaded_at: string
}
