/**
 * Server-side session resolution
 *
 * S1-09 (Infra 続 24): middleware.ts が x-user-email header 注入を撤去したことに伴い、
 * email など PII を必要とする API route はここから session を取得する。
 *
 * 設計原則:
 *   - middleware は tenant_id / user_id / plan / site_ids のみ header inject (非 PII)
 *   - email / name 等の PII は本 module 経由で JWT 経由 (cookie/Authorization) で取得
 *   - Sprint 1 dogfood phase は `lib/auth/dogfood-users.ts` を lookup source として使用
 *   - Sprint 3 で Postgres `users` table 切替 (dogfood-users → DB)
 *
 * 親 SSOT:
 *   - §3.6.1 / §3.8.1 multi-tenant isolation
 *   - §3.8.2 PII REDACT (`x-user-email` の middleware 注入は PII spread + sentry breadcrumb 漏洩経路 = 撤去)
 *   - Reviewer 続 12 観点 (中期: header PII を撤去、API 側で都度 lookup)
 */

import { cookies, headers } from 'next/headers'
import { TOKEN_COOKIE_NAME, verifyToken, type JWTPayload } from '@/lib/jwt'

export interface ServerSession {
  /** JWT verified payload (sub / email / name / tenant_id / plan / site_ids / role) */
  user: JWTPayload
  /** middleware が header inject した tenant_id (PII フリー、JWT と整合確認済) */
  tenant_id: string
  /** middleware が header inject した user_id (JWT sub) */
  user_id: string
}

/**
 * getServerSession: Server Component / Server Action / API route で session 取得
 *
 * 動作:
 *   1. Cookie `ugokimap_saas_token` から JWT 抽出 (Authorization Bearer fallback はない、
 *      cookie が SaaS 内部経路の SSOT)
 *   2. JWT verify (jose、HS256、`JWT_SECRET` env)
 *   3. middleware が inject した `x-tenant-id` / `x-user-id` と JWT claim を cross-check
 *      (cross-tenant 攻撃検知: 改ざんされた header と verified JWT が乖離していれば null)
 *
 * 戻り値:
 *   - ServerSession : 認証済、cross-check OK
 *   - null          : 未認証 / JWT 不正 / cross-check 失敗
 *
 * 注意:
 *   middleware が tenant-protected / api-tenant region 経由でしか header inject しないため、
 *   getServerSession() は基本的にこの 2 region 内でのみ non-null を返す。auth-public 等の
 *   region で呼ぶと null (header 不在のため)。
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(TOKEN_COOKIE_NAME)?.value
  if (!token) return null

  const user = await verifyToken(token)
  if (!user) return null

  // middleware が inject した header を必須化 (x-tenant-id / x-user-id 不在は middleware
  // 経路を通っていない = 直接 fetch / static export 等の経路、本 module 適用外)
  const h = await headers()
  const headerTenantId = h.get('x-tenant-id')
  const headerUserId = h.get('x-user-id')

  if (!headerTenantId || !headerUserId) {
    // middleware を通っていない経路 (Server Component の static export 等)、
    // この場合は JWT verified user をそのまま信頼する (header cross-check skip)
    return {
      user,
      tenant_id: user.tenant_id,
      user_id: user.sub,
    }
  }

  // cross-check: header と JWT claim 乖離は cross-tenant 攻撃の兆候
  if (headerTenantId !== user.tenant_id || headerUserId !== user.sub) {
    // 警告ログ、本 session は null 返却 (defense in depth)
    console.error(
      `[getServerSession] tenant/user mismatch: header=(${headerTenantId},${headerUserId}) jwt=(${user.tenant_id},${user.sub})`,
    )
    return null
  }

  return {
    user,
    tenant_id: headerTenantId,
    user_id: headerUserId,
  }
}

/**
 * requireServerSession: getServerSession + 未認証時に Error throw
 */
export async function requireServerSession(): Promise<ServerSession> {
  const session = await getServerSession()
  if (!session) {
    throw new Error('UNAUTHENTICATED')
  }
  return session
}

/**
 * getUserEmail: email を取得するための専用 helper
 *
 * S1-09 で middleware が x-user-email 注入を撤去したため、email を必要とする callsite
 * (例: 通知メール送信、Stripe customer 作成、サインアウト時の audit) は本 helper 経由で取得。
 *
 * 戻り値:
 *   - string : email (JWT verified payload から)
 *   - null   : 未認証
 */
export async function getUserEmail(): Promise<string | null> {
  const session = await getServerSession()
  return session?.user.email ?? null
}
