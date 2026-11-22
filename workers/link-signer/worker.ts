/**
 * Standard Fetch-API Worker handler for `workers/link-signer`.
 * Serves offline-manifest verification, online bundle signing/verification,
 * and data-only loader responses (`GET /l/:siteRef.json`, §4.2 / D-23).
 */

import { sha256Bytes, utf8Encode } from './crypto';
import {
  InMemoryBundleStateStore,
  SignerCasConflictError,
  SignerPolicyError,
  SignerService,
  verifyConfigBundle,
  verifyReleaseManifest,
} from './signer';
import type {
  BundleStateStore,
  ConfigBundlePayload,
  LoaderDataPayload,
  SignedConfigBundle,
  SignedReleaseManifest,
} from './types';

export interface SignerWorkerDeps {
  readonly offlinePublicKey: CryptoKey;
  readonly onlinePrivateKey: CryptoKey;
  readonly onlineKid: string;
  /** Internal control-plane bearer secret (`CONTROL_PLANE_SIGNER_TOKEN`, C-18). Fails closed 503 if unconfigured. */
  readonly controlPlaneSignerToken?: string;
  /** Authoritative CAS store for `(tenant_id, site_id)` current ConfigBundle (C-18). */
  readonly bundleStateStore?: BundleStateStore;
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

/**
 * Constant-time control-plane bearer token verifier using fixed-length SHA-256 digests
 * so timing never leaks secret length or prefix characters (C-18).
 */
async function verifyControlPlaneAuth(
  request: Request,
  configuredToken: string | undefined
): Promise<{ readonly ok: true } | { readonly ok: false; readonly status: 401 | 503; readonly error: string }> {
  const expected = configuredToken?.trim() ?? '';
  if (!expected) {
    return { ok: false, status: 503, error: 'signer_auth_unconfigured' };
  }

  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const provided = match[1].trim();
  if (!provided) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const [a, b] = await Promise.all([
    sha256Bytes(utf8Encode(provided)),
    sha256Bytes(utf8Encode(expected)),
  ]);
  if (a.length !== b.length) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  if (diff !== 0) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

export function createSignerWorkerHandler(deps: SignerWorkerDeps) {
  const now = deps.nowMs ?? (() => Date.now());
  const bundleStateStore = deps.bundleStateStore ?? new InMemoryBundleStateStore();
  const signerService = new SignerService({
    onlinePrivateKey: deps.onlinePrivateKey,
    onlineKid: deps.onlineKid,
    getReleaseManifest: deps.getReleaseManifest,
    bundleStateStore,
  });

  return {
    bundleStateStore,
    signerService,
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
        const auth = await verifyControlPlaneAuth(request, deps.controlPlaneSignerToken);
        if (!auth.ok) {
          return jsonResponse({ error: auth.error }, auth.status);
        }

        try {
          // C-18: NEVER read or trust caller-supplied `body.previousBundle`!
          // Authoritative previous state is read exclusively from `bundleStateStore` with CAS.
          const body = (await request.json()) as {
            payload: ConfigBundlePayload;
          };
          if (!body || !body.payload) {
            return jsonResponse({ error: 'bad_request' }, 400);
          }
          const signed = await signerService.signAndCommitBundle(body.payload);
          return jsonResponse({ bundle: signed }, 200);
        } catch (err) {
          if (err instanceof SignerCasConflictError) {
            return jsonResponse({ error: 'cas_conflict', message: err.message }, 409);
          }
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
          const storedPrev = await bundleStateStore.getCurrent(
            body.expectedTenantId,
            body.expectedSiteId
          );
          const effectivePrev = storedPrev?.bundle.payload ?? body.previousBundle;
          const res = await verifyConfigBundle(body.bundle, manifest, deps.offlinePublicKey, {
            nowMs: now(),
            expectedTenantId: body.expectedTenantId,
            expectedSiteId: body.expectedSiteId,
            previousBundle: effectivePrev,
          });
          return jsonResponse(res, res.valid ? 200 : 422);
        } catch {
          return jsonResponse({ error: 'bad_request' }, 400);
        }
      }

      // Any other mutating request requires control-plane auth before returning 404
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const auth = await verifyControlPlaneAuth(request, deps.controlPlaneSignerToken);
        if (!auth.ok) {
          return jsonResponse({ error: auth.error }, auth.status);
        }
      }

      return jsonResponse({ error: 'not_found' }, 404);
    },
  };
}
