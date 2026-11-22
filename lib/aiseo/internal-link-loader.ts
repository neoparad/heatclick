/**
 * AISEO Phase 1: 内部リンク提案 loader
 *
 * Wave 0 (束 0-A 止血) + Wave 8 L-02 パストラバーサル防御:
 *   - 本番経路での fixture stub 自動フォールバックを完全廃止。
 *   - `siteId` / `tenantId` を `/^[a-zA-Z0-9_-]{1,64}$/` で厳格検証し、さらに `path.resolve` による
 *     `dataRoot/internal_link` 配下のディレクトリ封じ込め検査を実施する。
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

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const SAFE_PROPOSALS_FILENAME_PATTERN = /^proposals_[a-zA-Z0-9._-]+\.json$/

export class InvalidInternalLinkIdentifierError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'InvalidInternalLinkIdentifierError'
  }
}

export function assertSafeInternalLinkId(value: string, fieldName: 'siteId' | 'tenantId'): void {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    throw new InvalidInternalLinkIdentifierError(
      `Invalid ${fieldName}: must match /^[a-zA-Z0-9_-]{1,64}$/`,
    )
  }
}

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
  assertSafeInternalLinkId(siteId, 'siteId')

  const baseDir = path.resolve(dataRoot, 'internal_link')
  const siteDir = path.resolve(baseDir, siteId)
  if (!siteDir.startsWith(baseDir + path.sep)) {
    throw new InvalidInternalLinkIdentifierError('Path traversal blocked for siteId')
  }

  try {
    const files = await fs.readdir(siteDir)
    const matched = files
      .filter((f) => SAFE_PROPOSALS_FILENAME_PATTERN.test(f) && !f.includes('..'))
      .sort()
    const latest = matched.at(-1)
    if (!latest) return null
    const resolvedFile = path.resolve(siteDir, latest)
    if (!resolvedFile.startsWith(siteDir + path.sep)) {
      throw new InvalidInternalLinkIdentifierError('Path traversal blocked for proposals file')
    }
    return resolvedFile
  } catch (err) {
    if (err instanceof InvalidInternalLinkIdentifierError) {
      throw err
    }
    return null
  }
}

export async function loadInternalLinkProposals(
  options: LoadOptions,
): Promise<InternalLinkProposalsBatch> {
  const { tenantId, siteId } = options
  assertSafeInternalLinkId(tenantId, 'tenantId')
  assertSafeInternalLinkId(siteId, 'siteId')

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
