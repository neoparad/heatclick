/**
 * UGOKI LINK v2 — Internal 5-Screen `/v1` Surface Cutover Adapter (§11.10)
 *
 * Allows the 5 existing internal data screens (`overview`, `heatmap`, `cv_journey`,
 * `crawler`, `experiments`) to switch from legacy direct ClickHouse reads to the exact
 * same external `/v1` SurfacePipeline via feature flags — without breaking existing
 * production `app/` page components.
 *
 * Invariant: NEVER fabricates mock numbers when `/v1` returns `not_collected`,
 * `insufficient_data`, `not_entitled`, or `suppressed`.
 */

import type { MeasureStatus, SerializedResponseEnvelope } from '@/packages/contract/response';
import type { VerifiedPrincipal } from '@/lib/link/auth';
import type { SurfacePipeline } from './pipeline';

export const INTERNAL_SCREENS = [
  'overview',
  'heatmap',
  'cv_journey',
  'crawler',
  'experiments',
] as const;

export type InternalScreenId = (typeof INTERNAL_SCREENS)[number];

export interface InternalScreenFeatureFlags {
  readonly useV1Surface: Readonly<Partial<Record<InternalScreenId, boolean>>>;
}

export function isV1SurfaceEnabled(
  screen: InternalScreenId,
  flags: InternalScreenFeatureFlags
): boolean {
  return flags.useV1Surface[screen] === true;
}

export interface InternalScreenMetricCell {
  readonly key: string;
  readonly value: number | null;
  readonly unit: string;
  readonly status: MeasureStatus;
  readonly evidenceLevel: string;
  readonly unmetGateIds: ReadonlyArray<string>;
}

export interface InternalScreenViewModel {
  readonly screen: InternalScreenId;
  readonly dataSource: 'v1_surface_api';
  readonly siteId: string;
  readonly overallStatus: string;
  readonly residency: {
    readonly storageRegion: string;
    readonly processingRegion: string;
  };
  readonly metrics: ReadonlyArray<InternalScreenMetricCell>;
  readonly rawEnvelopeData?: unknown;
  readonly warnings: ReadonlyArray<string>;
}

const SCREEN_TO_V1_OPERATION: Readonly<Record<InternalScreenId, string>> = {
  overview: 'querySiteMetrics',
  heatmap: 'querySiteFusedInsights',
  cv_journey: 'queryJourneys',
  crawler: 'querySiteFusedInsights',
  experiments: 'getSiteCapabilities',
};

export function envelopeToScreenViewModel(
  screen: InternalScreenId,
  siteId: string,
  envelope: SerializedResponseEnvelope
): InternalScreenViewModel {
  const metrics: InternalScreenMetricCell[] = Object.entries(envelope.measures).map(
    ([key, cell]) => ({
      key,
      value: typeof cell.value === 'number' ? cell.value : null,
      unit: cell.unit,
      status: cell.status,
      evidenceLevel: cell.evidence.level,
      unmetGateIds: cell.unmet_gates.map((g) => g.id),
    })
  );

  return {
    screen,
    dataSource: 'v1_surface_api',
    siteId,
    overallStatus: envelope.status,
    residency: {
      storageRegion: envelope.residency.storage_region,
      processingRegion: envelope.residency.processing_region,
    },
    metrics,
    rawEnvelopeData: envelope.data,
    warnings: envelope.warnings,
  };
}

/**
 * Loads one of the 5 internal screens strictly through the public `/v1` `SurfacePipeline`.
 * Returns `status: 'legacy_flag_off'` if the screen's `/v1` cutover flag is disabled so
 * callers can safely fall back to their existing path during progressive rollout.
 */
export function loadInternalScreenViaV1(params: {
  readonly screen: InternalScreenId;
  readonly siteId: string;
  readonly flags: InternalScreenFeatureFlags;
  readonly pipeline: SurfacePipeline;
  readonly sessionPrincipal?: VerifiedPrincipal;
  readonly bearerToken?: string;
  readonly queryParams?: Readonly<Record<string, unknown>>;
  readonly now?: Date;
}):
  | { readonly mode: 'legacy_flag_off' }
  | { readonly mode: 'v1_ok'; readonly viewModel: InternalScreenViewModel }
  | { readonly mode: 'v1_error'; readonly httpStatus: number; readonly code: string; readonly message: string } {
  if (!isV1SurfaceEnabled(params.screen, params.flags)) {
    return { mode: 'legacy_flag_off' };
  }

  const operationId = SCREEN_TO_V1_OPERATION[params.screen];
  const res = params.pipeline.execute({
    operationId,
    channel: 'rest',
    sessionPrincipal: params.sessionPrincipal,
    bearerToken: params.bearerToken,
    siteId: params.siteId,
    params: params.queryParams,
    now: params.now,
  });

  if (res.error || !res.envelope) {
    return {
      mode: 'v1_error',
      httpStatus: res.httpStatus,
      code: res.error?.code ?? 'SURFACE_ERROR',
      message: res.error?.message ?? 'Failed to load screen via /v1 surface',
    };
  }

  return {
    mode: 'v1_ok',
    viewModel: envelopeToScreenViewModel(params.screen, params.siteId, res.envelope),
  };
}
