/**
 * Standard Fetch-API Worker handler for `workers/link-signer`.
 * Serves offline-manifest verification, online bundle signing/verification,
 * and data-only loader responses (`GET /l/:siteRef.json`, §4.2 / D-23).
 */

import {
  SignerPolicyError,
  signConfigBundle,
  verifyConfigBundle,
  verifyReleaseManifest,
} from './signer';
import type {
  ConfigBundlePayload,
  LoaderDataPayload,
  SignedConfigBundle,
  SignedReleaseManifest,
} from './types';

export interface SignerWorkerDeps {
  readonly offlinePublicKey: CryptoKey;
  readonly onlinePrivateKey: CryptoKey;
  readonly onlineKid: string;
  readonly getReleaseManifest: () => Promise<SignedReleaseManifest>;
  readonly getLoaderData: (siteRef: string, pathKeyHash: string | null) => Promise<LoaderDataPayload | null>;
  readonly nowMs?: () => number;
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(extraHeaders ?? {}),
    },
  });
}

export function createSignerWorkerHandler(deps: SignerWorkerDeps) {
  const now = deps.nowMs ?? (() => Date.now());

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      // Data-only loader endpoint: GET /l/{siteRef}.json (§4.2 / D-23)
      if (request.method === 'GET' && path.startsWith('/l/') && path.endsWith('.json')) {
        const siteRef = path.slice(3, -5);
        const pathHash = url.searchParams.get('p');
        const data = await deps.getLoaderData(siteRef, pathHash);
        if (!data) {
          return jsonResponse({ error: 'site_not_found' }, 404);
        }
        return jsonResponse(data, 200, {
          'cache-control': 'no-cache',
        });
      }

      if (request.method === 'GET' && path === '/v1/signer/manifest') {
        const manifest = await deps.getReleaseManifest();
        const verification = await verifyReleaseManifest(manifest, deps.offlinePublicKey, {
          nowMs: now(),
        });
        return jsonResponse({ manifest, verification }, verification.signatureValid ? 200 : 500);
      }

      if (request.method === 'POST' && path === '/v1/signer/bundle/sign') {
        try {
          const body = (await request.json()) as {
            payload: ConfigBundlePayload;
            previousBundle?: ConfigBundlePayload;
          };
          const manifest = await deps.getReleaseManifest();
          const signed = await signConfigBundle(
            body.payload,
            deps.onlinePrivateKey,
            deps.onlineKid,
            manifest.payload,
            { previousBundle: body.previousBundle }
          );
          return jsonResponse({ bundle: signed }, 200);
        } catch (err) {
          if (err instanceof SignerPolicyError) {
            return jsonResponse({ error: 'policy_rejected', details: err.errors }, 422);
          }
          return jsonResponse({ error: 'bad_request' }, 400);
        }
      }

      if (request.method === 'POST' && path === '/v1/signer/bundle/verify') {
        try {
          const body = (await request.json()) as {
            bundle: SignedConfigBundle;
            expectedTenantId: string;
            expectedSiteId: string;
            previousBundle?: ConfigBundlePayload;
          };
          const manifest = await deps.getReleaseManifest();
          const res = await verifyConfigBundle(body.bundle, manifest, deps.offlinePublicKey, {
            nowMs: now(),
            expectedTenantId: body.expectedTenantId,
            expectedSiteId: body.expectedSiteId,
            previousBundle: body.previousBundle,
          });
          return jsonResponse(res, res.valid ? 200 : 422);
        } catch {
          return jsonResponse({ error: 'bad_request' }, 400);
        }
      }

      return jsonResponse({ error: 'not_found' }, 404);
    },
  };
}
