/**
 * UGOKI LINK v2 — Cloudflare Workers Scheduled Loader Entrypoint (`workers/link-loader/entry.ts`)
 *
 * Reads pending R2 WAL slices per shard, merges them via the commutative/idempotent
 * `ShardLoader` state machine, and flushes committed `frame_log` & `pv_state` rows
 * into ClickHouse (`ugoki_link_v2` under Option B, switchable to dedicated 8 GiB node via env).
 */

import { ShardLoader } from './loader';
import type { DataRegion, R2BucketLike } from '../link-wal';

export interface LoaderWorkerEnv {
  readonly STORAGE_REGION?: DataRegion;
  readonly CLICKHOUSE_DB?: string;
  readonly SHARD_COUNT?: string;
  readonly CLICKHOUSE_URL: string;
  readonly CLICKHOUSE_USERNAME?: string;
  readonly CLICKHOUSE_PASSWORD?: string;
  readonly R2_WAL: R2BucketLike;
}

async function insertJsonEachRow(params: {
  readonly clickhouseUrl: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
}): Promise<void> {
  if (params.rows.length === 0) return;
  const base = params.clickhouseUrl.replace(/\/+$/, '');
  const query = encodeURIComponent(
    `INSERT INTO ${params.database}.${params.table} FORMAT JSONEachRow`
  );
  const url = `${base}/?query=${query}`;
  const body = params.rows.map((r) => JSON.stringify(r)).join('\n');
  const headers: Record<string, string> = {
    'content-type': 'application/x-ndjson',
  };
  if (params.username || params.password) {
    headers['X-ClickHouse-User'] = params.username;
    headers['X-ClickHouse-Key'] = params.password;
  }
  const resp = await fetch(url, { method: 'POST', headers, body });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 256);
    throw new Error(`ClickHouse INSERT ${params.table} failed (${resp.status}): ${text}`);
  }
}

export async function runScheduledLoaderTick(env: LoaderWorkerEnv, nowMs = Date.now()): Promise<{
  readonly shardsProcessed: number;
  readonly pvsPlaced: number;
}> {
  const region: DataRegion = env.STORAGE_REGION ?? 'jp';
  const database = env.CLICKHOUSE_DB ?? 'ugoki_link_v2';
  const shardCount = Math.max(1, Math.min(64, Number(env.SHARD_COUNT ?? '64') || 64));
  let shardsProcessed = 0;
  let pvsPlaced = 0;

  for (let shardId = 0; shardId < shardCount; shardId++) {
    const loader = new ShardLoader({
      region,
      shardId,
      bucket: env.R2_WAL,
    });
    const res = await loader.loadPendingWalObjects(nowMs);
    if (!res.committed || res.walKeysLoaded.length === 0) continue;

    shardsProcessed += 1;
    pvsPlaced += res.newlyPlacedPvs;

    if (env.CLICKHOUSE_URL) {
      const pvRows = loader.getAllPvStates().map((pv) => ({
        tenant_id: pv.placement.tenantId,
        site_id: pv.placement.siteId,
        pv_id: pv.placement.pvId,
        url_id: pv.placement.urlId,
        key_ver: pv.placement.keyVer,
        first_seen_ms: pv.placement.pvStartSrvMs,
        exp_week: pv.placement.expWeek,
        scroll_max_px: pv.scrollMaxPx,
        vis_ms: pv.visMs,
        seq_max: pv.maxSeq,
        updated_at: new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19),
      }));
      await insertJsonEachRow({
        clickhouseUrl: env.CLICKHOUSE_URL,
        database,
        username: env.CLICKHOUSE_USERNAME ?? 'default',
        password: env.CLICKHOUSE_PASSWORD ?? '',
        table: 'pv_state',
        rows: pvRows,
      });
    }
  }

  return { shardsProcessed, pvsPlaced };
}

const worker = {
  async scheduled(_controller: unknown, env: LoaderWorkerEnv): Promise<void> {
    await runScheduledLoaderTick(env);
  },
};

export default worker;
