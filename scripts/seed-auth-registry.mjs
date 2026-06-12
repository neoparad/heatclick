/**
 * Seed the auth registry (Supabase) from the dogfood user list.
 *
 * 親 SSOT: docs/multi-tenant-auth-design.md §10 (後方互換 seed) / §13.5 REQ-SEC-123/124
 *
 * - 冪等 (ON CONFLICT)。何度流しても安全。
 * - **lib/auth/dogfood-users.ts の SEED と一致させること**。DB 切替 (USER_REGISTRY=db) 後に
 *   ハードコードを撤去するまでの一時的な二重定義 (REQ-SEC-123)。
 * - DDL ではなくデータ投入 (INSERT/UPSERT)。tenant_id を必ず保持 (CLAUDE.md ルール7)。
 *
 * 実行:
 *   node scripts/seed-auth-registry.mjs
 *   (AUTH_DATABASE_URL を .env.local から読む。無ければ process.env を使用)
 */

import { readFileSync } from 'node:fs'
import pg from 'pg'

// ---- seed data (mirror of lib/auth/dogfood-users.ts) -----------------------
const LINKTH_INTERNAL_TENANT = 'linkth_internal'
const LINKTH_INTERNAL_SITE_IDS = [
  'CIP_EcwUTHEZdIOAUqum',
  'CIP_xginf3nVacnkn62o',
  'CIP_6r2WofQDSKrOwxmM',
  'CIP_8eN7xgfBtDAnzE26',
  'CIP_QWaPiks5krukJ6NM',
  'CIP_E3xzSWfXcXx6GaTL', // link-th.co.jp コーポレート (続127 provision)
]

const TENANTS = [
  { id: LINKTH_INTERNAL_TENANT, name: 'LINKTH Internal', plan: 'enterprise', status: 'active' },
]

const TENANT_SITES = LINKTH_INTERNAL_SITE_IDS.map((site_id) => ({
  tenant_id: LINKTH_INTERNAL_TENANT,
  site_id,
}))

const USERS = [
  { id: 'usr_owner_001', email: 'hiroki@linkth.com', name: 'Hiroki Yamamoto' },
  { id: 'usr_owner_002', email: 'hiroki101313@gmail.com', name: 'Hiroki' },
]

const MEMBERSHIPS = [
  { user_id: 'usr_owner_001', tenant_id: LINKTH_INTERNAL_TENANT, role: 'owner' },
  { user_id: 'usr_owner_002', tenant_id: LINKTH_INTERNAL_TENANT, role: 'owner' },
]
// ---------------------------------------------------------------------------

function bundledSupabaseCa() {
  // 単一ソース: lib/db/supabase-ca.ts に埋め込んだ公開 CA を読む (アプリと同じ)。
  try {
    const ts = readFileSync(new URL('../lib/db/supabase-ca.ts', import.meta.url), 'utf8')
    const m = ts.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
    return m ? m[0] + '\n' : null
  } catch {
    return null
  }
}

function buildSsl() {
  // REQ-SEC-130: strict TLS 既定。env CA 優先、無ければ bundled Supabase CA。
  const envCa = process.env.AUTH_DATABASE_CA_CERT
  const ca = envCa && envCa.trim().length > 0 ? envCa.replace(/\\n/g, '\n') : bundledSupabaseCa()
  if (ca) return { rejectUnauthorized: true, ca }
  return { rejectUnauthorized: false }
}

function resolveConnectionString() {
  if (process.env.AUTH_DATABASE_URL) return process.env.AUTH_DATABASE_URL
  try {
    const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    const m = envText.match(/^AUTH_DATABASE_URL=(.+)$/m)
    if (m) return m[1].trim()
  } catch {
    /* ignore */
  }
  return null
}

async function main() {
  const connectionString = resolveConnectionString()
  if (!connectionString) {
    console.error('FAIL: AUTH_DATABASE_URL not set (env or .env.local)')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString, ssl: buildSsl() })
  await client.connect()
  try {
    await client.query('BEGIN')

    for (const t of TENANTS) {
      await client.query(
        `INSERT INTO tenants (id, name, plan, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan,
                                        status = EXCLUDED.status, updated_at = now()`,
        [t.id, t.name, t.plan, t.status],
      )
    }
    for (const ts of TENANT_SITES) {
      await client.query(
        `INSERT INTO tenant_sites (tenant_id, site_id)
         VALUES ($1, $2) ON CONFLICT (tenant_id, site_id) DO NOTHING`,
        [ts.tenant_id, ts.site_id],
      )
    }
    for (const u of USERS) {
      await client.query(
        `INSERT INTO users (id, email, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [u.id, u.email, u.name],
      )
    }
    for (const m of MEMBERSHIPS) {
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
        [m.user_id, m.tenant_id, m.role],
      )
    }

    await client.query('COMMIT')

    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM tenants)      AS tenants,
         (SELECT count(*) FROM tenant_sites) AS tenant_sites,
         (SELECT count(*) FROM users)        AS users,
         (SELECT count(*) FROM memberships)  AS memberships`,
    )
    console.log('seed OK. row counts:', counts.rows[0])
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('seed FAILED:', e.message)
    process.exitCode = 1
  } finally {
    await client.end().catch(() => {})
  }
}

main()
