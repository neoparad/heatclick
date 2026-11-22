/**
 * UGOKI LINK v2 — Edge Decision Context Worker (`workers/link-decision`)
 *
 * Implements Master Architecture v2 §9.1 & §10.1–§10.2:
 *   - Control state MUST come from a strongly-consistent store (`StrongControlStore`);
 *     KV / eventually-consistent backends are PHYSICALLY REJECTED (`ForbiddenKvControlStoreError`).
 *   - 1 decision context call per PV returning:
 *       allocation, consent tier, short-lived display lease, voucher token, kill stamps,
 *       active config version, and sealed provisional visitor ticket (only when consent permits).
 *   - Edge-assumed consent tier > browser-confirmed consent tier MUST be 0 (monotonicity monitor).
 *   - Zone Worker 1-decision-ID = first-1-PV binding prevents cached HTML from leaking one draw to 2 visitors!
 *   - Control store unreachable or > 5s read -> withholds display lease (fail-closed!).
 */

import crypto from 'node:crypto';
import {
  consentModeToTier,
  type ConsentMode,
  type ConsentPurpose,
  type ConsentTier,
  type IdentityQuality,
  type TrafficClass,
} from '@/packages/contract/schema';
import { canonicalJson } from '@/packages/contract/response';
import {
  allocateDecision,
  type AllocationOutcome,
  type AllocatorConfig,
} from '@/lib/link/allocator';
import { CONTROL_UNREACHABLE_FAIL_CLOSED_MS } from '@/lib/link/delivery';

// =========================================================================
// 1. Strongly-Consistent Control Store Interface (Physical Ban on KV!)
// =========================================================================

export type ControlStoreConsistencyKind = 'durable_object_strong' | 'postgres_serializable' | 'kv_eventual';

export interface TenantControlRecord {
  readonly tenantId: string;
  readonly siteId: string;
  readonly configVersion: string;
  readonly configExpiresAtMs: number;
  readonly minAcceptedConfigVersion: string;
  readonly killedCampaignIds: ReadonlyArray<string>;
  readonly killStampVersion: number;
  readonly siteKilled: boolean;
  readonly allocatorConfig: AllocatorConfig;
}

export interface StrongControlStore {
  readonly backendName: string;
  readonly consistency: ControlStoreConsistencyKind;
  readTenantControl(
    tenantId: string,
    siteId: string
  ): {
    readonly reachable: boolean;
    readonly readLatencyMs: number;
    readonly record: TenantControlRecord | null;
  };
}

export class ForbiddenKvControlStoreError extends Error {
  constructor(backendName: string) {
    super(
      `Control store "${backendName}" uses eventually-consistent KV; KV is strictly forbidden on the delivery control plane (§10.1 — use Durable Object or transactional SQL)`
    );
    this.name = 'ForbiddenKvControlStoreError';
  }
}

export function assertStrongConsistentControlStore(store: StrongControlStore): void {
  if (store.consistency === 'kv_eventual' || /\bkv\b/i.test(store.backendName)) {
    throw new ForbiddenKvControlStoreError(store.backendName);
  }
}

// =========================================================================
// 2. Consent Monotonicity & Zone First-PV Binding Types
// =========================================================================

const CONSENT_TIER_RANK: Readonly<Record<ConsentTier, number>> = {
  T0: 0,
  T1: 1,
  T2: 2,
};

export interface EdgeDecisionRequest {
  readonly tenantId: string;
  readonly siteId: string;
  /** Supplied by browser on direct path; omitted when Zone Worker pre-draws before HTML render. */
  readonly pvId?: string;
  readonly existingVisitorId?: string;
  readonly sessionId?: string;
  readonly consentMode: ConsentMode;
  readonly purposes: ReadonlyArray<ConsentPurpose>;
  readonly identityQuality: IdentityQuality;
  readonly trafficClass: TrafficClass;
  readonly urlId: string;
  readonly pageId: string;
  readonly viewportClass: 'mobile' | 'tablet' | 'desktop';
  readonly pointerType: 'coarse' | 'fine' | 'none';
  readonly leaseTtlMs?: number;
  readonly nowMs?: number;
}

export interface SealedProvisionalVisitorTicket {
  readonly ticketId: string;
  readonly sealedCiphertextBase64Url: string;
  readonly singleUse: true;
  readonly expiresAtMs: number;
}

export interface EdgeDecisionContextResponse {
  readonly status: 'ok' | 'fail_closed_no_lease' | 'config_expired_stop_delivery';
  readonly decisionContextId: string;
  readonly tenantId: string;
  readonly siteId: string;
  /** Bound 1-PV context identifier (`req.pvId` on direct path, or `zone_<decisionContextId>` pre-draw). */
  readonly pvId: string | null;
  readonly configVersion: string | null;
  readonly killStampVersion: number;
  readonly consentTier: ConsentTier;
  readonly displayLease: {
    readonly leaseId: string;
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvId: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number;
    readonly signatureBase64Url: string;
  } | null;
  readonly voucherToken: string | null;
  readonly sealedProvisionalVisitorTicket: SealedProvisionalVisitorTicket | null;
  readonly allocation: AllocationOutcome | null;
  readonly killedCampaignIds: ReadonlyArray<string>;
  readonly reason: string;
}

interface DecisionContextBindingRecord {
  readonly tenantId: string;
  readonly siteId: string;
  boundPvId: string | null;
}

export class EdgeDecisionWorker {
  private readonly controlStore: StrongControlStore;
  private readonly signingPrivateKeyPem: string;
  private readonly signingPublicKeyPem: string;
  private readonly ticketKey32: Buffer;

  /** Zone Worker & 1-PV `(tenantId, siteId, pvId)` bindings (§9.1 + [M-16]). */
  private readonly zoneDecisionPvBindings = new Map<string, DecisionContextBindingRecord>();
  /** Consumed single-use provisional visitor tickets. */
  private readonly consumedTicketIds = new Set<string>();
  /** Tracks edge-vs-browser consent overshoots (`edgeTier > browserTier` MUST stay 0!). */
  private consentOvershootCount = 0;
  private edgePreDrawDisabledDueToOvershoot = false;

  constructor(params: {
    readonly controlStore: StrongControlStore;
    readonly signingPrivateKeyPem: string;
    readonly signingPublicKeyPem: string;
    readonly ticketSecret32Bytes?: Buffer;
  }) {
    // Physical runtime enforcement: KV stores are rejected at boot!
    assertStrongConsistentControlStore(params.controlStore);
    this.controlStore = params.controlStore;
    this.signingPrivateKeyPem = params.signingPrivateKeyPem;
    this.signingPublicKeyPem = params.signingPublicKeyPem;
    this.ticketKey32 = params.ticketSecret32Bytes ?? crypto.randomBytes(32);
  }

  public getSigningPublicKeyPem(): string {
    return this.signingPublicKeyPem;
  }

  public getConsentOvershootCount(): number {
    return this.consentOvershootCount;
  }

  public isEdgePreDrawDisabled(): boolean {
    return this.edgePreDrawDisabledDueToOvershoot;
  }

  /**
   * Monitors §9.1 gate: edge-assumed consent tier MUST NEVER exceed browser-confirmed tier.
   * Any single overshoot disables edge pre-draw immediately.
   */
  public recordEdgeVsBrowserConsentCheck(
    edgeAssumedTier: ConsentTier,
    browserConfirmedTier: ConsentTier
  ): { readonly violation: boolean; readonly totalOvershoots: number } {
    if (CONSENT_TIER_RANK[edgeAssumedTier] > CONSENT_TIER_RANK[browserConfirmedTier]) {
      this.consentOvershootCount += 1;
      this.edgePreDrawDisabledDueToOvershoot = true;
      return { violation: true, totalOvershoots: this.consentOvershootCount };
    }
    return { violation: false, totalOvershoots: this.consentOvershootCount };
  }

  /**
   * §9.1 + [M-16] Zone Worker invariant: binds a pre-drawn `decisionContextId` strictly
   * to `(tenantId, siteId)` and the FIRST `pvId`.
   * Rejects any cross-tenant/cross-site probe or any second `pvId` (cached HTML reuse!).
   */
  public bindZoneDecisionToFirstPv(
    decisionContextId: string,
    pvId: string,
    context?: { readonly tenantId: string; readonly siteId: string }
  ): { readonly bound: boolean; readonly boundPvId: string; readonly reason: string } {
    if (!pvId || pvId.trim().length === 0) {
      return { bound: false, boundPvId: '', reason: 'INVALID_EMPTY_PV_ID' };
    }
    const existing = this.zoneDecisionPvBindings.get(decisionContextId);
    if (!existing) {
      this.zoneDecisionPvBindings.set(decisionContextId, {
        tenantId: context?.tenantId ?? '',
        siteId: context?.siteId ?? '',
        boundPvId: pvId,
      });
      return { bound: true, boundPvId: pvId, reason: 'FIRST_PV_BOUND' };
    }
    if (context) {
      if (
        (existing.tenantId && existing.tenantId !== context.tenantId) ||
        (existing.siteId && existing.siteId !== context.siteId)
      ) {
        return {
          bound: false,
          boundPvId: existing.boundPvId ?? '',
          reason: 'DECISION_CONTEXT_TENANT_OR_SITE_MISMATCH',
        };
      }
    }
    if (existing.boundPvId === null) {
      existing.boundPvId = pvId;
      return { bound: true, boundPvId: pvId, reason: 'FIRST_PV_BOUND' };
    }
    if (existing.boundPvId === pvId) {
      return { bound: true, boundPvId: existing.boundPvId, reason: 'IDEMPOTENT_SAME_PV' };
    }
    return {
      bound: false,
      boundPvId: existing.boundPvId,
      reason: 'ZONE_DECISION_ALREADY_BOUND_TO_DIFFERENT_PV',
    };
  }

  /**
   * [M-16] Cryptographically verifies `voucherToken` (and optional `displayLease`) and enforces
   * strict 1-PV single-context `(tenant_id, site_id, pv_id)` binding.
   */
  public verifyDecisionVoucherForPv(params: {
    readonly voucherToken: string;
    readonly displayLease?: EdgeDecisionContextResponse['displayLease'];
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvId: string;
    readonly nowMs?: number;
  }): { readonly valid: boolean; readonly decisionContextId?: string; readonly reason: string } {
    const nowMs = params.nowMs ?? Date.now();
    if (!params.voucherToken.startsWith('vch_')) {
      return { valid: false, reason: 'MALFORMED_VOUCHER_PREFIX' };
    }
    const rawRest = params.voucherToken.slice(4);
    const dotIdx = rawRest.indexOf('.');
    if (dotIdx <= 0 || dotIdx === rawRest.length - 1) {
      return { valid: false, reason: 'MALFORMED_VOUCHER_STRUCTURE' };
    }

    let payloadText: string;
    let sigBuf: Buffer;
    let parsed: {
      decisionContextId?: string;
      tenantId?: string;
      siteId?: string;
      pvId?: string;
      configVersion?: string;
      issuedAtMs?: number;
      expiresAtMs?: number;
      singlePv?: boolean;
    };
    try {
      payloadText = Buffer.from(rawRest.slice(0, dotIdx), 'base64url').toString('utf8');
      sigBuf = Buffer.from(rawRest.slice(dotIdx + 1), 'base64url');
      parsed = JSON.parse(payloadText) as typeof parsed;
    } catch {
      return { valid: false, reason: 'MALFORMED_VOUCHER_ENCODING' };
    }

    const sigOk = crypto.verify(
      null,
      Buffer.from(payloadText, 'utf8'),
      this.signingPublicKeyPem,
      sigBuf
    );
    if (!sigOk) {
      return { valid: false, reason: 'INVALID_VOUCHER_SIGNATURE' };
    }

    if (typeof parsed.expiresAtMs === 'number' && nowMs >= parsed.expiresAtMs) {
      return { valid: false, reason: 'VOUCHER_EXPIRED' };
    }

    // Strict (tenant_id, site_id, pv_id) single-context check
    if (parsed.tenantId !== params.tenantId || parsed.siteId !== params.siteId) {
      return { valid: false, reason: 'VOUCHER_TENANT_OR_SITE_MISMATCH' };
    }

    const dctxId = parsed.decisionContextId ?? '';
    const isZonePreDraw = typeof parsed.pvId === 'string' && parsed.pvId.startsWith('zone_');
    if (!isZonePreDraw && parsed.pvId !== params.pvId) {
      return { valid: false, reason: 'VOUCHER_PV_ID_MISMATCH' };
    }

    const bindRes = this.bindZoneDecisionToFirstPv(dctxId, params.pvId, {
      tenantId: params.tenantId,
      siteId: params.siteId,
    });
    if (!bindRes.bound) {
      return { valid: false, reason: bindRes.reason };
    }

    if (params.displayLease) {
      const lease = params.displayLease;
      if (
        lease.tenantId !== params.tenantId ||
        lease.siteId !== params.siteId ||
        (!isZonePreDraw && lease.pvId !== params.pvId)
      ) {
        return { valid: false, reason: 'DISPLAY_LEASE_CONTEXT_MISMATCH' };
      }
      if (nowMs >= lease.expiresAtMs) {
        return { valid: false, reason: 'DISPLAY_LEASE_EXPIRED' };
      }
      const ctrl = this.controlStore.readTenantControl(params.tenantId, params.siteId);
      if (!ctrl.reachable || !ctrl.record) {
        return { valid: false, reason: 'CONTROL_UNREACHABLE_DURING_LEASE_VERIFY' };
      }
      const expectedLeaseUnsigned = canonicalJson({
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        siteId: lease.siteId,
        pvId: lease.pvId,
        decisionContextId: dctxId,
        killStampVersion: ctrl.record.killStampVersion,
        issuedAtMs: lease.issuedAtMs,
        expiresAtMs: lease.expiresAtMs,
      });
      const leaseSigOk = crypto.verify(
        null,
        Buffer.from(expectedLeaseUnsigned, 'utf8'),
        this.signingPublicKeyPem,
        Buffer.from(lease.signatureBase64Url, 'base64url')
      );
      if (!leaseSigOk) {
        return { valid: false, reason: 'INVALID_DISPLAY_LEASE_SIGNATURE' };
      }
    }

    return { valid: true, decisionContextId: dctxId, reason: 'VERIFIED_SINGLE_PV_CONTEXT' };
  }

  /**
   * [M-16] Unseals and single-use consumes a provisional visitor ticket bound via AEAD AAD
   * to `(tenantId, siteId, pvId)`.
   */
  public consumeProvisionalVisitorTicket(params: {
    readonly ticket: SealedProvisionalVisitorTicket;
    readonly tenantId: string;
    readonly siteId: string;
    readonly pvId: string;
    readonly nowMs?: number;
  }): { readonly valid: boolean; readonly visitorId?: string; readonly reason: string } {
    const nowMs = params.nowMs ?? Date.now();
    if (this.consumedTicketIds.has(params.ticket.ticketId)) {
      return { valid: false, reason: 'PROVISIONAL_TICKET_ALREADY_CONSUMED' };
    }
    if (nowMs >= params.ticket.expiresAtMs) {
      return { valid: false, reason: 'PROVISIONAL_TICKET_EXPIRED' };
    }
    try {
      const combined = Buffer.from(params.ticket.sealedCiphertextBase64Url, 'base64url');
      if (combined.byteLength < 29) {
        return { valid: false, reason: 'MALFORMED_TICKET_CIPHERTEXT' };
      }
      const iv = combined.subarray(0, 12);
      const tag = combined.subarray(12, 28);
      const ciphertext = combined.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.ticketKey32, iv);
      decipher.setAAD(Buffer.from(`${params.tenantId}:${params.siteId}:${params.pvId}`, 'utf8'));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plain) as {
        visitorId: string;
        tenantId: string;
        siteId: string;
        pvId: string;
        singleUse: boolean;
      };
      if (
        parsed.tenantId !== params.tenantId ||
        parsed.siteId !== params.siteId ||
        parsed.pvId !== params.pvId
      ) {
        return { valid: false, reason: 'TICKET_CONTEXT_MISMATCH' };
      }
      this.consumedTicketIds.add(params.ticket.ticketId);
      return { valid: true, visitorId: parsed.visitorId, reason: 'CONSUMED_OK' };
    } catch {
      return { valid: false, reason: 'TICKET_AEAD_CONTEXT_MISMATCH_OR_TAMPERED' };
    }
  }

  /**
   * Single PV edge decision context handler.
   */
  public decide(req: EdgeDecisionRequest): EdgeDecisionContextResponse {
    assertStrongConsistentControlStore(this.controlStore);

    const nowMs = req.nowMs ?? Date.now();
    const consentTier = consentModeToTier(req.consentMode);
    const decisionContextId = `dctx_${crypto.randomBytes(10).toString('hex')}`;

    // Single read from strongly-consistent control store
    const ctrl = this.controlStore.readTenantControl(req.tenantId, req.siteId);
    if (!ctrl.reachable || ctrl.readLatencyMs > CONTROL_UNREACHABLE_FAIL_CLOSED_MS || !ctrl.record) {
      return {
        status: 'fail_closed_no_lease',
        decisionContextId,
        tenantId: req.tenantId,
        siteId: req.siteId,
        pvId: req.pvId ?? null,
        configVersion: null,
        killStampVersion: 0,
        consentTier,
        displayLease: null,
        voucherToken: null,
        sealedProvisionalVisitorTicket: null,
        allocation: null,
        killedCampaignIds: [],
        reason: 'CONTROL_STORE_UNREACHABLE_OR_OVER_5S_NO_LEASE',
      };
    }

    const rec = ctrl.record;

    // Expired config bundle (> 24h) -> delivery fails CLOSED (stops display), telemetry stays open (§10.1)
    if (nowMs >= rec.configExpiresAtMs) {
      return {
        status: 'config_expired_stop_delivery',
        decisionContextId,
        tenantId: req.tenantId,
        siteId: req.siteId,
        pvId: req.pvId ?? null,
        configVersion: rec.configVersion,
        killStampVersion: rec.killStampVersion,
        consentTier,
        displayLease: null,
        voucherToken: null,
        sealedProvisionalVisitorTicket: null,
        allocation: null,
        killedCampaignIds: rec.killedCampaignIds,
        reason: 'CONFIG_BUNDLE_EXPIRED_DELIVERY_FAIL_CLOSED',
      };
    }

    if (rec.siteKilled) {
      return {
        status: 'fail_closed_no_lease',
        decisionContextId,
        tenantId: req.tenantId,
        siteId: req.siteId,
        pvId: req.pvId ?? null,
        configVersion: rec.configVersion,
        killStampVersion: rec.killStampVersion,
        consentTier,
        displayLease: null,
        voucherToken: null,
        sealedProvisionalVisitorTicket: null,
        allocation: null,
        killedCampaignIds: rec.killedCampaignIds,
        reason: 'SITE_KILL_STAMP_ACTIVE',
      };
    }

    const effectivePvId = req.pvId ?? `zone_${decisionContextId}`;
    this.zoneDecisionPvBindings.set(decisionContextId, {
      tenantId: req.tenantId,
      siteId: req.siteId,
      boundPvId: req.pvId ?? null,
    });

    // Mint provisional visitor ID ticket ONLY when consent permits persistent visitor IDs (T2 & not off/cookieless)
    let provisionalVisitorId = req.existingVisitorId;
    let sealedTicket: SealedProvisionalVisitorTicket | null = null;
    if (!provisionalVisitorId && (req.consentMode === 'full' || req.consentMode === 'stats_exempt')) {
      provisionalVisitorId = `vis_${crypto.randomBytes(12).toString('hex')}`;
      sealedTicket = this.sealProvisionalVisitorTicket(
        provisionalVisitorId,
        req.tenantId,
        req.siteId,
        effectivePvId,
        decisionContextId,
        nowMs
      );
    }

    const allocation = allocateDecision(
      {
        tenant_id: req.tenantId,
        site_id: req.siteId,
        pv_id: effectivePvId,
        available_units: {
          visitor: provisionalVisitorId,
          session: req.sessionId,
          page_view: effectivePvId,
          page: req.pageId,
        },
        identity_quality: req.identityQuality,
        consent_mode: req.consentMode,
        purposes: req.purposes,
        traffic_class: req.trafficClass,
        url_id: req.urlId,
        page_id: req.pageId,
        viewport_class: req.viewportClass,
        pointer_type: req.pointerType,
        now_ms: nowMs,
      },
      rec.allocatorConfig
    );

    const leaseTtl = Math.min(Math.max(1000, req.leaseTtlMs ?? 5000), 10 * 60 * 1000);
    const leaseUnsigned = {
      leaseId: `lse_${crypto.randomBytes(8).toString('hex')}`,
      tenantId: req.tenantId,
      siteId: req.siteId,
      pvId: effectivePvId,
      decisionContextId,
      killStampVersion: rec.killStampVersion,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + leaseTtl,
    };
    const leaseSig = crypto
      .sign(null, Buffer.from(canonicalJson(leaseUnsigned), 'utf8'), this.signingPrivateKeyPem)
      .toString('base64url');

    const voucherPayload = canonicalJson({
      decisionContextId,
      tenantId: req.tenantId,
      siteId: req.siteId,
      pvId: effectivePvId,
      configVersion: rec.configVersion,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + leaseTtl,
      singlePv: true,
    });
    const voucherSig = crypto
      .sign(null, Buffer.from(voucherPayload, 'utf8'), this.signingPrivateKeyPem)
      .toString('base64url');
    const voucherToken = `vch_${Buffer.from(voucherPayload, 'utf8').toString('base64url')}.${voucherSig}`;

    return {
      status: 'ok',
      decisionContextId,
      tenantId: req.tenantId,
      siteId: req.siteId,
      pvId: effectivePvId,
      configVersion: rec.configVersion,
      killStampVersion: rec.killStampVersion,
      consentTier,
      displayLease: {
        leaseId: leaseUnsigned.leaseId,
        tenantId: leaseUnsigned.tenantId,
        siteId: leaseUnsigned.siteId,
        pvId: leaseUnsigned.pvId,
        issuedAtMs: leaseUnsigned.issuedAtMs,
        expiresAtMs: leaseUnsigned.expiresAtMs,
        signatureBase64Url: leaseSig,
      },
      voucherToken,
      sealedProvisionalVisitorTicket: sealedTicket,
      allocation,
      killedCampaignIds: rec.killedCampaignIds,
      reason: 'DECISION_ISSUED',
    };
  }

  private sealProvisionalVisitorTicket(
    visitorId: string,
    tenantId: string,
    siteId: string,
    pvId: string,
    decisionContextId: string,
    nowMs: number
  ): SealedProvisionalVisitorTicket {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.ticketKey32, iv);
    cipher.setAAD(Buffer.from(`${tenantId}:${siteId}:${pvId}`, 'utf8'));
    const plaintext = JSON.stringify({
      visitorId,
      tenantId,
      siteId,
      pvId,
      decisionContextId,
      singleUse: true,
      issuedAtMs: nowMs,
    });
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, tag, enc]).toString('base64url');

    return {
      ticketId: `tkt_${crypto.randomBytes(8).toString('hex')}`,
      sealedCiphertextBase64Url: combined,
      singleUse: true,
      expiresAtMs: nowMs + 120_000,
    };
  }
}
