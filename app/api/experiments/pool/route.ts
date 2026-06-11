/**
 * POST /api/experiments/pool — 宝プロジェクト M5 (横断プール再計算、MVP on-demand)
 *
 * 認証/権限 (Codex M5 HIGH 反映):
 *   - middleware classify: 本ルートは api-tenant (JWT 必須)。公開パスには **入れない**。
 *   - role gate: owner / admin。
 *   - さらに **platform operator allowlist**: tenant の owner/admin はテナント役職にすぎず、
 *     cross-tenant corpus の再計算はプラットフォーム運営操作。`EXPERIMENTS_POOL_OPERATORS`
 *     (カンマ区切り email) に session email が含まれる場合のみ許可。env 未設定は fail-closed (503)。
 *   - 応答は **件数サマリのみ** (cross-tenant の集計値・セル内容は返さない)。pipeline 内部の
 *     cross-tenant 読み (PostgresPoolableSource) は §3.8.1 の意図的な例外 (pool-store.ts 注記)。
 *   - cron 自動化 (秘密 header + api-public 化) は follow-up。MVP は operator が手動で叩く。
 *
 * 同時実行 (Codex M5 MEDIUM): instance 内 single-flight (実行中は 409)。serverless 複数
 * instance には advisory lock が必要 — operator 手動 MVP では十分、cron 化時に PG advisory lock。
 *
 * 処理: poolable 実験 (pool_opt_in + running/stopped) → site dedupe → セルごとに arm 計測 (M3)
 *       → DL+KH (M5) → 健全性ゲート (失敗率>10% で corpus 不変 abort) → K≥24 upsert /
 *       全成功セルのみ K<24 行削除。
 */

import { NextResponse } from 'next/server'

import { queryArmStats } from '@/lib/experiments/arm-stats'
import { AssignSaltMissingError, getAssignSalt } from '@/lib/experiments/assignment'
import { recomputePoolCells } from '@/lib/experiments/pool-aggregate'
import { PostgresPoolableSource, PostgresPoolCellStore } from '@/lib/experiments/pool-store'
import { getServerSession } from '@/lib/auth/server-session'
import { normalizeRole } from '@/lib/scenarios/publish-rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// セル数 × ClickHouse 計測のため長め (Vercel Fluid: 既定 300s)。
export const maxDuration = 300

/** platform operator allowlist (fail-closed: 未設定なら誰も実行不可)。 */
function resolveOperatorEmails(): Set<string> | null {
  const raw = process.env.EXPERIMENTS_POOL_OPERATORS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const emails = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
  return emails.length > 0 ? new Set(emails) : null
}

// instance 内 single-flight (同時 POST の二重再計算防止)。
let _recomputeInFlight = false

export async function POST(): Promise<NextResponse> {
  const session = await getServerSession()
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = normalizeRole(session.user.role)
  if (role !== 'owner' && role !== 'admin') {
    return NextResponse.json(
      { error: 'forbidden', message: 'pool recompute は owner/admin のみ' },
      { status: 403 },
    )
  }

  // platform operator gate (Codex M5 HIGH: tenant RBAC だけでは cross-tenant 操作を許可しない)。
  const operators = resolveOperatorEmails()
  if (!operators) {
    // eslint-disable-next-line no-console
    console.error('[experiments/pool] EXPERIMENTS_POOL_OPERATORS not configured (fail-closed)')
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
  const email = (session.user.email ?? '').toLowerCase()
  if (!email || !operators.has(email)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'platform operator のみ実行可能' },
      { status: 403 },
    )
  }

  let salt: string
  try {
    salt = getAssignSalt()
  } catch (e) {
    if (e instanceof AssignSaltMissingError) {
      // eslint-disable-next-line no-console
      console.error('[experiments/pool] EXPERIMENT_ASSIGN_SALT not configured')
      return NextResponse.json({ error: 'unavailable' }, { status: 503 })
    }
    throw e
  }

  if (_recomputeInFlight) {
    return NextResponse.json({ error: 'conflict', message: 'recompute already running' }, { status: 409 })
  }
  _recomputeInFlight = true
  try {
    const summary = await recomputePoolCells({
      source: new PostgresPoolableSource(),
      measure: (experiment) => queryArmStats({ experiment, salt }),
      store: new PostgresPoolCellStore(),
    })
    // 件数サマリのみ返す (セル内容 / pooled 値は返さない — 開示は M4b の meets_k50 ゲート経由のみ)。
    const status = summary.aborted ? 503 : 200
    return NextResponse.json(summary, { status, headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[experiments/pool] recompute failed: ${(e as Error).message}`)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  } finally {
    _recomputeInFlight = false
  }
}
