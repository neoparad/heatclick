/**
 * AISEO Phase 1: 内部リンク提案 loader
 *
 * AISEO-Director SSOT: linkscrawl/docs/fusion/team/aiseo-director/integration-map.md §2 (Phase 1)
 *
 * Phase 1: 既存 linkscrawl 出力 JSON を直読み (read-only)。
 *   - LINKSCRAWL_DATA_ROOT 設定済 + proposals_*.json 存在 → 実 JSON parse
 *   - それ以外 (env 未設定 / file 不在) → fixture stub を返す
 *
 * Phase 2 (data-model.md §3 Phase 2): ClickHouse `aiseo_internal_link_proposals` table に
 *   linkscrawl/scripts/_etl/upload_to_clickhouse.py が INSERT し、本 loader を
 *   ClickHouse query 版に差し替え予定 (UI 側は無変更)。
 *
 * tenant_id / site_id は parameter binding 必須 (CLAUDE.md §7、Phase 3 multi-tenant 用)。
 * Phase 1 では tenant_id=linkth_internal / site_id=wakegai のみ実 data 想定。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  type InternalLinkProposal,
  type InternalLinkProposalsBatch,
  InternalLinkProposalSchema,
} from './types'
import { FIXTURE_INTERNAL_LINK_PROPOSALS } from './fixtures/internal-link-proposals'

interface LoadOptions {
  tenantId: string
  siteId: string
  /** 強制 fixture mode (test 用)。default = env で自動判定 */
  forceFixture?: boolean
}

const FIXTURE_SOURCE = 'fixture://lib/aiseo/fixtures/internal-link-proposals.ts'

function buildFixtureBatch(tenantId: string, siteId: string): InternalLinkProposalsBatch {
  return {
    tenant_id: tenantId,
    site_id: siteId,
    proposals: FIXTURE_INTERNAL_LINK_PROPOSALS.filter(
      (p) => p.tenant_id === tenantId && p.site_id === siteId,
    ),
    source: FIXTURE_SOURCE,
    evidence_level: 'inferred',
    loaded_at: new Date().toISOString(),
  }
}

async function resolveLatestProposalsFile(
  dataRoot: string,
  siteId: string,
): Promise<string | null> {
  const dir = path.join(dataRoot, 'internal_link', siteId)
  try {
    const files = await fs.readdir(dir)
    const matched = files
      .filter((f) => f.startsWith('proposals_') && f.endsWith('.json'))
      .sort()
    const latest = matched.at(-1)
    return latest ? path.join(dir, latest) : null
  } catch {
    return null
  }
}

/**
 * 内部リンク提案 batch を取得 (Phase 1 read-only)。
 *
 * - 実 JSON が読み取れた場合: file path を source に、proposals を Zod 検証してから返す
 * - 検証失敗 / file 不在 / env 未設定 → fixture batch を返す (warn を console.error に記録、
 *   production では Sentry に送る運用を Phase 2 で配備予定)
 *
 * tenant_id / site_id mismatch の proposal は無視 (cross-tenant 防止)。
 */
export async function loadInternalLinkProposals(
  options: LoadOptions,
): Promise<InternalLinkProposalsBatch> {
  const { tenantId, siteId, forceFixture = false } = options

  if (forceFixture) {
    return buildFixtureBatch(tenantId, siteId)
  }

  const dataRoot = process.env.LINKSCRAWL_DATA_ROOT
  if (!dataRoot) {
    return buildFixtureBatch(tenantId, siteId)
  }

  const filePath = await resolveLatestProposalsFile(dataRoot, siteId)
  if (!filePath) {
    return buildFixtureBatch(tenantId, siteId)
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return buildFixtureBatch(tenantId, siteId)
    }
    const validated: InternalLinkProposal[] = []
    for (const item of parsed) {
      const result = InternalLinkProposalSchema.safeParse(item)
      if (result.success && result.data.tenant_id === tenantId && result.data.site_id === siteId) {
        validated.push(result.data)
      }
    }
    return {
      tenant_id: tenantId,
      site_id: siteId,
      proposals: validated,
      source: filePath,
      evidence_level: 'inferred',
      loaded_at: new Date().toISOString(),
    }
  } catch {
    return buildFixtureBatch(tenantId, siteId)
  }
}
