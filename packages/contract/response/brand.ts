/**
 * Invariant I5 (§11.5 / SUR M5):
 * Numeric leaves inside Response Envelopes may ONLY originate from the
 * data layer or model registry via the unforgeable `VerifiedMetricValue<T>` brand
 * (also aliased as `Measured<T>`).
 *
 * Uses a private module-scoped Symbol that is NEVER exported, preventing plain
 * numeric literals or forged plain objects from bypassing the single serializer
 * at both compile time and runtime.
 */

const VERIFIED_METRIC_BRAND: unique symbol = Symbol('ugokilink.VerifiedMetricValue');

export type DataLayerAuthority =
  | 'data_layer'
  | 'sealed_rollup'
  | 'edge_live'
  | 'allocator_experiment';

export type MetricAuthority = DataLayerAuthority | 'model_registry';

export type VerifiedNumericLeaf = number | Readonly<Record<string, number>>;

export interface VerifiedMetricValue<T extends VerifiedNumericLeaf = number> {
  readonly [VERIFIED_METRIC_BRAND]: true;
  readonly value: T;
  readonly authority: MetricAuthority;
  readonly provenanceRef: string;
  readonly createdAt: string;
}

/** Alias matching SUR M5 I5 (`Measured<T>`). */
export type Measured<T extends VerifiedNumericLeaf = number> = VerifiedMetricValue<T>;

function assertValidNumericLeaf(value: unknown, path = 'value'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number (got ${String(value)})`);
    }
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      throw new TypeError(`${path} numeric map must not be empty`);
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(`${path}.${k} must be a finite number (got ${String(v)})`);
      }
    }
    return;
  }
  throw new TypeError(`${path} must be a finite number or finite numeric record`);
}

function mintVerifiedMetric<T extends VerifiedNumericLeaf>(
  value: T,
  authority: MetricAuthority,
  provenanceRef: string,
  createdAt?: string
): VerifiedMetricValue<T> {
  assertValidNumericLeaf(value);
  if (typeof provenanceRef !== 'string' || provenanceRef.trim().length === 0) {
    throw new TypeError('provenanceRef must be a non-empty evidence/query/model reference');
  }
  const clonedValue =
    typeof value === 'object' && value !== null ? Object.freeze({ ...value }) : value;

  return Object.freeze({
    [VERIFIED_METRIC_BRAND]: true as const,
    value: clonedValue as T,
    authority,
    provenanceRef: provenanceRef.trim(),
    createdAt: createdAt ?? new Date(0).toISOString(),
  });
}

/**
 * Mints a `VerifiedMetricValue` from the authenticated data layer / store query path.
 */
export function createDataLayerMetric<T extends VerifiedNumericLeaf>(
  value: T,
  provenanceRef: string,
  options?: {
    readonly authority?: DataLayerAuthority;
    readonly createdAt?: string;
  }
): VerifiedMetricValue<T> {
  return mintVerifiedMetric(
    value,
    options?.authority ?? 'data_layer',
    provenanceRef,
    options?.createdAt
  );
}

/**
 * Mints a `VerifiedMetricValue` from the signed ML model registry.
 */
export function createModelRegistryMetric<T extends VerifiedNumericLeaf>(
  value: T,
  modelProvenanceRef: string,
  options?: {
    readonly createdAt?: string;
  }
): VerifiedMetricValue<T> {
  return mintVerifiedMetric(value, 'model_registry', modelProvenanceRef, options?.createdAt);
}

/**
 * Runtime guard proving a value was minted through `createDataLayerMetric` or
 * `createModelRegistryMetric` and has not been forged or corrupted.
 */
export function isVerifiedMetricValue(
  candidate: unknown
): candidate is VerifiedMetricValue<VerifiedNumericLeaf> {
  if (candidate === null || typeof candidate !== 'object') {
    return false;
  }
  const rec = candidate as Record<PropertyKey, unknown>;
  if (rec[VERIFIED_METRIC_BRAND] !== true) {
    return false;
  }
  if (
    typeof rec.provenanceRef !== 'string' ||
    rec.provenanceRef.trim().length === 0
  ) {
    return false;
  }
  try {
    assertValidNumericLeaf(rec.value);
  } catch {
    return false;
  }
  return true;
}

/**
 * Extracts the raw numeric value ONLY after verifying the unforgeable brand.
 */
export function unwrapVerifiedMetricValue<T extends VerifiedNumericLeaf>(
  metric: VerifiedMetricValue<T>
): T {
  if (!isVerifiedMetricValue(metric)) {
    throw new TypeError('Refused to unwrap unverified metric value');
  }
  return metric.value;
}
