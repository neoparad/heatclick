/**
 * Tenant management — multi-tenant isolation
 *
 * 親 SSOT §3.8.1 (3 層防御の application + DB layer)
 * Phase 1 Sprint 0 S0-03 で完成予定。
 *
 * Phase 1 ルール:
 * - 全 API route で tenant_id を JWT から抽出
 * - 全 ClickHouse query に WHERE tenant_id = {tenant_id} を必須
 * - cross-tenant アクセス試行は 403 + audit_events 記録
 */

import { getServerSession } from '@/lib/auth/server-session'

export interface TenantContext {
  tenant_id: string
  plan: 'free' | 'starter' | 'growth' | 'agency' | 'enterprise'
  site_ids: string[]
  user_id: string
  /**
   * S1-09 (Infra 続 24): email は middleware の x-user-email 注入を撤去したため optional 化。
   * email が必要な callsite は `lib/auth/server-session.ts:getUserEmail()` を使うこと。
   * PII を middleware header から退避 (sentry breadcrumb / log 漏洩経路の縮小)。
   */
  email?: string
}

/**
 * Server Component / API Route で tenant context を取得。認証されていない場合は null。
 *
 * REQ-SEC-126 (Codex T1 / §13.7): **middleware 注入ヘッダの直読みをやめ、`getServerSession()`
 * 経由で導出**する。これにより全データ route が:
 *   - JWT 署名を再検証 (header 偽装に依存しない)
 *   - Layer 2 失効照合 (session_version / membership_version / tenants.status) を通る
 *     → role 剥奪 / 退会 / テナント停止が **これらの route でも即時に効く** (db モード)
 *   - header vs JWT cross-check (server-session 内)
 * hardcode モードでは Layer 2 が no-op ({0,0}) のため、JWT 検証コストのみ増 (DB アクセス無し)。
 *
 * tenant_id / plan / user_id / site_ids は **検証済み JWT (session.user)** から取る
 * (注入ヘッダ x-plan / x-site-ids の値ではない = spoof 不可)。
 */
export async function getTenantContext(): Promise<TenantContext | null> {
  const session = await getServerSession()
  if (!session) return null

  return {
    tenant_id: session.tenant_id,
    plan: session.user.plan,
    user_id: session.user_id,
    site_ids: session.user.site_ids,
    email: session.user.email,
  }
}

/**
 * API Route で tenant context を取得、なければ 401 throw。
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const ctx = await getTenantContext()
  if (!ctx) {
    throw new Error('UNAUTHENTICATED')
  }
  return ctx
}

/**
 * tenant が指定 site_id にアクセス可能か検証。
 * 違反時は audit_events に記録 (TODO: Sprint 0 S0-09 で実装)。
 */
export function canAccessSite(ctx: TenantContext, site_id: string): boolean {
  // Enterprise / Agency は自テナント内の全 site にアクセス可
  if (['enterprise', 'agency'].includes(ctx.plan)) {
    return ctx.site_ids.includes(site_id)
  }
  // それ以外は site_ids に含まれるもののみ
  return ctx.site_ids.includes(site_id)
}

/**
 * ClickHouse query 用の tenant_id parameter binding を生成。
 * Codex Round 8 Fix 5 反映: 文字列連結を撤廃、parameterized query 必須化。
 *
 * 使い方:
 *   const { sql, params } = buildTenantQuery(ctx, `
 *     SELECT ... FROM events
 *     WHERE tenant_id = {tenant_id:String}
 *       AND site_id = {site_id:String}
 *   `, { site_id: 'site_xxx' })
 *   const result = await clickhouse.query({ query: sql, query_params: params })
 *
 * 禁止: tenantWhereClause() のような文字列連結関数。
 */
export function buildTenantQuery<T extends Record<string, unknown>>(
  ctx: TenantContext,
  sql: string,
  additionalParams: T = {} as T,
): { sql: string; params: { tenant_id: string } & T } {
  return {
    sql,
    params: {
      tenant_id: ctx.tenant_id,
      ...additionalParams,
    },
  }
}

/**
 * @deprecated Codex Round 8 Fix 5: 文字列連結による SQL 構築は禁止。
 * `buildTenantQuery()` + ClickHouse parameter binding (`{tenant_id:String}`) を使うこと。
 */
export function tenantWhereClause(_ctx: TenantContext): never {
  throw new Error(
    'tenantWhereClause is deprecated. Use buildTenantQuery() with ClickHouse parameter binding ({tenant_id:String}).',
  )
}
