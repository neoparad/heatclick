/**
 * ClickHouse client — UGOKI MAP SaaS 共通接続層
 *
 * 親 SSOT §3.6.5 / §3.8.1 multi-tenant isolation / Infra 続 56 (S3-W1 ヒートマップ本接続)
 *
 * 使い方:
 *   import { getClickHouseClient } from '@/lib/clickhouse'
 *   import { buildTenantQuery } from '@/lib/tenant'
 *
 *   const ch = getClickHouseClient()
 *   const { sql, params } = buildTenantQuery(ctx, `
 *     SELECT ... FROM events
 *     WHERE tenant_id = {tenant_id:String}
 *       AND site_id = {site_id:String}
 *   `, { site_id })
 *   const result = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' })
 *   const rows = await result.json<RowShape>()
 *
 * tenant_id WHERE は呼出側で `buildTenantQuery` 経由で必ず注入する (§3.8.1)。
 * 本 module は接続生成のみで、認可検証は middleware + tenant.ts に任せる。
 *
 * env:
 *   CLICKHOUSE_URL      — Hetzner ClickHouse base URL (例: https://ch.internal.linkth.example:8443)
 *                         credentials を URL に埋めず username/password で渡す。
 *   CLICKHOUSE_USERNAME — default は 'default'
 *   CLICKHOUSE_PASSWORD — 必須
 *   CLICKHOUSE_DB       — default は 'clickinsight'
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * ClickHouse user role (Infra 続 67 D-3 配備済):
 *   - 'default'           : Infra 続 56 既存、書き込み権限あり (rate-limit 等の汎用)
 *   - 'analytics_reader'  : RO 専用、SELECT のみ (chat orchestrator の集計 query)
 *   - 'chat_writer'       : INSERT-only (chat_conversations / llm_audit_ledger 書き込み専用)
 *
 * 各 role の env:
 *   - default            → CLICKHOUSE_USERNAME / CLICKHOUSE_PASSWORD (Infra 続 56 既存)
 *   - analytics_reader   → CLICKHOUSE_RO_USERNAME (default 'analytics_reader') / CLICKHOUSE_RO_PASSWORD
 *   - chat_writer        → CLICKHOUSE_WRITER_USERNAME (default 'chat_writer') / CLICKHOUSE_WRITER_PASSWORD
 *
 * 未設定時の挙動:
 *   - production (NODE_ENV=production) で role 専用 password 不在 → **throw** (続 70 fail-fast 強化)
 *     Infra 続 67 D-3 配備完了済前提のため、production では role 分離必須
 *   - non-production (dev / test) で role 専用 password 不在 → default credentials に warn fallback
 *     (ローカル開発 + CI で 3 role 全 env 投入を要求しない pragmatic 配慮)
 */
export type ClickHouseRole = 'default' | 'analytics_reader' | 'chat_writer'

const _clients: Partial<Record<ClickHouseRole, ClickHouseClient>> = {}

/**
 * Production で role 専用 password が不在の場合は **throw** (続 70 fail-fast 強化、続 67 D-3 配備済前提)。
 * non-production では default fallback 許容。
 *
 * `assertLLMRuntimeConfig()` (lib/llm/gateway.ts) と同じ production-only fail-fast 思想 (続 64 §2a)。
 * Error message に password / username 値を含めない (env 名のみ、Sentry 流出経路ゼロ)。
 */
function requireRoleCredentialOrThrow(envName: string, role: ClickHouseRole): never {
  throw new Error(
    `[clickhouse] ${envName} is required in production for role='${role}' ` +
      `(Infra 続 67 D-3 配備済前提、続 70 fail-fast 強化)。Vercel env で投入してください。`,
  )
}

function resolveCredentials(role: ClickHouseRole): { username: string; password: string } {
  const defaultUser = process.env.CLICKHOUSE_USERNAME ?? 'default'
  const defaultPwd = process.env.CLICKHOUSE_PASSWORD ?? ''
  const isProd = process.env.NODE_ENV === 'production'

  switch (role) {
    case 'analytics_reader': {
      const user = process.env.CLICKHOUSE_RO_USERNAME ?? 'analytics_reader'
      const pwd = process.env.CLICKHOUSE_RO_PASSWORD
      if (!pwd) {
        if (isProd) {
          requireRoleCredentialOrThrow('CLICKHOUSE_RO_PASSWORD', 'analytics_reader')
        }
        // dev / test: warn fallback (続 70 で production のみ強化)
        console.warn(
          '[clickhouse] CLICKHOUSE_RO_PASSWORD unset (dev/test fallback to default credentials、production では fail-fast)',
        )
        return { username: defaultUser, password: defaultPwd }
      }
      return { username: user, password: pwd }
    }
    case 'chat_writer': {
      const user = process.env.CLICKHOUSE_WRITER_USERNAME ?? 'chat_writer'
      const pwd = process.env.CLICKHOUSE_WRITER_PASSWORD
      if (!pwd) {
        if (isProd) {
          requireRoleCredentialOrThrow('CLICKHOUSE_WRITER_PASSWORD', 'chat_writer')
        }
        console.warn(
          '[clickhouse] CLICKHOUSE_WRITER_PASSWORD unset (dev/test fallback to default credentials、production では fail-fast)',
        )
        return { username: defaultUser, password: defaultPwd }
      }
      return { username: user, password: pwd }
    }
    case 'default':
    default:
      return { username: defaultUser, password: defaultPwd }
  }
}

export function getClickHouseClient(role: ClickHouseRole = 'default'): ClickHouseClient {
  const cached = _clients[role]
  if (cached) return cached

  const url = process.env.CLICKHOUSE_URL
  if (!url) throw new Error('CLICKHOUSE_URL is required')

  const { username, password } = resolveCredentials(role)
  if (!password) throw new Error(`CLICKHOUSE_PASSWORD is required for role='${role}'`)

  const client = createClient({
    url,
    username,
    password,
    database: process.env.CLICKHOUSE_DB ?? 'clickinsight',
    request_timeout: role === 'analytics_reader' ? 30_000 : 10_000, // 分析 query は長め
    compression: { response: true, request: false },
    clickhouse_settings: {
      log_queries: 1,
      // analytics_reader は max_execution_time で安全網 (続 68 §M-2 Hybrid query)
      ...(role === 'analytics_reader' ? { max_execution_time: 30 } : {}),
    },
  })
  _clients[role] = client
  return client
}

/**
 * Test / hot-reload 用。プロセス内で全 role の client を捨てて再生成させる。
 */
export function resetClickHouseClient(): void {
  for (const role of Object.keys(_clients) as ClickHouseRole[]) {
    delete _clients[role]
  }
}
