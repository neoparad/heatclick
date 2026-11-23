/**
 * UGOKI LINK v2 — Cloudflare Workers Runtime Entrypoint (`workers/link-collector/entry.ts`)
 *
 * Uses minimal Web-standard interfaces (zero `@cloudflare/workers-types` dependency)
 * so root `npx tsc --noEmit` stays 100% clean.
 */

import { createCollectorWorker } from './worker';
import type {
  CustomEventPersistedRecord,
  PersistedCollectorRecord,
  QueueLike,
  R2BucketLike,
  SiteKeyRegistration,
  SubjectDeletionRequest,
} from './types';

export interface CollectorWorkerEnv {
  readonly STORAGE_REGION?: string;
  readonly SITE_KEYS_JSON: string;
  readonly CONTINUITY_TOKEN_SECRET: string;
  readonly LAB_MARKER_SECRET: string;
  readonly ROTATED_CONTINUITY_SECRETS_JSON?: string;
  readonly MAIN_QUEUE: QueueLike<PersistedCollectorRecord>;
  readonly CUSTOM_EVENT_QUEUE: QueueLike<CustomEventPersistedRecord>;
  readonly DELETION_QUEUE?: QueueLike<SubjectDeletionRequest>;
  readonly R2_SPILL: R2BucketLike;
  readonly R2_HOLD: R2BucketLike;
  readonly R2_QUARANTINE: R2BucketLike;
}

function parseSitesMap(rawJson: string): Map<string, SiteKeyRegistration> {
  const parsed = JSON.parse(rawJson) as SiteKeyRegistration[];
  const map = new Map<string, SiteKeyRegistration>();
  for (const site of parsed) {
    if (site && typeof site.publishableKey === 'string' && site.publishableKey.length > 0) {
      map.set(site.publishableKey, site);
    }
  }
  return map;
}

export function buildCollectorFetchHandler(env: CollectorWorkerEnv) {
  const sitesByPublishableKey = parseSitesMap(env.SITE_KEYS_JSON);
  const rotatedSecrets = env.ROTATED_CONTINUITY_SECRETS_JSON
    ? (JSON.parse(env.ROTATED_CONTINUITY_SECRETS_JSON) as string[])
    : [];

  return createCollectorWorker({
    sitesByPublishableKey,
    continuityTokenSecret: env.CONTINUITY_TOKEN_SECRET,
    rotatedContinuityTokenSecrets: rotatedSecrets,
    labMarkerSecret: env.LAB_MARKER_SECRET,
    mainQueue: env.MAIN_QUEUE,
    customEventQueue: env.CUSTOM_EVENT_QUEUE,
    r2SpillBucket: env.R2_SPILL,
    r2HoldBucket: env.R2_HOLD,
    r2QuarantineBucket: env.R2_QUARANTINE,
    deletionSink: env.DELETION_QUEUE
      ? {
          enqueueSubjectDeletion: async (req) => {
            await env.DELETION_QUEUE!.send(req);
            return { receiptId: req.receiptId };
          },
        }
      : undefined,
  });
}

const worker = {
  async fetch(request: Request, env: CollectorWorkerEnv): Promise<Response> {
    if (!env.SITE_KEYS_JSON || !env.CONTINUITY_TOKEN_SECRET || !env.LAB_MARKER_SECRET) {
      return new Response(
        JSON.stringify({ ok: false, error: 'collector_env_unconfigured' }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      );
    }
    const handler = buildCollectorFetchHandler(env);
    return handler.fetch(request);
  },
};

export default worker;
