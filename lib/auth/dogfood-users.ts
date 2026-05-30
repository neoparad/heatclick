/**
 * Sprint 1 dogfood ユーザー seed
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1
 *
 * Sprint 3 で Postgres `users` テーブルに移行予定。Sprint 1 は
 * 招待制 dogfood (5-10 名想定) のため、ハードコード seed で十分。
 *
 * 追加方法: `DOGFOOD_USERS` 配列に新規 user を追加 (env から読む形式は
 * Sprint 2 で導入予定。それまでは PR で seed を増やす)。
 */

import type { Plan } from '../jwt'

export interface DogfoodUser {
  id: string
  email: string
  name: string
  tenant_id: string
  plan: Plan
  site_ids: string[]
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

const VALID_PLANS: ReadonlyArray<Plan> = ['free', 'starter', 'growth', 'agency', 'enterprise']
const VALID_ROLES: ReadonlyArray<DogfoodUser['role']> = ['owner', 'admin', 'member', 'viewer']

function coercePlan(value: unknown): Plan {
  // env の不正値で誤って上位 plan を与えない。既定は最小権限の 'free'。
  return typeof value === 'string' && (VALID_PLANS as ReadonlyArray<string>).includes(value)
    ? (value as Plan)
    : 'free'
}

function coerceRole(value: unknown): DogfoodUser['role'] {
  // env の不正・未指定で誤って owner を与えない。既定は最小権限の 'viewer'。
  return typeof value === 'string' && (VALID_ROLES as ReadonlyArray<string>).includes(value)
    ? (value as DogfoodUser['role'])
    : 'viewer'
}

/**
 * 続 72 (B-2 fix): 実 ClickHouse sites table の tracking_id (CIP_xxxx) と整合。
 *
 * 旧 (続 14 配備〜続 71): tenant_id='tnt_linkth' + site_ids=['site_linkth_main',
 *   'site_bihada_demo'] = scaffold 時の placeholder。実 ClickHouse には
 *   存在しない site_id のため canAccessSite() が全て false 判定 → AIチャット
 *   `[TENANT_FORBIDDEN] site not in tenant` で動作不能 (Owner 2026-05-23 22:50 報告)。
 *
 * 新: 続 39 で確定済の Phase 1 dogfood 5 sites (CIP_xxxx) + tenant_id='linkth_internal'
 *   (Owner 全 sites を内部 dogfood として運用、続 25 §4952 参照)
 */
const LINKTH_INTERNAL_TENANT = 'linkth_internal'
const LINKTH_INTERNAL_SITE_IDS: ReadonlyArray<string> = [
  'CIP_EcwUTHEZdIOAUqum', // bihadashop.jp (続 56 heatmap 既定)
  'CIP_xginf3nVacnkn62o',
  'CIP_6r2WofQDSKrOwxmM',
  'CIP_8eN7xgfBtDAnzE26',
  'CIP_QWaPiks5krukJ6NM',
]

const SEED: DogfoodUser[] = [
  {
    id: 'usr_owner_001',
    email: 'hiroki@linkth.com',
    name: 'Hiroki Yamamoto',
    tenant_id: LINKTH_INTERNAL_TENANT,
    plan: 'enterprise',
    site_ids: [...LINKTH_INTERNAL_SITE_IDS],
    role: 'owner',
  },
  {
    id: 'usr_owner_002',
    email: 'hiroki101313@gmail.com',
    name: 'Hiroki',
    tenant_id: LINKTH_INTERNAL_TENANT,
    plan: 'enterprise',
    site_ids: [...LINKTH_INTERNAL_SITE_IDS],
    role: 'owner',
  },
]

/**
 * Env override 用 (Sprint 1 中盤で導入予定の DOGFOOD_USERS env から JSON で読む)
 *
 * 形式: `DOGFOOD_USERS=[{"email":"...","name":"...","tenant_id":"...","plan":"..."}]`
 */
function loadEnvUsers(): DogfoodUser[] {
  const raw = process.env.DOGFOOD_USERS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((u, idx): DogfoodUser | null => {
        if (
          typeof u !== 'object' ||
          u == null ||
          typeof u.email !== 'string' ||
          typeof u.tenant_id !== 'string'
        ) {
          return null
        }
        return {
          id: typeof u.id === 'string' ? u.id : `usr_env_${idx.toString().padStart(3, '0')}`,
          email: u.email,
          name: typeof u.name === 'string' ? u.name : u.email.split('@')[0],
          tenant_id: u.tenant_id,
          plan: coercePlan(u.plan),
          site_ids: Array.isArray(u.site_ids) ? u.site_ids.filter((s: unknown) => typeof s === 'string') : [],
          role: coerceRole(u.role),
        }
      })
      .filter((u): u is DogfoodUser => u !== null)
  } catch {
    return []
  }
}

let _cache: Map<string, DogfoodUser> | null = null
function getMap(): Map<string, DogfoodUser> {
  if (!_cache) {
    _cache = new Map()
    // env を先に入れ、SEED を後勝ちにする。env (DOGFOOD_USERS) が seed 済みの
    // owner identity (tenant_id/role/plan) を上書きして乗っ取るのを防ぐ
    // (review 続 119 HIGH: env は deploy 権限者しか変えられないが多層防御)。
    for (const u of loadEnvUsers()) {
      _cache.set(u.email.toLowerCase(), u)
    }
    for (const u of SEED) {
      _cache.set(u.email.toLowerCase(), u)
    }
  }
  return _cache
}

export function lookupDogfoodUser(email: string): DogfoodUser | null {
  return getMap().get(email.toLowerCase()) ?? null
}

/** test 用 — production では呼ばれない */
export function resetDogfoodCache(): void {
  _cache = null
}
