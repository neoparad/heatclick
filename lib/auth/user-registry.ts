/**
 * User registry 抽象 (hardcode | db)
 *
 * 親 SSOT: docs/multi-tenant-auth-design.md §5 / §10 / §13.5
 *
 * 目的: ログイン時の「email → 所属テナント/role/site_ids/失効世代」解決を
 *   1箇所に集約し、`USER_REGISTRY` env で切替える (REQ-SEC-124)。
 *     - hardcode (既定): 既存 lib/auth/dogfood-users.ts を使用 = **現行挙動を完全保持**。
 *     - db: Supabase の tenants/tenant_sites/users/memberships を参照。
 *
 * 反映している受け入れ基準:
 *   - REQ-SEC-102: tenants.status='active' のみ採用 (suspended は所属に数えない)。
 *   - REQ-SEC-103: active tenant は**サーバ側で決定的に解決** (クライアント hint 不使用)。
 *   - REQ-SEC-101: session_version / membership_version を解決し JWT に載せ、
 *     getCurrentVersions() で Layer 2 失効照合に使う。
 *   - REQ-SEC-113: role は resolveRole() でフェイルセーフ (不明→viewer)。
 */

import { resolveRole, type Plan, type Role } from '@/lib/jwt'
import { lookupDogfoodUser } from '@/lib/auth/dogfood-users'
import { authQuery } from '@/lib/db/postgres'

export type RegistryMode = 'hardcode' | 'db'

export function getRegistryMode(): RegistryMode {
  return process.env.USER_REGISTRY === 'db' ? 'db' : 'hardcode'
}

/** ログイン成立時に JWT へ載せる確定済み principal。 */
export interface RegistryPrincipal {
  id: string
  email: string
  name: string
  tenant_id: string // active tenant (server 決定)
  plan: Plan
  site_ids: string[]
  role: Role
  session_version: number
  membership_version: number
}

/** 失効照合 (Layer 2) 用の現行世代。null = 失効済み (user/membership 消失 or tenant suspended)。 */
export interface CurrentVersions {
  session_version: number
  membership_version: number
}

// role 強い順 (REQ-SEC-103: 複数所属時の active tenant を決定的に選ぶための優先度)
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 }

/**
 * email → principal を解決。未所属/失効は null。
 */
export async function lookupUserByEmail(email: string): Promise<RegistryPrincipal | null> {
  const normalized = email.toLowerCase().trim()
  if (getRegistryMode() === 'db') {
    return lookupFromDb(normalized)
  }
  return lookupFromHardcode(normalized)
}

function lookupFromHardcode(email: string): RegistryPrincipal | null {
  const u = lookupDogfoodUser(email)
  if (!u) return null
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    tenant_id: u.tenant_id,
    plan: u.plan,
    site_ids: [...u.site_ids],
    role: resolveRole(u.role),
    // hardcode は失効機構なし → 常に 0 (Layer 2 は db モードのみ照合)
    session_version: 0,
    membership_version: 0,
  }
}

interface UserRow {
  id: string
  email: string
  name: string | null
  session_version: number
}
interface MembershipRow {
  tenant_id: string
  role: string
  membership_version: number
  plan: string
}
interface SiteRow {
  site_id: string
}

async function lookupFromDb(email: string): Promise<RegistryPrincipal | null> {
  const users = await authQuery<UserRow>(
    `SELECT id, email, name, session_version FROM users WHERE email = $1 LIMIT 1`,
    [email],
  )
  const user = users[0]
  if (!user) return null

  // active tenant のみ (REQ-SEC-102)。複数所属は role 強い順→tenant_id 昇順で決定的に選ぶ (REQ-SEC-103)。
  const memberships = await authQuery<MembershipRow>(
    `SELECT m.tenant_id, m.role, m.membership_version, t.plan
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND t.status = 'active'`,
    [user.id],
  )
  if (memberships.length === 0) return null

  const active = [...memberships].sort((a, b) => {
    const ra = ROLE_RANK[resolveRole(a.role)]
    const rb = ROLE_RANK[resolveRole(b.role)]
    if (ra !== rb) return rb - ra
    return a.tenant_id < b.tenant_id ? -1 : a.tenant_id > b.tenant_id ? 1 : 0
  })[0]

  const sites = await authQuery<SiteRow>(
    `SELECT site_id FROM tenant_sites WHERE tenant_id = $1 ORDER BY site_id`,
    [active.tenant_id],
  )

  return {
    id: user.id,
    email: user.email,
    name: user.name ?? user.email.split('@')[0],
    tenant_id: active.tenant_id,
    plan: coercePlan(active.plan),
    site_ids: sites.map((s) => s.site_id),
    role: resolveRole(active.role),
    session_version: user.session_version ?? 0,
    membership_version: active.membership_version ?? 0,
  }
}

/**
 * Layer 2 失効照合 (REQ-SEC-101/102)。getServerSession が JWT の version と比較する。
 *   - db: users.session_version + 当該 active tenant の memberships.membership_version。
 *         user/membership 消失 or tenant suspended → null (失効扱い)。
 *   - hardcode: 失効機構なし → 常に {0,0} (JWT 側も 0 のため一致)。
 */
export async function getCurrentVersions(
  userId: string,
  tenantId: string,
): Promise<CurrentVersions | null> {
  if (getRegistryMode() !== 'db') {
    return { session_version: 0, membership_version: 0 }
  }
  const rows = await authQuery<{ session_version: number; membership_version: number }>(
    `SELECT u.session_version, m.membership_version
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN tenants t ON t.id = m.tenant_id
      WHERE u.id = $1 AND m.tenant_id = $2 AND t.status = 'active'
      LIMIT 1`,
    [userId, tenantId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    session_version: row.session_version ?? 0,
    membership_version: row.membership_version ?? 0,
  }
}

const VALID_PLANS: ReadonlyArray<Plan> = ['free', 'starter', 'growth', 'agency', 'enterprise']
function coercePlan(value: unknown): Plan {
  return typeof value === 'string' && (VALID_PLANS as ReadonlyArray<string>).includes(value)
    ? (value as Plan)
    : 'free'
}
