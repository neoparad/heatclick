/**
 * UGOKI LINK v2 — OEM Partner Add-On, Sub-Tenant Provisioning & Isolation Manager (§11.8 / D-15)
 *
 * Implements Master Spec §11.8, §11.11 #8, §5.12 & §14 Decision 15:
 * - Upper-tier plan add-on gated behind `D-15` + legal sign-off (default `not_entitled`)
 * - R3 child-tenant provisioning under strict per-child `TenantDelegationPolicy`
 * - Short-lived (<= 15 min) `act`-claim child token exchange via `IdentityKeyRegistry`
 * - Structural guarantee: NEVER shares OEM accounts or credit pools with CRAWL (§11.8)
 * - Strictly refuses visual replay (tier 3) viewing for any OEM parent principal (§11.11 #8)
 * - Forces external-party (`< 10` suppression + non-overlapping calendar windows +
 *   complementary differencing suppression) on any OEM parent export of child data
 */

import crypto from 'node:crypto';
import { requireDecisionEntitled } from '../../../packages/contract/ledgers';
import {
  AuditLogStore,
  IdentityKeyRegistry,
  MAX_OEM_EXCHANGED_TTL_SEC,
  type OemExchangedTokenClaims,
  type Scope,
  type TenantDelegationPolicy,
  type TenantRecord,
  type VerifiedPrincipal,
} from '../auth';
import {
  WarehouseBatchExporter,
  type ExportableAnalyticsRow,
  type WarehouseExportResult,
  type WarehouseTargetKind,
} from '../export';
import type { DataRegion } from '../../../workers/link-wal';

export interface OemEntitlementOptions {
  readonly decision15ApprovedOverride?: boolean;
  readonly legalSignOffOverride?: boolean;
}

export interface OemPartnerRegistration {
  readonly orgId: string;
  readonly name: string;
  readonly managementTenantId: string;
  readonly oemLegalSignoffRef: string;
  readonly delegableScopes: readonly Scope[];
  /** Structural invariant (§11.8): MUST remain false — CRAWL OEM accounts/credits are NEVER shared. */
  readonly shareCrawlOemAccount?: boolean;
  readonly shareCrawlCreditPool?: boolean;
}

export interface ProvisionChildTenantInput {
  readonly rawOemKey: string;
  readonly childTenantId?: string;
  readonly childName: string;
  readonly planScopes: readonly Scope[];
  readonly delegationPolicy: TenantDelegationPolicy;
  readonly actorSub: string;
  readonly now?: Date;
}

export interface OemChildUsageEntry {
  readonly childTenantId: string;
  readonly orgId: string;
  readonly billableStandardPvs: number;
  readonly customEvents: number;
  readonly destinationDeliveries: number;
  readonly visualReplays: number;
  readonly crawlCreditsShared: 0; // Always 0 (§11.8)
}

export type OemOperationOutcome<T> =
  | { readonly ok: true; readonly status: 'ok'; readonly data: T }
  | {
      readonly ok: false;
      readonly status: 'not_entitled' | 'forbidden' | 'not_found' | 'invalid_request';
      readonly httpStatus: 400 | 401 | 403 | 404;
      readonly reason: string;
    };

export class CrawlOemSeparationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CrawlOemSeparationError';
  }
}

export class OemPartnerManager {
  private readonly childUsage = new Map<string, OemChildUsageEntry>();
  private readonly oemWarehouseExporter = new WarehouseBatchExporter();

  public constructor(
    private readonly registry: IdentityKeyRegistry,
    private readonly auditLog: AuditLogStore = new AuditLogStore(),
    private readonly entitlementOptions: OemEntitlementOptions = {}
  ) {}

  private checkD15Entitled(): { readonly entitled: boolean; readonly reason: string } {
    if (
      this.entitlementOptions.decision15ApprovedOverride !== undefined &&
      this.entitlementOptions.legalSignOffOverride !== undefined
    ) {
      const ok =
        this.entitlementOptions.decision15ApprovedOverride &&
        this.entitlementOptions.legalSignOffOverride;
      return {
        entitled: ok,
        reason: ok ? 'entitled' : 'decision_15_and_legal_signoff_required',
      };
    }
    const check = requireDecisionEntitled('D-15', { enforceLegalSignOff: true });
    return {
      entitled: check.entitled,
      reason: check.entitled ? 'entitled' : 'decision_15_and_legal_signoff_required',
    };
  }

  /**
   * Registers an OEM partner organisation + management tenant + `ugk_oem_live_*` key.
   * Refuses any attempt to share OEM accounts or credit pools with CRAWL (§11.8).
   */
  public registerOemPartner(
    input: OemPartnerRegistration,
    now: Date = new Date()
  ): OemOperationOutcome<{
    readonly orgId: string;
    readonly managementTenantId: string;
    readonly rawOemKey: string;
    readonly oemKeyId: string;
    readonly crawlOemShared: false;
    readonly crawlCreditsShared: false;
  }> {
    if (input.shareCrawlOemAccount || input.shareCrawlCreditPool) {
      throw new CrawlOemSeparationError(
        'CRAWL_OEM_SHARING_FORBIDDEN: LINK OEM accounts and credit pools MUST NEVER be shared with CRAWL (§11.8)'
      );
    }

    const d15 = this.checkD15Entitled();
    if (!d15.entitled) {
      return {
        ok: false,
        status: 'not_entitled',
        httpStatus: 403,
        reason: d15.reason,
      };
    }

    if (!input.oemLegalSignoffRef || input.oemLegalSignoffRef.trim().length === 0) {
      return {
        ok: false,
        status: 'invalid_request',
        httpStatus: 400,
        reason: 'oem_legal_signoff_ref_required',
      };
    }

    this.registry.registerOrg({
      orgId: input.orgId,
      type: 'oem',
      name: input.name,
      oemLegalSignoffRef: input.oemLegalSignoffRef,
      createdAt: now.toISOString(),
    });

    this.registry.registerTenant({
      tenantId: input.managementTenantId,
      orgId: input.orgId,
      name: `${input.name} (OEM Management)`,
      planScopes: ['oem:manage', 'usage:read', ...input.delegableScopes],
      delegationPolicy: {
        allowedOemScopes: [],
        maxExchangedTokenTtlSec: MAX_OEM_EXCHANGED_TTL_SEC,
        allowOemAccess: false,
      },
      revocationEpoch: 1,
      createdAt: now.toISOString(),
    });

    const issued = this.registry.issueOemKey({
      orgId: input.orgId,
      managementTenantId: input.managementTenantId,
      delegableScopes: input.delegableScopes,
      now,
    });

    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: input.managementTenantId,
      targetTenantId: input.managementTenantId,
      principalId: `oem_org:${input.orgId}`,
      credentialKind: 'ugk_oem',
      credentialId: issued.record.keyId,
      action: 'oem.partner.register',
      riskClass: 'R3',
      resourceType: 'oem_org',
      resourceId: input.orgId,
      outcome: 'allow',
      reason: 'oem_partner_registered_isolated_from_crawl',
    });

    return {
      ok: true,
      status: 'ok',
      data: {
        orgId: input.orgId,
        managementTenantId: input.managementTenantId,
        rawOemKey: issued.rawKey,
        oemKeyId: issued.record.keyId,
        crawlOemShared: false,
        crawlCreditsShared: false,
      },
    };
  }

  /**
   * Provisions a child tenant (R3) owned by the verified OEM organisation with
   * strict per-child `delegation_policy` and isolated usage ledger.
   */
  public provisionChildTenant(
    input: ProvisionChildTenantInput
  ): OemOperationOutcome<TenantRecord> {
    const now = input.now ?? new Date();
    const d15 = this.checkD15Entitled();
    if (!d15.entitled) {
      return {
        ok: false,
        status: 'not_entitled',
        httpStatus: 403,
        reason: d15.reason,
      };
    }

    const verified = this.registry.verifyOemManagementKey(input.rawOemKey, now);
    if (!verified.ok) {
      return {
        ok: false,
        status: 'forbidden',
        httpStatus: verified.httpStatus === 429 ? 403 : verified.httpStatus,
        reason: verified.reason,
      };
    }

    const childTenantId =
      input.childTenantId ?? `ten_child_${crypto.randomBytes(6).toString('hex')}`;

    const clampedPolicy: TenantDelegationPolicy = {
      allowedOemScopes: [...input.delegationPolicy.allowedOemScopes],
      maxExchangedTokenTtlSec: Math.min(
        MAX_OEM_EXCHANGED_TTL_SEC,
        Math.max(60, input.delegationPolicy.maxExchangedTokenTtlSec)
      ),
      allowOemAccess: input.delegationPolicy.allowOemAccess,
    };

    const childRecord: TenantRecord = {
      tenantId: childTenantId,
      orgId: verified.principal.orgId,
      name: input.childName,
      planScopes: [...input.planScopes],
      delegationPolicy: clampedPolicy,
      revocationEpoch: 1,
      createdAt: now.toISOString(),
    };

    this.registry.registerTenant(childRecord);
    this.childUsage.set(childTenantId, {
      childTenantId,
      orgId: verified.principal.orgId,
      billableStandardPvs: 0,
      customEvents: 0,
      destinationDeliveries: 0,
      visualReplays: 0,
      crawlCreditsShared: 0,
    });

    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: verified.principal.tenantId,
      targetTenantId: childTenantId,
      principalId: input.actorSub,
      credentialKind: 'ugk_oem',
      credentialId: verified.principal.credentialId,
      action: 'oem.child_tenant.provision',
      riskClass: 'R3',
      resourceType: 'child_tenant',
      resourceId: childTenantId,
      outcome: 'allow',
      reason: 'child_tenant_provisioned',
    });

    return { ok: true, status: 'ok', data: childRecord };
  }

  /**
   * Exchanges `ugk_oem_*` for a <= 15-minute `act`-claim child-tenant token
   * respecting child `delegation_policy`.
   */
  public exchangeForChildToken(params: {
    readonly rawOemKey: string;
    readonly childTenantId: string;
    readonly actorSub: string;
    readonly requestedScopes: readonly Scope[];
    readonly requestedTtlSec?: number;
    readonly now?: Date;
  }): OemOperationOutcome<{
    readonly token: string;
    readonly claims: OemExchangedTokenClaims;
    readonly principal: VerifiedPrincipal;
  }> {
    const now = params.now ?? new Date();
    const d15 = this.checkD15Entitled();
    if (!d15.entitled) {
      return {
        ok: false,
        status: 'not_entitled',
        httpStatus: 403,
        reason: d15.reason,
      };
    }

    const res = this.registry.exchangeOemTokenForChild({
      rawOemKey: params.rawOemKey,
      childTenantId: params.childTenantId,
      actorSub: params.actorSub,
      requestedScopes: params.requestedScopes,
      requestedTtlSec: params.requestedTtlSec,
      now,
    });

    if (!res.ok) {
      return {
        ok: false,
        status: res.httpStatus === 404 ? 'not_found' : 'forbidden',
        httpStatus: res.httpStatus,
        reason: res.reason,
      };
    }

    const verifiedChild = this.registry.verifyOemExchangedToken(res.token, { now });
    if (!verifiedChild.ok) {
      return {
        ok: false,
        status: 'forbidden',
        httpStatus: 403,
        reason: verifiedChild.reason,
      };
    }

    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: res.claims.act.managementTenantId,
      targetTenantId: params.childTenantId,
      principalId: params.actorSub,
      credentialKind: 'oem_exchanged',
      credentialId: res.claims.jti,
      action: 'oem.token.exchange',
      riskClass: 'R0',
      resourceType: 'child_tenant',
      resourceId: params.childTenantId,
      outcome: 'allow',
      reason: `exchanged_ttl_capped_le_${MAX_OEM_EXCHANGED_TTL_SEC}s`,
    });

    return {
      ok: true,
      status: 'ok',
      data: {
        token: res.token,
        claims: res.claims,
        principal: verifiedChild.principal,
      },
    };
  }

  /**
   * §11.11 #8 invariant: Visual replay (Tier 3) viewing is STRICTLY forbidden
   * for any OEM parent credential (`ugk_oem`, `oem_exchanged`, or `principal.act`).
   */
  public authorizeVisualReplayAccess(
    principal: VerifiedPrincipal,
    targetTenantId: string
  ): { readonly allowed: boolean; readonly status: 'ok' | 'not_entitled' | 'forbidden'; readonly reason: string } {
    const isOemParent =
      principal.credentialKind === 'ugk_oem' ||
      principal.credentialKind === 'oem_exchanged' ||
      principal.act !== undefined;

    if (isOemParent) {
      return {
        allowed: false,
        status: 'not_entitled',
        reason: 'oem_parent_visual_replay_forbidden (§11.11 #8)',
      };
    }

    if (principal.tenantId !== targetTenantId) {
      return {
        allowed: false,
        status: 'forbidden',
        reason: 'cross_tenant_replay_denied',
      };
    }

    return {
      allowed: true,
      status: 'ok',
      reason: 'direct_tenant_replay_authorized',
    };
  }

  /**
   * §5.12 / §11.3 invariant: When an OEM parent exports child-tenant analytics,
   * the OEM parent is a separate party -> MUST apply `< 10` suppression,
   * complementary differencing suppression, and non-overlapping calendar windows!
   */
  public async exportChildDataForOemParent(args: {
    readonly principal: VerifiedPrincipal;
    readonly exportId: string;
    readonly childTenantId: string;
    readonly siteId: string;
    readonly target: WarehouseTargetKind;
    readonly storageRegion: DataRegion;
    readonly destinationRegion: DataRegion;
    readonly crossRegionTransferGrantId?: string | null;
    readonly deletionEpoch: number;
    readonly rows: readonly ExportableAnalyticsRow[];
    readonly sourceEventCutoffMs: number;
    readonly nowMs?: number;
  }): Promise<OemOperationOutcome<WarehouseExportResult>> {
    if (args.principal.tenantId !== args.childTenantId) {
      return {
        ok: false,
        status: 'not_found',
        httpStatus: 404,
        reason: 'child_tenant_not_bound_to_token',
      };
    }

    if (!args.principal.effectiveScopes.has('analytics:export')) {
      return {
        ok: false,
        status: 'forbidden',
        httpStatus: 403,
        reason: 'missing_scope: analytics:export required for OEM child data export',
      };
    }

    if (
      args.principal.allowedSiteIds !== null &&
      !args.principal.allowedSiteIds.includes(args.siteId)
    ) {
      return {
        ok: false,
        status: 'forbidden',
        httpStatus: 403,
        reason: 'site_not_in_credential_allowlist',
      };
    }

    const res = await this.oemWarehouseExporter.exportBatch({
      config: {
        exportId: args.exportId,
        tenantId: args.childTenantId,
        siteId: args.siteId,
        target: args.target,
        // OEM parent is a separate party -> ALWAYS enforce external_party (<10 + non-overlap + complementary)!
        recipientClass: 'external_party',
        storageRegion: args.storageRegion,
        destinationRegion: args.destinationRegion,
        crossRegionTransferGrantId: args.crossRegionTransferGrantId,
        deletionEpoch: args.deletionEpoch,
      },
      rows: args.rows,
      sourceEventCutoffMs: args.sourceEventCutoffMs,
      nowMs: args.nowMs,
    });

    return { ok: true, status: 'ok', data: res };
  }

  public recordChildUsage(
    childTenantId: string,
    delta: {
      readonly billableStandardPvs?: number;
      readonly customEvents?: number;
      readonly destinationDeliveries?: number;
      readonly visualReplays?: number;
    }
  ): OemChildUsageEntry {
    const existing = this.childUsage.get(childTenantId);
    if (!existing) {
      throw new Error(`Unknown OEM child tenant: ${childTenantId}`);
    }
    const updated: OemChildUsageEntry = {
      ...existing,
      billableStandardPvs:
        existing.billableStandardPvs + (delta.billableStandardPvs ?? 0),
      customEvents: existing.customEvents + (delta.customEvents ?? 0),
      destinationDeliveries:
        existing.destinationDeliveries + (delta.destinationDeliveries ?? 0),
      visualReplays: existing.visualReplays + (delta.visualReplays ?? 0),
      crawlCreditsShared: 0,
    };
    this.childUsage.set(childTenantId, updated);
    return updated;
  }

  public getChildUsage(childTenantId: string): OemChildUsageEntry | undefined {
    return this.childUsage.get(childTenantId);
  }

  /**
   * Immediately revokes an OEM partner key AND invalidates all active child exchanged tokens (H-24).
   */
  public revokeOemPartnerKey(
    oemKeyId: string,
    managementTenantId: string,
    now: Date = new Date()
  ): { readonly revoked: boolean; readonly invalidatedChildTokens: number } {
    const res = this.registry.revokeOemKey(oemKeyId, now);
    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: managementTenantId,
      targetTenantId: managementTenantId,
      principalId: `oem_mgmt:${oemKeyId}`,
      credentialKind: 'ugk_oem',
      credentialId: oemKeyId,
      action: 'oem.partner.revoke_key',
      riskClass: 'R4',
      resourceType: 'oem_key',
      resourceId: oemKeyId,
      outcome: res.revoked ? 'allow' : 'deny_404',
      reason: res.revoked
        ? `oem_key_revoked_cascaded_${res.invalidatedChildTokens}_child_tokens`
        : 'oem_key_not_found',
    });
    return res;
  }

  /**
   * Immediately revokes a child tenant's OEM delegation relationship AND invalidates
   * all active exchanged child tokens for that child tenant (H-24).
   */
  public revokeChildDelegation(
    childTenantId: string,
    now: Date = new Date()
  ): { readonly revoked: boolean; readonly invalidatedChildTokens: number } {
    const res = this.registry.revokeOemChildRelationship(childTenantId);
    this.auditLog.append({
      timestamp: now.toISOString(),
      tenantId: childTenantId,
      targetTenantId: childTenantId,
      principalId: `tenant:${childTenantId}`,
      credentialKind: 'session_cookie',
      credentialId: childTenantId,
      action: 'oem.child_tenant.revoke_delegation',
      riskClass: 'R4',
      resourceType: 'child_tenant',
      resourceId: childTenantId,
      outcome: res.revoked ? 'allow' : 'deny_404',
      reason: res.revoked
        ? `child_delegation_revoked_cascaded_${res.invalidatedChildTokens}_child_tokens`
        : 'child_tenant_not_found',
    });
    return res;
  }

  public getAuditLog(): AuditLogStore {
    return this.auditLog;
  }
}
