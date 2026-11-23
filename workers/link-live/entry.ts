/**
 * UGOKI LINK v2 — Cloudflare Durable Object Runtime Entrypoint (`workers/link-live/entry.ts`)
 */

import { SiteLiveDurableObject } from './live-do';
import type { DataRegion } from '../link-wal';
import type { DurableObjectStateLike, LiveIngestEvent } from './types';

export interface LiveWorkerEnv {
  readonly STORAGE_REGION?: DataRegion;
}

export class SiteLiveDoWorker {
  private readonly inner: SiteLiveDurableObject;

  public constructor(state: DurableObjectStateLike, env: LiveWorkerEnv) {
    this.inner = new SiteLiveDurableObject({
      state,
      storageRegion: env.STORAGE_REGION ?? 'jp',
      tenantId: 'default',
      siteId: 'default',
    });
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/ingest') {
      const event = (await request.json()) as LiveIngestEvent;
      const result = this.inner.ingest(event, Date.now());
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/summary') {
      const summary = this.inner.queryLiveEnvelope({
        nowMs: Date.now(),
      });
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return new Response(JSON.stringify({ ok: false, error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
}

const worker = {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, service: 'ugokilink-live-jp' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

export default worker;
