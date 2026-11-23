/**
 * UGOKI LINK v2 — Cloudflare Workers Runtime Entrypoint (`workers/link-wal/entry.ts`)
 */

import { WalWriter, handleWalQueueBatch } from './wal-writer';
import type { DataRegion, QueueBatchLike, R2BucketLike, WalQueuePayload } from './types';

export interface WalWorkerEnv {
  readonly STORAGE_REGION?: DataRegion;
  readonly QUARANTINE_ENCRYPTION_MASTER_KEY?: string;
  readonly R2_WAL: R2BucketLike;
  readonly R2_QUARANTINE: R2BucketLike;
}

const worker = {
  async queue(batch: QueueBatchLike<WalQueuePayload>, env: WalWorkerEnv): Promise<void> {
    const region: DataRegion = env.STORAGE_REGION ?? 'jp';
    const writer = new WalWriter({
      region,
      bucket: env.R2_WAL,
      quarantineMasterKeyHex: env.QUARANTINE_ENCRYPTION_MASTER_KEY,
    });
    await handleWalQueueBatch(batch, writer);
  },
};

export default worker;
