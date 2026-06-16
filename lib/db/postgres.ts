/**
 * Auth registry Postgres connection (Supabase)
 *
 * 親 SSOT: docs/multi-tenant-auth-design.md §3 / §3.1 / §13.5
 *
 * 設計:
 *   - **認証専用 DB**。`AUTH_DATABASE_URL` (Supabase Shared Pooler / Transaction mode :6543)。
 *     既存の `DATABASE_URL` (linkscrawl Hetzner PG) とは別インスタンス・別変数 (衝突回避)。
 *   - node runtime 限定 (`pg` は TCP socket = edge/middleware では動かない)。
 *     middleware は本 module を import しない (REQ-SEC-101 の失効照合は getServerSession 側 Layer 2)。
 *   - **fail-closed** (REQ-SEC-125): `AUTH_DATABASE_URL` 未設定で getAuthDb() を呼ぶと throw。
 *     呼び出し側は USER_REGISTRY=db のときのみ呼ぶため、hardcode 既定では到達しない。
 *   - Transaction-mode pooler 互換: named prepared statement を使わない
 *     (plain parameterized query のみ = `pg` の unnamed extended protocol、pooler 安全)。
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg'

import { SUPABASE_ROOT_2021_CA } from '@/lib/db/supabase-ca'

let _pool: Pool | null = null

/**
 * TLS 設定 (REQ-SEC-130)。既定で **strict 検証** (rejectUnauthorized:true + CA pin) = MITM 防御。
 *   1. `AUTH_DATABASE_CA_CERT` 提供時: その CA で strict (別 DB / CA ローテーション用の上書き)。
 *   2. 未提供時: **bundled Supabase Root 2021 CA** で strict (Supabase pooler の既定経路、env 不要)。
 * いずれも `rejectUnauthorized: true`。検証なし接続は既定では行わない。
 */
function buildAuthDbSsl(): { rejectUnauthorized: boolean; ca: string } {
  const envCa = process.env.AUTH_DATABASE_CA_CERT
  const ca = envCa && envCa.trim().length > 0 ? envCa.replace(/\\n/g, '\n') : SUPABASE_ROOT_2021_CA
  return { rejectUnauthorized: true, ca }
}

export function isAuthDbConfigured(): boolean {
  return typeof process.env.AUTH_DATABASE_URL === 'string' && process.env.AUTH_DATABASE_URL.length > 0
}

export function getAuthDb(): Pool {
  if (_pool) return _pool

  const connectionString = process.env.AUTH_DATABASE_URL
  if (!connectionString) {
    // fail-closed: 認証 DB 未設定で DB 経路を踏んだら明示エラー (silent fallback しない)
    throw new Error('AUTH_DATABASE_URL is not configured (auth registry DB unavailable)')
  }

  _pool = new Pool({
    connectionString,
    ssl: buildAuthDbSsl(),
    // サーバーレス/Fluid。pooler 配下なので app 側 pool は小さく。
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })

  // pool レベルの予期せぬエラーでプロセスを落とさない (idle client error 等)
  _pool.on('error', (err) => {
    console.error('[auth-db] idle client error:', err.message)
  })

  return _pool
}

/**
 * パラメータ化クエリの薄いラッパ。transaction-mode pooler 安全 (unnamed statement)。
 */
export async function authQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const result = await getAuthDb().query<T>(text, values as unknown[] | undefined)
  return result.rows
}

/**
 * 単一接続でのトランザクション実行 (seed / 招待受諾など atomic 操作用)。
 */
export async function withAuthTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAuthDb().connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
