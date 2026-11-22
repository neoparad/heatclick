/**
 * UGOKI LINK v2 — Offline Release Manifest & Online Config Bundle Signer/Verifier
 *
 * Implements §4.2, §6.5, §10.1, D-23, DEL M1 / App. H:
 * - Offline Ed25519 signing/verification of Release Manifest (<=30d TTL, 14d resign cadence,
 *   50/70/85% expiry alerts, anti-downgrade floor, SRI pinned artifacts, offline affiliate param table)
 * - Online signing/verification of unified Config Bundle (<=24h TTL, closed-grammar compiler check,
 *   offline affiliate param check, passkey verification for privacy relaxations, 50 KB integer-model cap)
 * - Per-section expiry fallbacks (deliver & models fail closed; measure fails open up to 7d cap
 *   with `configStale: true`, then falls back to minimal stub; capture stays open as stale evidence)
 */

import {
  importEd25519PublicKey,
  sha256Hex,
  signCanonicalObject,
  verifyCanonicalObject,
  canonicalJson,
} from './crypto';
import {
  detectPrivacyRelaxation,
  validateAffiliateBindingsAgainstOfflineAllowlist,
  validateClosedGrammarAction,
} from './grammar-validator';
import type {
  BundleStateRecord,
  BundleStateStore,
  BundleVerificationResult,
  ConfigBundlePayload,
  ManifestAlertLevel,
  ManifestVerificationResult,
  RelaxationPasskeyApproval,
  ReleaseManifestPayload,
  SignedConfigBundle,
  SignedReleaseManifest,
} from './types';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MAX_MANIFEST_TTL_MS = 30 * MS_PER_DAY;
const MAX_BUNDLE_TTL_MS = 24 * MS_PER_HOUR;
const MAX_SHARD_BYTES_GZIP = 20 * 1024;
const MAX_MODEL_BYTES_GZIP = 50 * 1024;
const MAX_CONVERSION_RULES_PER_SITE = 50;

export class SignerPolicyError extends Error {
  public readonly errors: readonly string[];

  constructor(errors: readonly string[], context = 'Signer policy check failed') {
    super(`${context}: ${errors.join('; ')}`);
    this.name = 'SignerPolicyError';
    this.errors = errors;
  }
}

function validateReleaseManifestPayload(payload: ReleaseManifestPayload): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(payload.manifest_seq) || payload.manifest_seq < 1) {
    errors.push('manifest_seq must be a positive integer');
  }
  const issuedMs = Date.parse(payload.issued_at);
  const notAfterMs = Date.parse(payload.not_after);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(notAfterMs)) {
    errors.push('issued_at and not_after must be valid ISO UTC timestamps');
  } else {
    if (notAfterMs <= issuedMs) {
      errors.push('not_after must be strictly after issued_at');
    }
    if (notAfterMs - issuedMs > MAX_MANIFEST_TTL_MS) {
      errors.push('Release manifest TTL cannot exceed 30 days (§4.2 / del.manifest_ttl_days)');
    }
  }

  // Verify SRI prefixes on all pinned artifacts
  const sriRe = /^sha256-[A-Za-z0-9+/]{43}=$/;
  const artifacts = [
    ['measure_core', payload.artifacts.measure_core.sri],
    ['segmenter', payload.artifacts.segmenter.sri],
    ['deliver_core', payload.artifacts.deliver_core.sri],
    ['census_empty_file', payload.artifacts.census_empty_file.sri],
  ] as const;
  for (const [name, sri] of artifacts) {
    if (!sriRe.test(sri)) {
      errors.push(`artifacts.${name}.sri must be a valid sha256-<base64> SRI digest`);
    }
  }

  for (const rule of payload.affiliate_param_allowlist) {
    if (rule.overwrite_existing !== false) {
      errors.push(`affiliate_param_allowlist[${rule.network_id}] must enforce overwrite_existing=false`);
    }
  }

  return errors;
}

/**
 * Signs a Release Manifest using the OFFLINE Ed25519 release private key.
 */
export async function signReleaseManifest(
  payload: ReleaseManifestPayload,
  offlinePrivateKey: CryptoKey,
  kid: string
): Promise<SignedReleaseManifest> {
  const errors = validateReleaseManifestPayload(payload);
  if (errors.length > 0) {
    throw new SignerPolicyError(errors, 'Invalid ReleaseManifestPayload');
  }

  const { sha256, sigB64 } = await signCanonicalObject(offlinePrivateKey, payload);
  return {
    payload,
    payload_sha256: sha256,
    signature: {
      kid,
      alg: 'Ed25519',
      sig_b64: sigB64,
    },
  };
}

/**
 * Verifies an offline-signed Release Manifest against the pinned offline Ed25519 public key.
 * Implements §4.2 expiry semantics:
 * - Alerts at 50%, 70%, 85% of the 30-day TTL window
 * - After expiry: `deliverAllowed = false` (fail closed), `measureAllowed = true` if last verified
 *   and `manifestStale = true` (or minimal stub for first-time cookieless visitors).
 */
export async function verifyReleaseManifest(
  signed: SignedReleaseManifest,
  offlinePublicKey: CryptoKey,
  options: {
    readonly nowMs: number;
    readonly minRememberedSeq?: number;
    readonly hasLastVerifiedMeasureCache?: boolean;
  }
): Promise<ManifestVerificationResult> {
  const errors: string[] = [];

  const computedHash = await sha256Hex(canonicalJson(signed.payload));
  if (computedHash !== signed.payload_sha256) {
    errors.push('payload_sha256 does not match canonical manifest payload');
  }

  const signatureValid = await verifyCanonicalObject(
    offlinePublicKey,
    signed.payload,
    signed.signature.sig_b64
  );
  if (!signatureValid) {
    errors.push('Offline Ed25519 release manifest signature verification failed');
  }

  const structureErrors = validateReleaseManifestPayload(signed.payload);
  errors.push(...structureErrors);

  const minSeq = options.minRememberedSeq ?? 1;
  const downgraded = signed.payload.manifest_seq < minSeq;
  if (downgraded) {
    errors.push(
      `Manifest downgrade detected: manifest_seq ${signed.payload.manifest_seq} < remembered floor ${minSeq}`
    );
  }

  const issuedMs = Date.parse(signed.payload.issued_at);
  const notAfterMs = Date.parse(signed.payload.not_after);
  const expired = options.nowMs > notAfterMs;

  let alertLevel: ManifestAlertLevel = 'none';
  if (expired) {
    alertLevel = 'expired';
  } else if (Number.isFinite(issuedMs) && Number.isFinite(notAfterMs) && notAfterMs > issuedMs) {
    const progress = (options.nowMs - issuedMs) / (notAfterMs - issuedMs);
    if (progress >= 0.85) alertLevel = '85%';
    else if (progress >= 0.7) alertLevel = '70%';
    else if (progress >= 0.5) alertLevel = '50%';
  }

  const cryptographicOk = signatureValid && computedHash === signed.payload_sha256 && !downgraded && structureErrors.length === 0;

  // On expired (but cryptographically authentic) manifest: delivery stops, last verified measure continues with stale flag (§4.2)
  const deliverAllowed = cryptographicOk && !expired;
  const measureAllowed =
    cryptographicOk && (!expired || options.hasLastVerifiedMeasureCache === true);

  return {
    valid: cryptographicOk && !expired,
    signatureValid,
    expired,
    downgraded,
    alertLevel,
    deliverAllowed,
    measureAllowed,
    manifestStale: cryptographicOk && expired,
    errors: expired ? [...errors, 'Release manifest expired (deliver stopped; measure stale)'] : errors,
  };
}

function validateConfigBundleStructure(
  payload: ConfigBundlePayload,
  releaseManifest: ReleaseManifestPayload
): string[] {
  const errors: string[] = [];

  if (!payload.aud.tenant_id?.trim() || !payload.aud.site_id?.trim()) {
    errors.push('aud.tenant_id and aud.site_id are required');
  }
  if (!Number.isInteger(payload.seq) || payload.seq < releaseManifest.min_config_seq) {
    errors.push(
      `Config bundle seq ${payload.seq} is below offline manifest floor min_config_seq=${releaseManifest.min_config_seq} (§10.1 anti-replay)`
    );
  }

  const issuedMs = Date.parse(payload.issued_at);
  const notAfterMs = Date.parse(payload.not_after);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(notAfterMs)) {
    errors.push('Config bundle issued_at and not_after must be valid ISO UTC timestamps');
  } else if (notAfterMs <= issuedMs) {
    errors.push('Config bundle not_after must be strictly after issued_at');
  } else if (notAfterMs - issuedMs > MAX_BUNDLE_TTL_MS) {
    errors.push('Config bundle TTL cannot exceed 24 hours (§10.1 / DEL M1)');
  }

  if (payload.measure.conversion_rules.length > MAX_CONVERSION_RULES_PER_SITE) {
    errors.push(`conversion_rules exceeds maximum of ${MAX_CONVERSION_RULES_PER_SITE} per site`);
  }

  // Closed grammar check on every delivery action
  for (const action of payload.deliver.actions) {
    const res = validateClosedGrammarAction(action, payload.measure.protected_regions);
    errors.push(...res.errors);
  }

  // Affiliate parameter allow-list check against OFFLINE-SIGNED manifest (§6.5)
  const affRes = validateAffiliateBindingsAgainstOfflineAllowlist(
    payload.deliver.affiliate_slot_bindings,
    releaseManifest.affiliate_param_allowlist
  );
  errors.push(...affRes.errors);

  // Shard size budget <= 20 KB gzip (DEL M1 / App. D)
  for (const shard of payload.deliver.shards) {
    if (shard.bytes_gzip > MAX_SHARD_BYTES_GZIP) {
      errors.push(`deliver.shards[${shard.shard_id}] exceeds 20 KB gzip budget (${shard.bytes_gzip})`);
    }
  }

  // Model artifacts: integer tree table data ONLY, <= 50 KB gzip (§2.2 #11 / ml.artifact_max_kb)
  for (const model of payload.models.artifacts) {
    if (model.format !== 'int_tree_table_v1') {
      errors.push(
        `models.artifacts[${model.model_id}] uses forbidden format "${String(model.format)}"; only signed integer data tables are allowed`
      );
    }
    if (model.bytes_gzip > MAX_MODEL_BYTES_GZIP) {
      errors.push(`models.artifacts[${model.model_id}] exceeds 50 KB gzip budget (${model.bytes_gzip})`);
    }
  }

  return errors;
}

export class SignerCasConflictError extends Error {
  constructor(tenantId: string, siteId: string) {
    super(`BundleStateStore CAS conflict for (${tenantId}, ${siteId})`);
    this.name = 'SignerCasConflictError';
  }
}

/**
 * Computes the canonical SHA-256 diff digest for a privacy relaxation approval,
 * binding `(tenant_id, site_id, prev_seq, next_seq, next_measure)` (C-18).
 */
export async function computeRelaxationDiffSha256(params: {
  readonly tenantId: string;
  readonly siteId: string;
  readonly prevSeq: number;
  readonly nextSeq: number;
  readonly nextMeasure: ConfigBundlePayload['measure'];
}): Promise<string> {
  const { relaxation_approval: _ignored, ...measureWithoutApproval } = params.nextMeasure;
  return sha256Hex(
    canonicalJson({
      tenant_id: params.tenantId,
      site_id: params.siteId,
      prev_seq: params.prevSeq,
      next_seq: params.nextSeq,
      next_measure: measureWithoutApproval,
    })
  );
}

export async function createSignedRelaxationApproval(params: {
  readonly approverKid: string;
  readonly approverPrivateKey: CryptoKey;
  readonly tenantId: string;
  readonly siteId: string;
  readonly prevSeq: number;
  readonly nextSeq: number;
  readonly nextMeasure: ConfigBundlePayload['measure'];
}): Promise<RelaxationPasskeyApproval> {
  const diffSha256 = await computeRelaxationDiffSha256({
    tenantId: params.tenantId,
    siteId: params.siteId,
    prevSeq: params.prevSeq,
    nextSeq: params.nextSeq,
    nextMeasure: params.nextMeasure,
  });
  const { sigB64 } = await signCanonicalObject(params.approverPrivateKey, {
    tenant_id: params.tenantId,
    site_id: params.siteId,
    prev_seq: params.prevSeq,
    next_seq: params.nextSeq,
    diff_sha256: diffSha256,
  });
  return {
    approver_kid: params.approverKid,
    prev_seq: params.prevSeq,
    next_seq: params.nextSeq,
    diff_sha256: diffSha256,
    sig_b64: sigB64,
  };
}

async function verifyPasskeyRelaxationIfNeeded(
  prevBundle: ConfigBundlePayload | undefined,
  nextPayload: ConfigBundlePayload,
  releaseManifest: ReleaseManifestPayload
): Promise<string[]> {
  const nextMeasure = nextPayload.measure;
  const expectedPrevSeq = prevBundle ? prevBundle.seq : 0;
  const baselineMeasure: ConfigBundlePayload['measure'] = prevBundle
    ? prevBundle.measure
    : {
        ...nextMeasure,
        site_default_consent: 'cookieless',
        allow_cmp_opt_in_from_default_off: false,
      };

  const check = detectPrivacyRelaxation(baselineMeasure, nextMeasure);
  if (!check.isRelaxation) return [];

  const approval = nextMeasure.relaxation_approval;
  if (!approval) {
    return [
      `Privacy/protection relaxation requires approver passkey signature pinned in offline release manifest (§10.1): ${check.reasons.join(', ')}`,
    ];
  }

  if (approval.prev_seq !== expectedPrevSeq) {
    return [
      `Passkey approval prev_seq (${approval.prev_seq}) does not match authoritative previous seq (${expectedPrevSeq})`,
    ];
  }

  if (approval.next_seq !== undefined && approval.next_seq !== nextPayload.seq) {
    return [
      `Passkey approval next_seq (${approval.next_seq}) does not match target bundle seq (${nextPayload.seq})`,
    ];
  }

  const approverEntry = releaseManifest.approver_passkey_pubkeys.find(
    (a) => a.kid === approval.approver_kid
  );
  if (!approverEntry) {
    return [
      `Approver passkey kid "${approval.approver_kid}" is not pinned in offline release manifest`,
    ];
  }

  const expectedDiffSha = await computeRelaxationDiffSha256({
    tenantId: nextPayload.aud.tenant_id,
    siteId: nextPayload.aud.site_id,
    prevSeq: expectedPrevSeq,
    nextSeq: nextPayload.seq,
    nextMeasure,
  });
  if (approval.diff_sha256 !== expectedDiffSha) {
    return [
      'Passkey approval diff_sha256 does not match (tenant_id, site_id, prev_seq, next_seq, next_measure)',
    ];
  }

  const pubKey = await importEd25519PublicKey(approverEntry.public_key_jwk);
  const sigOk = await verifyCanonicalObject(
    pubKey,
    {
      tenant_id: nextPayload.aud.tenant_id,
      site_id: nextPayload.aud.site_id,
      prev_seq: expectedPrevSeq,
      next_seq: nextPayload.seq,
      diff_sha256: approval.diff_sha256,
    },
    approval.sig_b64
  );
  if (!sigOk) {
    return ['Invalid approver passkey signature on privacy relaxation'];
  }

  return [];
}

/**
 * Signs a unified Config Bundle using an online signing key listed as active in
 * the offline-signed release manifest. Runs ALL compiler/grammar/affiliate/relaxation
 * gates BEFORE signing.
 */
export async function signConfigBundle(
  payload: ConfigBundlePayload,
  onlinePrivateKey: CryptoKey,
  kid: string,
  releaseManifest: ReleaseManifestPayload,
  options?: {
    readonly previousBundle?: ConfigBundlePayload;
  }
): Promise<SignedConfigBundle> {
  const errors = validateConfigBundleStructure(payload, releaseManifest);

  const keyEntry = releaseManifest.online_signing_keys.find(
    (k) => k.kid === kid && k.status === 'active'
  );
  if (!keyEntry) {
    errors.push(`Online signing key "${kid}" is not active in offline release manifest`);
  }

  if (options?.previousBundle) {
    if (
      options.previousBundle.aud.tenant_id !== payload.aud.tenant_id ||
      options.previousBundle.aud.site_id !== payload.aud.site_id
    ) {
      errors.push('previousBundle audience does not match target ConfigBundle aud');
    } else if (payload.seq !== options.previousBundle.seq + 1) {
      errors.push(
        `Config bundle seq ${payload.seq} must equal previous seq + 1 (${options.previousBundle.seq + 1})`
      );
    }
  }

  const relaxErrors = await verifyPasskeyRelaxationIfNeeded(
    options?.previousBundle,
    payload,
    releaseManifest
  );
  errors.push(...relaxErrors);

  if (errors.length > 0) {
    throw new SignerPolicyError(errors, 'Refused to sign ConfigBundle');
  }

  const { sha256, sigB64 } = await signCanonicalObject(onlinePrivateKey, payload);
  return {
    payload,
    bundle_hash: sha256,
    signatures: [
      {
        kid,
        alg: 'Ed25519',
        sig_b64: sigB64,
      },
    ],
  };
}

/**
 * Consumer-side (SDK / Edge / Worker) independent verification of a SignedConfigBundle.
 * Re-verifies offline release manifest, online key membership, signature, bundle hash,
 * closed grammar, affiliate allow-list, and privacy non-relaxation (defense-in-depth
 * so even a 100%-compromised online signing service CANNOT inject scripts or relax privacy).
 */
export async function verifyConfigBundle(
  signedBundle: SignedConfigBundle,
  signedManifest: SignedReleaseManifest,
  offlinePublicKey: CryptoKey,
  options: {
    readonly nowMs: number;
    readonly expectedTenantId: string;
    readonly expectedSiteId: string;
    readonly previousBundle?: ConfigBundlePayload;
    readonly maxMeasureStaleDays?: number;
  }
): Promise<BundleVerificationResult> {
  const errors: string[] = [];

  const failClosedAll = (): BundleVerificationResult => ({
    valid: false,
    expired: false,
    sectionState: {
      measure: { enabled: false, configStale: false, fallbackToMinimalStub: true },
      capture: { enabled: false, unverifiableStaleEvidence: true },
      deliver: { enabled: false, unmetGate: 'bundle_integrity' },
      models: { enabled: false, fallbackReason: 'bundle_integrity' },
    },
    errors,
  });

  // 1. Verify offline-signed release manifest first
  const manifestRes = await verifyReleaseManifest(signedManifest, offlinePublicKey, {
    nowMs: options.nowMs,
    hasLastVerifiedMeasureCache: true,
  });
  if (!manifestRes.signatureValid || manifestRes.downgraded) {
    errors.push(...manifestRes.errors);
    return failClosedAll();
  }

  // 2. Verify audience binding
  if (
    signedBundle.payload.aud.tenant_id !== options.expectedTenantId ||
    signedBundle.payload.aud.site_id !== options.expectedSiteId
  ) {
    errors.push('Config bundle aud (tenant_id, site_id) mismatch');
    return failClosedAll();
  }

  // 3. Verify canonical bundle hash
  const computedHash = await sha256Hex(canonicalJson(signedBundle.payload));
  if (computedHash !== signedBundle.bundle_hash) {
    errors.push('Config bundle_hash mismatch');
    return failClosedAll();
  }

  // 4. Verify online signature against an ACTIVE key pinned in the OFFLINE manifest
  let anyValidSig = false;
  for (const sig of signedBundle.signatures) {
    const keyEntry = signedManifest.payload.online_signing_keys.find(
      (k) => k.kid === sig.kid && k.status === 'active'
    );
    if (!keyEntry) continue;
    if (options.nowMs > Date.parse(keyEntry.valid_until)) continue;

    const pubKey = await importEd25519PublicKey(keyEntry.public_key_jwk);
    const ok = await verifyCanonicalObject(pubKey, signedBundle.payload, sig.sig_b64);
    if (ok) {
      anyValidSig = true;
      break;
    }
  }
  if (!anyValidSig) {
    errors.push('No valid signature from an active online key pinned in the offline manifest');
    return failClosedAll();
  }

  // 5. Defense-in-depth consumer re-validation of closed grammar, affiliate table & passkey relaxation
  const structErrors = validateConfigBundleStructure(signedBundle.payload, signedManifest.payload);
  errors.push(...structErrors);

  const relaxErrors = await verifyPasskeyRelaxationIfNeeded(
    options.previousBundle,
    signedBundle.payload,
    signedManifest.payload
  );
  errors.push(...relaxErrors);

  if (errors.length > 0) {
    return failClosedAll();
  }

  // 6. Per-section expiry policy (§10.1 / D-23)
  const notAfterMs = Date.parse(signedBundle.payload.not_after);
  const bundleExpired = options.nowMs > notAfterMs;
  const maxStaleMs = (options.maxMeasureStaleDays ?? 7) * MS_PER_DAY;
  const pastMeasureStaleCap = options.nowMs > notAfterMs + maxStaleMs;

  if (bundleExpired || manifestRes.expired) {
    if (bundleExpired) {
      errors.push('Config bundle expired (>24h): deliver & models stopped; measure stale-capped');
    }
    if (manifestRes.expired) {
      errors.push('Release manifest expired (>30d): deliver & models stopped');
    }

    return {
      valid: false,
      expired: true,
      sectionState: {
        measure: {
          enabled: !pastMeasureStaleCap,
          configStale: true,
          fallbackToMinimalStub: pastMeasureStaleCap,
        },
        capture: {
          enabled: true,
          unverifiableStaleEvidence: true,
        },
        deliver: {
          enabled: false,
          unmetGate: 'bundle_integrity',
        },
        models: {
          enabled: false,
          fallbackReason: 'bundle_expired_uniform_fallback',
        },
      },
      errors,
    };
  }

  return {
    valid: true,
    expired: false,
    sectionState: {
      measure: {
        enabled: true,
        configStale: false,
        fallbackToMinimalStub: false,
      },
      capture: {
        enabled: true,
        unverifiableStaleEvidence: false,
      },
      deliver: {
        enabled: true,
      },
      models: {
        enabled: true,
      },
    },
    errors: [],
  };
}

// =========================================================================
// Authoritative CAS BundleStateStore & SignerService (C-18)
// =========================================================================

export class InMemoryBundleStateStore implements BundleStateStore {
  private readonly store = new Map<string, BundleStateRecord>();
  private versionSeq = 0;

  private key(tenantId: string, siteId: string): string {
    return `${tenantId}::${siteId}`;
  }

  public async getCurrent(tenantId: string, siteId: string): Promise<BundleStateRecord | null> {
    return this.store.get(this.key(tenantId, siteId)) ?? null;
  }

  public async seedBundle(bundle: SignedConfigBundle): Promise<BundleStateRecord> {
    this.versionSeq += 1;
    const rec: BundleStateRecord = {
      bundle,
      versionToken: `v_${this.versionSeq}_${bundle.bundle_hash.slice(0, 16)}`,
    };
    this.store.set(this.key(bundle.payload.aud.tenant_id, bundle.payload.aud.site_id), rec);
    return rec;
  }

  public async compareAndSwap(params: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly expectedVersionToken: string | null;
    readonly nextBundle: SignedConfigBundle;
  }): Promise<{ readonly committed: boolean; readonly current: BundleStateRecord | null }> {
    const k = this.key(params.tenantId, params.siteId);
    const existing = this.store.get(k) ?? null;
    const actualToken = existing ? existing.versionToken : null;
    if (actualToken !== params.expectedVersionToken) {
      return { committed: false, current: existing };
    }
    this.versionSeq += 1;
    const nextRec: BundleStateRecord = {
      bundle: params.nextBundle,
      versionToken: `v_${this.versionSeq}_${params.nextBundle.bundle_hash.slice(0, 16)}`,
    };
    this.store.set(k, nextRec);
    return { committed: true, current: nextRec };
  }
}

export class SignerService {
  constructor(
    private readonly deps: {
      readonly onlinePrivateKey: CryptoKey;
      readonly onlineKid: string;
      readonly getReleaseManifest: () => Promise<SignedReleaseManifest>;
      readonly bundleStateStore: BundleStateStore;
    }
  ) {}

  /**
   * Signs and atomically commits the next ConfigBundle for `(tenant_id, site_id)` using
   * the authoritative `BundleStateStore` (NEVER trusting caller-supplied `previousBundle`!).
   */
  public async signAndCommitBundle(payload: ConfigBundlePayload): Promise<SignedConfigBundle> {
    const tenantId = payload.aud?.tenant_id?.trim() ?? '';
    const siteId = payload.aud?.site_id?.trim() ?? '';
    if (!tenantId || !siteId) {
      throw new SignerPolicyError(['aud.tenant_id and aud.site_id are required']);
    }

    const current = await this.deps.bundleStateStore.getCurrent(tenantId, siteId);
    const prevPayload = current?.bundle.payload;
    const expectedSeq = prevPayload ? prevPayload.seq + 1 : 1;

    if (!Number.isInteger(payload.seq) || payload.seq !== expectedSeq) {
      throw new SignerPolicyError([
        `Config bundle seq ${payload.seq} must equal authoritative next seq ${expectedSeq} (prev=${prevPayload ? prevPayload.seq : 'none'})`,
      ]);
    }

    const manifest = await this.deps.getReleaseManifest();
    const signed = await signConfigBundle(
      payload,
      this.deps.onlinePrivateKey,
      this.deps.onlineKid,
      manifest.payload,
      { previousBundle: prevPayload }
    );

    const cas = await this.deps.bundleStateStore.compareAndSwap({
      tenantId,
      siteId,
      expectedVersionToken: current ? current.versionToken : null,
      nextBundle: signed,
    });
    if (!cas.committed) {
      throw new SignerCasConflictError(tenantId, siteId);
    }

    return signed;
  }
}
