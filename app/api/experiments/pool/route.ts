/**
 * /api/experiments/pool — 宝プロジェクト M5 (横断プール再計算)
 *
 * 2 つの起動経路 (残タスク④ cron 化):
 *   - GET  : **Vercel Cron** (vercel.json crons、毎日 03:00 JST)。認証は既存 cron 様式を踏襲 —
 *            `x-vercel-cron: 1` (Vercel が外部からの x-vercel-* header を strip する前提) または
 *            `x-cron-secret` === CRON_SECRET (手動 invoke 用)。どちらも無ければ 401。
 *   - POST : platform operator の手動実行。JWT session (route 内 getServerSession、middleware
 *            非依存) + role owner/admin + **EXPERIMENTS_POOL_OPERATORS allowlist** (fail-closed)。
 *
 * middleware: 本ルートは API_PUBLIC_PATHS (api-public)。Vercel cron は JWT を持たないため
 * middleware の JWT gate を通せない — 認証は本 route 内で行う (inngest / billing/webhook と
 * 同パターン)。POST の session 認証は getServerSession が cookie から直接検証するため
 * api-public 化の影響を受けない。
 *
 * 認可後の処理・防御 (M5 で Codex dual review 済):
 *   - 応答は **件数サマリのみ** (cross-tenant の集計値・セル内容は返さない)。
 *   - cross-tenant 読み (PostgresPoolableSource) は §3.8.1 の意図的な例外 (pool-store.ts 注記)。
 *   - 健全性ゲート: 計測失敗率 >10% で corpus 不変 abort (503)。
 *   - instance 内 single-flight (409)。cron は日次なので衝突は実質なし。PG advisory lock は
 *     transaction-mode pooler (Supabase 6543) で session lock が保証されないため不採用 —
 *     仮に二重実行しても upsert は冪等で corpus は同値に収束する。
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

/**
 * 既存 cron 様式 (app/api/cron/daily-site-summary 踏襲) + Vercel runtime guard (Codex LOW):
 * `x-vercel-cron` は Vercel が外部からの x-vercel-* header を strip する前提の信頼だが、
 * 非 Vercel 環境 (local dev / proxy 誤設定) ではその保証がないため、**VERCEL === '1' の
 * runtime でのみ** 信頼する。それ以外は CRON_SECRET 必須。
 */
function isCronAuthorized(request: Request): boolean {
  if (process.env.VERCEL === '1' && request.headers.get('x-vercel-cron') === '1') return true
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('x-cron-secret') === secret) return true
  return false
}

// instance 内 single-flight (同時実行の二重再計算防止)。
let _recomputeInFlight = false

/** 認可済み呼出しから共通で使う再計算本体。 */
async function runRecompute(): Promise<NextResponse> {
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

/** Vercel Cron 起動 (毎日)。認証は cron header / secret のみ (JWT なし)。 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return runRecompute()
}

/** platform operator の手動実行 (JWT + role + allowlist)。 */
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

  return runRecompute()
}
