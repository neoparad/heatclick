/**
 * Invariant I5 (§11.5 / SUR M5):
 * Numeric leaves inside Response Envelopes may ONLY originate from the
 * data layer or model registry via the unforgeable `VerifiedMetricValue<T>` brand
 * (also aliased as `Measured<T>`).
 *
 * Uses a module-private `WeakSet<object>` closure with zero runtime Symbol properties,
 * ensuring `Reflect.ownKeys`, `Object.getOwnPropertySymbols`, object spread, and
 * `Object.create(...)` can NEVER extract or forge a `VerifiedMetricValue`.
 */

declare const VERIFIED_METRIC_BRAND: unique symbol;

export type DataLayerAuthority =
  | 'data_layer'
  | 'sealed_rollup'
  | 'edge_live'
  | 'allocator_experiment';

export type MetricAuthority = DataLayerAuthority | 'model_registry';

const VALID_AUTHORITIES: ReadonlySet<string> = new Set<MetricAuthority>([
  'data_layer',
  'sealed_rollup',
  'edge_live',
  'allocator_experiment',
  'model_registry',
]);

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

const MINTED_VERIFIED_METRICS = new WeakSet<object>();

export function assertValidNumericLeaf(value: unknown, path = 'value'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number (got ${String(value)})`);
    }
    return;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length === 0) {
      throw new TypeError(`${path} numeric map must not be empty`);
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} numeric map must not contain symbol keys`);
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined || !desc.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      const v = desc.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(`${path}.${key} must be a finite number (got ${String(v)})`);
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
  if (!VALID_AUTHORITIES.has(authority)) {
    throw new TypeError(`Invalid MetricAuthority: "${String(authority)}"`);
  }
  if (typeof provenanceRef !== 'string' || provenanceRef.trim().length === 0) {
    throw new TypeError('provenanceRef must be a non-empty evidence/query/model reference');
  }
  const effectiveCreatedAt = createdAt ?? new Date(0).toISOString();
  if (typeof effectiveCreatedAt !== 'string' || effectiveCreatedAt.trim().length === 0) {
    throw new TypeError('createdAt must be a non-empty ISO timestamp string');
  }

  const clonedValue =
    typeof value === 'object' && value !== null ? Object.freeze({ ...value }) : value;

  const minted = Object.freeze({
    value: clonedValue as T,
    authority,
    provenanceRef: provenanceRef.trim(),
    createdAt: effectiveCreatedAt,
  });

  MINTED_VERIFIED_METRICS.add(minted);
  return minted as unknown as VerifiedMetricValue<T>;
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
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    return false;
  }
  if (!MINTED_VERIFIED_METRICS.has(candidate)) {
    return false;
  }
  const rec = candidate as Record<string, unknown>;
  if (
    typeof rec.authority !== 'string' ||
    !VALID_AUTHORITIES.has(rec.authority) ||
    typeof rec.provenanceRef !== 'string' ||
    rec.provenanceRef.trim().length === 0 ||
    typeof rec.createdAt !== 'string' ||
    rec.createdAt.trim().length === 0
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
