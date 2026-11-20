/**
 * AISEO Phase 1: 内部リンク提案 loader
 *
 * Wave 0 (束 0-A 止血):
 *   - 本番経路での fixture stub 自動フォールバックを完全廃止。
 *   - `LINKSCRAWL_DATA_ROOT` 未設定・ファイル不在・パース失敗時は
 *     `status: 'not_collected'`, `source: 'not_collected'`, `proposals: []` を返す。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  type InternalLinkProposal,
  type InternalLinkProposalsBatch,
  InternalLinkProposalSchema,
} from './types'

interface LoadOptions {
  tenantId: string
  siteId: string
}

function buildNotCollectedBatch(
  tenantId: string,
  siteId: string,
  reason: string,
): InternalLinkProposalsBatch {
  return {
    status: 'not_collected',
    reason,
    tenant_id: tenantId,
    site_id: siteId,
    proposals: [],
    source: 'not_collected',
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

export async function loadInternalLinkProposals(
  options: LoadOptions,
): Promise<InternalLinkProposalsBatch> {
  const { tenantId, siteId } = options

  const dataRoot = process.env.LINKSCRAWL_DATA_ROOT
  if (!dataRoot) {
    return buildNotCollectedBatch(
      tenantId,
      siteId,
      'LINKSCRAWL_DATA_ROOT が未設定のため内部リンク提案は未収集です (not_collected)',
    )
  }

  const filePath = await resolveLatestProposalsFile(dataRoot, siteId)
  if (!filePath) {
    return buildNotCollectedBatch(
      tenantId,
      siteId,
      '対象サイトの proposals_*.json が未生成のため内部リンク提案は未収集です (not_collected)',
    )
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return buildNotCollectedBatch(
        tenantId,
        siteId,
        'proposals ファイル形式不正のため内部リンク提案は未収集です (not_collected)',
      )
    }
    const validated: InternalLinkProposal[] = []
    for (const item of parsed) {
      const result = InternalLinkProposalSchema.safeParse(item)
      if (result.success && result.data.tenant_id === tenantId && result.data.site_id === siteId) {
        validated.push(result.data)
      }
    }
    return {
      status: validated.length > 0 ? 'ok' : 'not_collected',
      reason:
        validated.length > 0
          ? undefined
          : '対象テナント・サイトの有効な提案レコードが0件です (not_collected)',
      tenant_id: tenantId,
      site_id: siteId,
      proposals: validated,
      source: filePath,
      evidence_level: 'inferred',
      loaded_at: new Date().toISOString(),
    }
  } catch {
    return buildNotCollectedBatch(
      tenantId,
      siteId,
      'proposals ファイル読込失敗のため内部リンク提案は未収集です (not_collected)',
    )
  }
}
