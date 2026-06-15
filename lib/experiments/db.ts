/**
 * 宝プロジェクト — 標準実験 registry Postgres 接続 (Supabase 相乗り)
 *
 * 設計 (Owner 2026-06-10 決定 = 既存 auth Supabase に相乗り):
 *   - 接続先は `EXPERIMENTS_DATABASE_URL` 優先、未設定時は `AUTH_DATABASE_URL` にフォールバック。
 *     → MVP は auth と同一 Supabase。将来 env を分けるだけで別インスタンスへ分離可 (コード変更不要)。
 *   - node runtime 限定 (`pg` は TCP socket = edge/middleware では動かない)。
 *   - TLS strict (rejectUnauthorized:true + Supabase Root 2021 CA pin)。lib/db/postgres.ts と同方針。
 *   - fail-closed: 接続文字列未設定で getExperimentsDb() を呼ぶと throw (silent fallback しない)。
 *   - transaction-mode pooler 互換: unnamed parameterized query のみ。
 */

import { Pool, type QueryResultRow } from 'pg'

import { SUPABASE_ROOT_2021_CA } from '@/lib/db/supabase-ca'

let _pool: Pool | null = null

function resolveConnectionString(): string | undefined {
  const own = process.env.EXPERIMENTS_DATABASE_URL
  if (typeof own === 'string' && own.length > 0) return own
  const auth = process.env.AUTH_DATABASE_URL
  if (typeof auth === 'string' && auth.length > 0) return auth
  return undefined
}

function buildSsl(): { rejectUnauthorized: boolean; ca: string } {
  const envCa = process.env.EXPERIMENTS_DATABASE_CA_CERT || process.env.AUTH_DATABASE_CA_CERT
  const ca = envCa && envCa.trim().length > 0 ? envCa.replace(/\\n/g, '\n') : SUPABASE_ROOT_2021_CA
  return { rejectUnauthorized: true, ca }
}

export function isExperimentsDbConfigured(): boolean {
  return resolveConnectionString() !== undefined
}

export function getExperimentsDb(): Pool {
  if (_pool) return _pool

  const connectionString = resolveConnectionString()
  if (!connectionString) {
    throw new Error(
      'experiments registry DB unavailable: set EXPERIMENTS_DATABASE_URL (or AUTH_DATABASE_URL for Supabase 相乗り)',
    )
  }

  _pool = new Pool({
    connectionString,
    ssl: buildSsl(),
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })
  _pool.on('error', (err) => {
    console.error('[experiments-db] idle client error:', err.message)
  })
  return _pool
}

/** パラメータ化クエリの薄いラッパ (transaction-mode pooler 安全 = unnamed statement)。 */
export async function experimentsQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const result = await getExperimentsDb().query<T>(text, values as unknown[] | undefined)
  return result.rows
}
