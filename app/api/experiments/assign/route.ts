/**
 * GET /api/experiments/assign — 宝プロジェクト M2b (サーバー権威 arm 割付配信)
 *
 * customer サイトの ugokimap タグ (別オリジン・JWT なし) が visitor_id 付きで叩く公開 endpoint。
 * running かつ window 内の実験について **サーバー側で計算した arm** を返す。フロントは arm を
 * 上書きできない (salt はサーバーのみ)。計測 (M3) は同じ computeArm で arm を再計算する。
 *
 * SECURITY:
 *   - visitor_id は isValidVisitorId で hygiene 検証。これは arm-stuffing への完全防御ではない
 *     (層別防御: M3 is_agent 除外 / M5 SITE 単位 K≥24+異質性 が corpus を守る。Owner 2026-06-10 判断、
 *      lib/experiments/assignment.ts SECURITY ブロック参照)。
 *   - no-store (REQ-SEC-006 同方針: per-visitor 応答を CDN 共有キャッシュさせない)。
 *   - 返却は PII なし (実験 id / url_pattern / arm のみ、customer サイトで匿名 visitor に配る前提)。
 *     cross-tenant probe は 404 で tenant 存在を隠す (scenarios/runtime と同方針)。
 *   - middleware で api-public 登録 (JWT 免除)。
 *   - tenant_id は repo.list の WHERE に渡され全クエリ tenant scoped (§3.8.1)。
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'

import {
  getAssignSalt,
  isValidVisitorId,
  AssignSaltMissingError,
} from '@/lib/experiments/assignment'
import { resolveActiveAssignments } from '@/lib/experiments/assign-resolve'
import { createExperimentRepository } from '@/lib/experiments/repository'
import { PostgresExperimentStore } from '@/lib/experiments/postgres-store'
import type { Experiment } from '@/lib/experiments/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}
const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' }
const PUBLIC_HEADERS = { ...CORS_HEADERS, ...NO_STORE }

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: PUBLIC_HEADERS })
}

const QuerySchema = z.object({
  tenant_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  site_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  visitor_id: z.string().min(1).max(128),
})

const AssignmentResponseSchema = z.object({
  tenant_id: z.string(),
  site_id: z.string(),
  generated_at: z.string().datetime(),
  assignments: z.array(
    z.object({
      experiment_id: z.string().uuid(),
      arm: z.enum(['control', 'treatment']),
      url_pattern: z.string(),
    }),
  ),
})

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    tenant_id: searchParams.get('tenant_id') ?? '',
    site_id: searchParams.get('site_id') ?? '',
    visitor_id: searchParams.get('visitor_id') ?? '',
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400, headers: PUBLIC_HEADERS })
  }
  const { tenant_id, site_id, visitor_id } = parsed.data

  // visitor_id hygiene (層別防御の一段。grinding は防げない)
  if (!isValidVisitorId(visitor_id)) {
    return NextResponse.json({ error: 'invalid_visitor' }, { status: 400, headers: PUBLIC_HEADERS })
  }

  // server secret (未設定なら割付不能 = 503、silent な弱割付を許さない)
  let salt: string
  try {
    salt = getAssignSalt()
  } catch (e) {
    if (e instanceof AssignSaltMissingError) {
      // eslint-disable-next-line no-console
      console.error('[experiments/assign] EXPERIMENT_ASSIGN_SALT not configured')
      return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: PUBLIC_HEADERS })
    }
    throw e
  }

  // running + 有界 window の実験のみ取得 (SQL 側で絞り、public endpoint の作業量を有界化、Codex M2b)。
  const nowMs = Date.now()
  let experiments: Experiment[]
  try {
    const repo = createExperimentRepository({ store: new PostgresExperimentStore() })
    experiments = await repo.listActiveForAssignment(tenant_id, site_id, new Date(nowMs).toISOString())
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[experiments/assign] registry unavailable: ${(e as Error).message}`)
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: PUBLIC_HEADERS })
  }

  // resolveActiveAssignments は同条件を多層防御で再確認しつつ server-arm を解決する。
  const assignments = resolveActiveAssignments(experiments, visitor_id, nowMs, salt)
  if (assignments.length === 0) {
    // 404 (not 403) — tenant/site 存在を隠す
    return NextResponse.json({ error: 'no_active_experiments' }, { status: 404, headers: PUBLIC_HEADERS })
  }

  const validated = AssignmentResponseSchema.parse({
    tenant_id,
    site_id,
    generated_at: new Date().toISOString(),
    assignments,
  })
  return NextResponse.json(validated, { status: 200, headers: PUBLIC_HEADERS })
}
