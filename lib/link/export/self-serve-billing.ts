/**
 * UGOKI LINK v2 — Automated Self-Serve Onboarding & Public Pricing / Monthly Calculator
 *
 * Implements Master Spec §11.11 #1 & #7:
 * 1. Zero-touch self-serve onboarding orchestrator:
 *    signup -> tenant & site provisioning -> Ed25519 public key + secret key issuance ->
 *    single-block 5-minute install snippet & JP External Transmission disclosure generation ->
 *    `onboarding_verify` (`lab_token`) confirmation visit verified <= 60s in `SiteLiveDurableObject`
 *    (general visitors remain `off` until disclosure verification passes!).
 * 2. Public pricing schedule & monthly cost calculator:
 *    - Zero "contact sales only" / 「見積もりのみ」 tiers for foundational capabilities
 *    - Free tier matching competitor maximums from `packages/contract/ledgers`:
 *      2,000,000 event-equivalents/month + 50,000 visual replays/month
 *    - Explicit cumulative-PV-to-event-equivalent conversion formula
 *    - Itemized usage calculator covering ALL lanes (standard telemetry, Segment-compatible
 *      events, destination deliveries, visual replays, subject deletions)
 */

import crypto from 'node:crypto';
import { getConstant } from '../../../packages/contract/ledgers';
import {
  CANONICAL_SCHEMA,
  generatePrivacyDisclosure,
  type PrivacyDisclosureRecord,
} from '../../../packages/contract/schema';
import {
  IdentityKeyRegistry,
  generateEd25519KeyPair,
  mintPublicKey,
  type Ed25519KeyPair,
} from '../auth';
import type { DataRegion, StorageTier } from '../../../workers/link-wal';
import {
  SiteLiveDurableObject,
  type LabTokenClaims,
  type OnboardingVerifyStatus,
} from '../../../workers/link-live';

// =========================================================================
// 1. Zero-Touch Self-Serve Onboarding Orchestrator (§11.11 #1 & #7)
// =========================================================================

export const ONBOARDING_TOTAL_SLA_MS = 10 * 60 * 1000; // <= 10 min signup -> confirmed live visit

export interface SelfServeSignupInput {
  readonly organizationName: string;
  readonly siteName: string;
  readonly hostname: string;
  readonly storageRegion?: DataRegion;
  readonly storageTier?: StorageTier;
  readonly retentionMonths?: number;
  readonly policyUrl?: string;
  readonly legalRecipientName?: string;
  readonly nowMs?: number;
}

export interface SelfServeProvisionedWorkspace {
  readonly tenantId: string;
  readonly siteId: string;
  readonly siteRef: string;
  readonly storageRegion: DataRegion;
  readonly storageTier: StorageTier;
  readonly retentionMonths: number;
  readonly publicKey: string;
  /** Returned ONCE at `provisionWorkspace`; stored workspaces retain ONLY `secretKeyHash` in `IdentityKeyRegistry` (H-20). */
  readonly secretKey: string;
  readonly secretKeyHash: string;
  readonly keyId: string;
  readonly sriIntegrity: string;
  readonly installSnippetHtml: string;
  readonly disclosureRecord: PrivacyDisclosureRecord;
  readonly disclosureVerificationState: 'missing' | 'declared' | 'verified';
  /** Until disclosure is verified on policyUrl, general visitor mode stays `off` (§11.11 #1). */
  readonly generalTrafficEffectiveConsentMode: 'off' | 'cookieless';
  readonly onboardingVerifyToken: LabTokenClaims;
  readonly provisionedAtMs: number;
  readonly liveDo: SiteLiveDurableObject;
}

export interface SelfServeVerificationReceipt {
  readonly tenantId: string;
  readonly siteId: string;
  readonly onboardingVerified: boolean;
  readonly visitVisibleWithin60s: boolean;
  readonly totalOnboardingElapsedMs: number;
  readonly within10MinEndToEndSla: boolean;
  readonly humanTrafficContaminationCount: number;
  readonly generalTrafficConsentMode: 'off' | 'cookieless';
  readonly disclosureVerificationState: 'missing' | 'declared' | 'verified';
  readonly liveStatus: OnboardingVerifyStatus;
}

function makeSlugRef(hostname: string): string {
  const cleaned = hostname
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${cleaned || 'site'}_${suffix}`;
}

const PINNED_SDK_RELEASE_VERSION = '2.0.0';
const PINNED_SDK_BUNDLE_SRI_SHA384 = crypto
  .createHash('sha384')
  .update(`ugokilink-sdk-runtime@${PINNED_SDK_RELEASE_VERSION}`, 'utf8')
  .digest('base64');

export class SelfServeOnboardingOrchestrator {
  private readonly signingKeyPair: Ed25519KeyPair;
  private readonly identityRegistry: IdentityKeyRegistry;
  private readonly workspaces = new Map<string, SelfServeProvisionedWorkspace>();

  public constructor(options?: {
    readonly signingKeyPair?: Ed25519KeyPair;
    readonly identityRegistry?: IdentityKeyRegistry;
  }) {
    this.signingKeyPair = options?.signingKeyPair ?? generateEd25519KeyPair('k_selfserve_v1');
    this.identityRegistry =
      options?.identityRegistry ??
      new IdentityKeyRegistry({
        pepperVersion: 'v1',
        pepperSecret: crypto.randomBytes(32).toString('hex'),
      });
  }

  public getPublicSigningKeyPem(): string {
    return this.signingKeyPair.publicKeyPem;
  }

  public getIdentityKeyRegistry(): IdentityKeyRegistry {
    return this.identityRegistry;
  }

  public getStoredWorkspace(siteId: string): SelfServeProvisionedWorkspace | undefined {
    return this.workspaces.get(siteId);
  }

  /**
   * Executes unmanned signup -> tenant/site creation -> Ed25519 public & secret
   * key minting (storing ONLY peppered HMAC in `IdentityKeyRegistry`, never plaintext) ->
   * pinned SRI 5-minute snippet + JP disclosure generation -> `onboarding_verify` token issuance (H-20).
   */
  public provisionWorkspace(
    input: SelfServeSignupInput
  ): SelfServeProvisionedWorkspace {
    const nowMs = input.nowMs ?? Date.now();
    const nowDate = new Date(nowMs);
    const orgId = `org_${crypto.randomBytes(6).toString('hex')}`;
    const tenantId = `ten_${crypto.randomBytes(6).toString('hex')}`;
    const siteId = `site_${crypto.randomBytes(6).toString('hex')}`;
    const ownerPrincipalId = `usr_owner_${crypto.randomBytes(6).toString('hex')}`;
    const siteRef = makeSlugRef(input.hostname);
    const storageRegion: DataRegion = input.storageRegion ?? 'jp';
    const storageTier: StorageTier = input.storageTier ?? 'tier1_link_managed';
    const retentionMonths = input.retentionMonths ?? 13;

    this.identityRegistry.registerOrg({
      orgId,
      type: 'direct',
      name: input.organizationName,
      createdAt: nowDate.toISOString(),
    });
    this.identityRegistry.registerTenant({
      tenantId,
      orgId,
      name: input.organizationName,
      planScopes: ['analytics:read', 'analytics:export', 'sites:manage', 'usage:read'],
      delegationPolicy: {
        allowedOemScopes: [],
        maxExchangedTokenTtlSec: 900,
        allowOemAccess: false,
      },
      revocationEpoch: 1,
      createdAt: nowDate.toISOString(),
    });
    this.identityRegistry.registerPrincipal({
      principalId: ownerPrincipalId,
      tenantId,
      orgId,
      kind: 'human',
      role: 'owner',
      passkeyEnrolled: false,
    });

    const publicKey = mintPublicKey({
      env: 'live',
      siteRef,
      version: 'v1',
      privateKeyPem: this.signingKeyPair.privateKeyPem,
    });

    const issuedSecret = this.identityRegistry.issueSecretKey({
      tenantId,
      principalId: ownerPrincipalId,
      scopes: ['analytics:read', 'analytics:export', 'sites:manage', 'usage:read'],
      constraints: { siteIds: [siteId] },
      now: nowDate,
    });
    const keyId = issuedSecret.record.keyId;
    const secretKey = issuedSecret.rawKey;
    const secretKeyHash = issuedSecret.record.secretHash;

    const disclosureRecord = generatePrivacyDisclosure(CANONICAL_SCHEMA, {
      siteName: input.siteName,
      senderName: input.organizationName,
      legalRecipientName: input.legalRecipientName ?? 'UGOKI LINK Analytics Processor',
      optOutUrl: `https://${input.hostname}/ugokilink-optout`,
      retentionMonths,
    });

    const onboardingVerifyToken: LabTokenClaims = {
      tokenId: `ov_${crypto.randomBytes(6).toString('hex')}`,
      tenantId,
      siteId,
      purpose: 'onboarding_verify',
      runId: `onboard_${nowMs}`,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 30 * 60 * 1000,
    };

    const sriIntegrity = `sha384-${PINNED_SDK_BUNDLE_SRI_SHA384}`;
    const manifestPubKeyPin = crypto
      .createHash('sha256')
      .update(this.signingKeyPair.publicKeyPem, 'utf8')
      .digest('hex')
      .slice(0, 32);

    const installSnippetHtml = [
      `<!-- UGOKI LINK v2 Pinned SRI Single-Block Snippet (v${PINNED_SDK_RELEASE_VERSION}) -->`,
      `<script async src="https://cdn.ugokilink.invalid/sdk/v${PINNED_SDK_RELEASE_VERSION}/ugk-loader.min.js" integrity="${sriIntegrity}" crossorigin="anonymous" data-ugk-site-key="${publicKey}" data-ugk-manifest-pubkey="${manifestPubKeyPin}" data-ugk-region="${storageRegion}" data-ugk-disclosure-sha="${disclosureRecord.contentSha256.slice(0, 16)}"></script>`,
    ].join('\n');

    const liveDo = new SiteLiveDurableObject({
      tenantId,
      siteId,
      storageRegion,
    });

    const disclosureVerificationState = input.policyUrl ? 'declared' : 'missing';

    // Persist ONLY redacted secret marker + HMAC digest in workspace state (H-20: never retain plaintext secretKey)
    const persistedWorkspace: SelfServeProvisionedWorkspace = {
      tenantId,
      siteId,
      siteRef,
      storageRegion,
      storageTier,
      retentionMonths,
      publicKey,
      secretKey: '[REDACTED_ONE_TIME_ISSUED]',
      secretKeyHash,
      keyId,
      sriIntegrity,
      installSnippetHtml,
      disclosureRecord,
      disclosureVerificationState,
      // Compliance invariant (§11.11 #1): general visitors stay `off` until disclosure is verified!
      generalTrafficEffectiveConsentMode: 'off',
      onboardingVerifyToken,
      provisionedAtMs: nowMs,
      liveDo,
    };

    this.workspaces.set(siteId, persistedWorkspace);

    // Return one-time plaintext `secretKey` ONLY to the immediate caller of `provisionWorkspace`
    return {
      ...persistedWorkspace,
      secretKey,
    };
  }

  /**
   * Marks the site's policy URL disclosure hash as verified by LINK's verifier,
   * unlocking `cookieless` collection for general visitors (§4.5 / §11.11 #1).
   */
  public verifyDisclosureOnPolicyPage(
    siteId: string,
    observedDisclosureSha256: string
  ): SelfServeProvisionedWorkspace {
    const ws = this.workspaces.get(siteId);
    if (!ws) throw new Error(`Unknown siteId: ${siteId}`);

    const matched = observedDisclosureSha256 === ws.disclosureRecord.contentSha256;
    const updated: SelfServeProvisionedWorkspace = {
      ...ws,
      disclosureVerificationState: matched ? 'verified' : ws.disclosureVerificationState,
      generalTrafficEffectiveConsentMode: matched ? 'cookieless' : 'off',
    };
    this.workspaces.set(siteId, updated);
    return updated;
  }

  /**
   * Receives the site owner's confirmation visit carrying `onboarding_verify`
   * `lab_token` into `SiteLiveDurableObject` and verifies <= 60s live visibility
   * with 0 human/billable contamination.
   */
  public recordAndConfirmOnboardingVisit(args: {
    readonly siteId: string;
    readonly pvId: string;
    readonly visitOccurredAtMs: number;
    readonly observedAtMs: number;
  }): SelfServeVerificationReceipt {
    const ws = this.workspaces.get(args.siteId);
    if (!ws) throw new Error(`Unknown siteId: ${args.siteId}`);

    ws.liveDo.ingest(
      {
        tenantId: ws.tenantId,
        siteId: ws.siteId,
        storageRegion: ws.storageRegion,
        processingRegion: ws.storageRegion,
        lane: 'standard_telemetry',
        unitId: args.pvId,
        occurredAtMs: args.visitOccurredAtMs,
        receivedAtMs: args.observedAtMs,
        visMs: 3000,
        trust: 'continuity',
        consentMode: 'cookieless',
        labToken: ws.onboardingVerifyToken,
      },
      args.observedAtMs
    );

    const liveStatus = ws.liveDo.getOnboardingVerificationStatus(
      args.observedAtMs,
      ws.onboardingVerifyToken.tokenId
    );
    const liveQuery = ws.liveDo.queryLiveEnvelope({ nowMs: args.observedAtMs });
    const humanPvs = Number(liveQuery.envelope.measures.standard_live_pvs?.value ?? 0);
    const elapsedMs = Math.max(0, args.observedAtMs - ws.provisionedAtMs);

    return {
      tenantId: ws.tenantId,
      siteId: ws.siteId,
      onboardingVerified: liveStatus.verified,
      visitVisibleWithin60s: liveStatus.within60sSla,
      totalOnboardingElapsedMs: elapsedMs,
      within10MinEndToEndSla: elapsedMs <= ONBOARDING_TOTAL_SLA_MS,
      humanTrafficContaminationCount: humanPvs,
      generalTrafficConsentMode: ws.generalTrafficEffectiveConsentMode,
      disclosureVerificationState: ws.disclosureVerificationState,
      liveStatus,
    };
  }
}

// =========================================================================
// 2. Public Pricing Schedule & Full-Lane Monthly Cost Calculator (§11.11 #7)
// =========================================================================

/**
 * Published conversion ratio from standard cumulative-register PVs to
 * event-equivalents (§11.11 #7): 1 billable PV = 5 event-equivalents.
 */
export const STANDARD_PV_TO_EVENT_EQUIVALENT_MULTIPLIER = 5;

export interface PublicPricingTier {
  readonly id: 'free' | 'growth' | 'scale';
  readonly displayName: string;
  readonly baseMonthlyUsd: number;
  readonly contactSalesOnly: false; // Strictly prohibited for foundational tiers (§11.11 #7)
  readonly includedEventEquivalentsMonthly: number;
  readonly includedVisualReplaysMonthly: number;
  readonly includedDestinationDeliveriesMonthly: number;
  readonly overagePerMillionEventEquivalentsUsd: number;
  readonly overagePer10kVisualReplaysUsd: number;
  readonly overagePerMillionDestinationDeliveriesUsd: number;
  readonly subjectDeletionCostUsd: number; // Always $0 (regulatory right, never billed per request!)
}

export interface PublicPricingSchedule {
  readonly scheduleVersion: '2026-11-v2';
  readonly currency: 'USD';
  readonly jpyReferenceRate: number;
  readonly hasContactSalesOnlyFoundationalTier: false;
  readonly cumulativeToEventFormula: {
    readonly multiplier: number;
    readonly expression: string;
    readonly explanationJa: string;
  };
  readonly freeTierBenchmark: {
    readonly freeEventEquivalentsMonthly: number;
    readonly freeVisualReplaysMonthly: number;
  };
  readonly tiers: readonly PublicPricingTier[];
}

function getLedgerFreeEvents(): number {
  const entry = getConstant('surf.free_tier_events_monthly');
  return typeof entry?.value === 'number' ? entry.value : 2_000_000;
}

function getLedgerFreeReplays(): number {
  const entry = getConstant('surf.free_tier_replays_monthly');
  return typeof entry?.value === 'number' ? entry.value : 50_000;
}

export function getPublicPricingSchedule(): PublicPricingSchedule {
  const freeEvents = getLedgerFreeEvents();
  const freeReplays = getLedgerFreeReplays();

  return {
    scheduleVersion: '2026-11-v2',
    currency: 'USD',
    jpyReferenceRate: 150,
    hasContactSalesOnlyFoundationalTier: false,
    cumulativeToEventFormula: {
      multiplier: STANDARD_PV_TO_EVENT_EQUIVALENT_MULTIPLIER,
      expression: `event_equivalents = billable_standard_pvs * ${STANDARD_PV_TO_EVENT_EQUIVALENT_MULTIPLIER} + segment_and_custom_events`,
      explanationJa: `標準計測は累積レジスタ送信のため、課金対象 1 PV を出来事 ${STANDARD_PV_TO_EVENT_EQUIVALENT_MULTIPLIER} 件相当として換算し、Segment 互換口・顧客定義イベント件数と合算して月間無料枠（${freeEvents.toLocaleString('en-US')} 件相当）を適用します。`,
    },
    freeTierBenchmark: {
      freeEventEquivalentsMonthly: freeEvents,
      freeVisualReplaysMonthly: freeReplays,
    },
    tiers: [
      {
        id: 'free',
        displayName: 'Free / Starter (公開無料枠)',
        baseMonthlyUsd: 0,
        contactSalesOnly: false,
        includedEventEquivalentsMonthly: freeEvents, // 2,000,000
        includedVisualReplaysMonthly: freeReplays, // 50,000
        includedDestinationDeliveriesMonthly: freeEvents,
        overagePerMillionEventEquivalentsUsd: 50,
        overagePer10kVisualReplaysUsd: 12,
        overagePerMillionDestinationDeliveriesUsd: 15,
        subjectDeletionCostUsd: 0,
      },
      {
        id: 'growth',
        displayName: 'Growth (従量公開)',
        baseMonthlyUsd: 99,
        contactSalesOnly: false,
        includedEventEquivalentsMonthly: 10_000_000,
        includedVisualReplaysMonthly: 150_000,
        includedDestinationDeliveriesMonthly: 10_000_000,
        overagePerMillionEventEquivalentsUsd: 35,
        overagePer10kVisualReplaysUsd: 9,
        overagePerMillionDestinationDeliveriesUsd: 10,
        subjectDeletionCostUsd: 0,
      },
      {
        id: 'scale',
        displayName: 'Scale (高トラフィック公開)',
        baseMonthlyUsd: 499,
        contactSalesOnly: false,
        includedEventEquivalentsMonthly: 100_000_000,
        includedVisualReplaysMonthly: 1_000_000,
        includedDestinationDeliveriesMonthly: 100_000_000,
        overagePerMillionEventEquivalentsUsd: 18,
        overagePer10kVisualReplaysUsd: 6,
        overagePerMillionDestinationDeliveriesUsd: 6,
        subjectDeletionCostUsd: 0,
      },
    ],
  };
}

export interface MonthlyUsageEstimateInput {
  readonly standardBillablePvsMonthly: number;
  readonly compatAndCustomEventsMonthly: number;
  readonly destinationDeliveriesMonthly: number;
  readonly visualReplaysMonthly: number;
  readonly subjectDeletionRequestsMonthly: number;
  readonly storageTier?: StorageTier;
  readonly preferredTierId?: PublicPricingTier['id'];
}

export interface MonthlyCostBreakdown {
  readonly tierId: PublicPricingTier['id'];
  readonly tierDisplayName: string;
  readonly totalEventEquivalents: number;
  readonly standardPvEventEquivalents: number;
  readonly compatAndCustomEvents: number;
  readonly billableOverageEventEquivalents: number;
  readonly billableOverageVisualReplays: number;
  readonly billableOverageDestinationDeliveries: number;
  readonly lineItemsUsd: {
    readonly basePlatform: number;
    readonly telemetryAndEventsOverage: number;
    readonly destinationDeliveriesOverage: number;
    readonly visualReplaysOverage: number;
    readonly subjectDeletions: number;
    readonly tier3CustomerInfraCredit: number;
  };
  readonly estimatedMonthlyUsd: number;
  readonly estimatedMonthlyJpy: number;
  readonly formulaApplied: string;
  readonly storageTierNote: string;
}

function priceForTier(
  tier: PublicPricingTier,
  input: MonthlyUsageEstimateInput,
  schedule: PublicPricingSchedule
): MonthlyCostBreakdown {
  const stdPvs = Math.max(0, Math.floor(input.standardBillablePvsMonthly));
  const customEvents = Math.max(0, Math.floor(input.compatAndCustomEventsMonthly));
  const deliveries = Math.max(0, Math.floor(input.destinationDeliveriesMonthly));
  const replays = Math.max(0, Math.floor(input.visualReplaysMonthly));
  const deletions = Math.max(0, Math.floor(input.subjectDeletionRequestsMonthly));

  const standardPvEventEquivalents =
    stdPvs * STANDARD_PV_TO_EVENT_EQUIVALENT_MULTIPLIER;
  const totalEventEquivalents = standardPvEventEquivalents + customEvents;

  const billableOverageEventEquivalents = Math.max(
    0,
    totalEventEquivalents - tier.includedEventEquivalentsMonthly
  );
  const billableOverageVisualReplays = Math.max(
    0,
    replays - tier.includedVisualReplaysMonthly
  );
  const billableOverageDestinationDeliveries = Math.max(
    0,
    deliveries - tier.includedDestinationDeliveriesMonthly
  );

  const telemetryAndEventsOverage = Number(
    (
      (billableOverageEventEquivalents / 1_000_000) *
      tier.overagePerMillionEventEquivalentsUsd
    ).toFixed(2)
  );
  const destinationDeliveriesOverage = Number(
    (
      (billableOverageDestinationDeliveries / 1_000_000) *
      tier.overagePerMillionDestinationDeliveriesUsd
    ).toFixed(2)
  );
  const visualReplaysOverage = Number(
    (
      (billableOverageVisualReplays / 10_000) *
      tier.overagePer10kVisualReplaysUsd
    ).toFixed(2)
  );
  const subjectDeletions = Number(
    (deletions * tier.subjectDeletionCostUsd).toFixed(2)
  );

  // §5.12 honest cost transparency: Tier 3 customer-hosted SoR offsets marginal storage/ingest cost only
  const storageTier = input.storageTier ?? 'tier1_link_managed';
  const tier3CreditRaw =
    storageTier === 'tier3_customer_sor'
      ? Math.min(telemetryAndEventsOverage * 0.15, telemetryAndEventsOverage)
      : 0;
  const tier3CustomerInfraCredit = Number((-tier3CreditRaw).toFixed(2));

  const estimatedMonthlyUsd = Math.max(
    0,
    Number(
      (
        tier.baseMonthlyUsd +
        telemetryAndEventsOverage +
        destinationDeliveriesOverage +
        visualReplaysOverage +
        subjectDeletions +
        tier3CustomerInfraCredit
      ).toFixed(2)
    )
  );

  return {
    tierId: tier.id,
    tierDisplayName: tier.displayName,
    totalEventEquivalents,
    standardPvEventEquivalents,
    compatAndCustomEvents: customEvents,
    billableOverageEventEquivalents,
    billableOverageVisualReplays,
    billableOverageDestinationDeliveries,
    lineItemsUsd: {
      basePlatform: tier.baseMonthlyUsd,
      telemetryAndEventsOverage,
      destinationDeliveriesOverage,
      visualReplaysOverage,
      subjectDeletions,
      tier3CustomerInfraCredit,
    },
    estimatedMonthlyUsd,
    estimatedMonthlyJpy: Math.round(estimatedMonthlyUsd * schedule.jpyReferenceRate),
    formulaApplied: schedule.cumulativeToEventFormula.expression,
    storageTierNote:
      storageTier === 'tier3_customer_sor'
        ? 'Tier 3 customer-hosted SoR reduces marginal LINK storage/ingest cost (15% overage credit); compute/ML/CRAWL remain usage-metered (§5.12).'
        : 'Tier 1/2 LINK-managed storage included with transparent near-cost overage.',
  };
}

/**
 * Public monthly cost calculator across ALL lanes (standard telemetry,
 * Segment-compatible & custom events, destination deliveries, visual replays,
 * and subject deletions). When `preferredTierId` is omitted, automatically
 * selects the lowest-cost public tier.
 */
export function calculateMonthlyCostEstimate(
  input: MonthlyUsageEstimateInput
): {
  readonly recommended: MonthlyCostBreakdown;
  readonly allTiers: readonly MonthlyCostBreakdown[];
  readonly schedule: PublicPricingSchedule;
} {
  const schedule = getPublicPricingSchedule();
  const allTiers = schedule.tiers.map((tier) => priceForTier(tier, input, schedule));

  let recommended = allTiers[0]!;
  if (input.preferredTierId) {
    const match = allTiers.find((t) => t.tierId === input.preferredTierId);
    if (match) recommended = match;
  } else {
    for (const candidate of allTiers) {
      if (candidate.estimatedMonthlyUsd < recommended.estimatedMonthlyUsd) {
        recommended = candidate;
      }
    }
  }

  return {
    recommended,
    allTiers,
    schedule,
  };
}
