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

const SEED: DogfoodUser[] = [
  {
    id: 'usr_owner_001',
    email: 'hiroki@linkth.com',
    name: 'Hiroki Yamamoto',
    tenant_id: 'tnt_linkth',
    plan: 'enterprise',
    site_ids: ['site_linkth_main', 'site_bihada_demo'],
    role: 'owner',
  },
  {
    id: 'usr_owner_002',
    email: 'hiroki101313@gmail.com',
    name: 'Hiroki',
    tenant_id: 'tnt_linkth',
    plan: 'enterprise',
    site_ids: ['site_linkth_main', 'site_bihada_demo'],
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
          plan: (typeof u.plan === 'string' ? u.plan : 'starter') as Plan,
          site_ids: Array.isArray(u.site_ids) ? u.site_ids.filter((s: unknown) => typeof s === 'string') : [],
          role: (['owner', 'admin', 'member', 'viewer'].includes(u.role) ? u.role : 'owner') as DogfoodUser['role'],
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
    for (const u of [...SEED, ...loadEnvUsers()]) {
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
