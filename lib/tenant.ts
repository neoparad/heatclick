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

import { headers } from 'next/headers'

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
 * Server Component / API Route で tenant context を取得。
 * middleware が x-tenant-id / x-plan / x-user-id / x-site-ids ヘッダーを注入している前提。
 * 認証されていない場合は null を返す。
 *
 * S1-09 変更: x-user-email 依存を撤廃。tenant_id / plan / user_id / site_ids のみで判定。
 * email を取得したい callsite は `getServerSession()` / `getUserEmail()` 使用。
 */
export async function getTenantContext(): Promise<TenantContext | null> {
  const h = await headers()
  const tenant_id = h.get('x-tenant-id')
  const plan = h.get('x-plan') as TenantContext['plan'] | null
  const user_id = h.get('x-user-id')
  const site_ids_raw = h.get('x-site-ids')

  if (!tenant_id || !plan || !user_id) {
    return null
  }

  return {
    tenant_id,
    plan,
    user_id,
    site_ids: site_ids_raw ? site_ids_raw.split(',') : [],
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
