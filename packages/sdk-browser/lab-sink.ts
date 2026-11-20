/**
 * UGOKI LINK v2 — Browser-Side Unified Lab Marker & Outbound Affiliate Sink (Bundle 3-C)
 *
 * Implements §12.1 #4, §12.2, D-22:
 * - Single unified lab marker with 6 canonical purposes:
 *   `render | install_probe | canary_visit | preflight | agent_run | panel`
 * - Any lab-marked PV rewrites outbound / affiliate destinations to UGOKI LINK's
 *   own first-party sink (`/_ugk/lab-sink`) so ZERO requests reach affiliate network hosts.
 * - Real visitor PVs (no valid lab marker) keep `href` 100% byte-identical (`ssot 2.A-15`).
 * - `render` purpose blocks collector ingestion completely (§12.2).
 */

import { sha256Hex } from '../contract/schema';
import { LAB_MARKER_PURPOSES, type LabMarkerPurpose, type LabMarkerToken } from './types';

export const DEFAULT_LAB_SINK_PATH = '/_ugk/lab-sink' as const;

export function isValidLabMarkerPurpose(value: unknown): value is LabMarkerPurpose {
  return (
    typeof value === 'string' &&
    (LAB_MARKER_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * Validates the structural shape and time window of a browser-side LabMarkerToken.
 * Cryptographic verification occurs at the Zone Worker and Collector Worker.
 */
export function isActiveLabMarker(
  marker: LabMarkerToken | null | undefined,
  nowMs: number
): marker is LabMarkerToken {
  if (!marker) return false;
  if (!isValidLabMarkerPurpose(marker.purpose)) return false;
  if (!marker.lab_run_id || !marker.site_id || !marker.signature_b64) return false;
  const issuedMs = Date.parse(marker.issued_at);
  const expiresMs = Date.parse(marker.expires_at);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return false;
  return nowMs >= issuedMs && nowMs <= expiresMs;
}

/**
 * §12.2: `render` purpose blocks collector ingestion entirely (0 frames sent).
 */
export function shouldBlockTelemetryForLabPurpose(purpose: LabMarkerPurpose): boolean {
  return purpose === 'render';
}

export interface LabSinkRewriteResult {
  readonly rewritten: boolean;
  readonly href: string;
  readonly originalHost: string | null;
  readonly affiliateHostContactBlocked: boolean;
}

/**
 * Rewrites outbound link targets to the first-party lab sink ONLY when an active
 * lab marker is present (§12.1 #4 / D-22).
 * For non-lab human PVs, returns the exact input `href` untouched.
 */
export function rewriteOutboundForLabSink(
  rawHref: string,
  pageOrigin: string,
  labMarker: LabMarkerToken | null | undefined,
  nowMs: number,
  sinkPath: string = DEFAULT_LAB_SINK_PATH
): LabSinkRewriteResult {
  if (!isActiveLabMarker(labMarker, nowMs)) {
    return {
      rewritten: false,
      href: rawHref,
      originalHost: null,
      affiliateHostContactBlocked: false,
    };
  }

  let parsed: URL;
  let originUrl: URL;
  try {
    originUrl = new URL(pageOrigin);
    parsed = new URL(rawHref, originUrl);
  } catch {
    return {
      rewritten: false,
      href: rawHref,
      originalHost: null,
      affiliateHostContactBlocked: false,
    };
  }

  // Only intercept external HTTP(S) outbound links (never rewrite same-origin internal paths)
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!isHttp || parsed.origin === originUrl.origin) {
    return {
      rewritten: false,
      href: rawHref,
      originalHost: parsed.host,
      affiliateHostContactBlocked: false,
    };
  }

  const destHash = sha256Hex(parsed.href).slice(0, 16);
  const sinkUrl = new URL(sinkPath, originUrl);
  sinkUrl.searchParams.set('run', labMarker.lab_run_id);
  sinkUrl.searchParams.set('purpose', labMarker.purpose);
  sinkUrl.searchParams.set('dest_hash', destHash);

  return {
    rewritten: true,
    href: sinkUrl.toString(),
    originalHost: parsed.host,
    affiliateHostContactBlocked: true,
  };
}
