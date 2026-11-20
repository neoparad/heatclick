/**
 * UGOKI LINK v2 — 5-Minute Quickstart Onboarding & Self-Diagnostic Generator (Bundle 3-B)
 *
 * Implements §11.11 #1:
 * - Single copy-paste block combining the offline-pinned <=2KB snippet AND the SRI-locked
 *   empty census file reference (no security downgrade; Zone Worker / WP plugin are upgrades).
 * - Generates the JP External Transmission Privacy Disclosure record from `CANONICAL_SCHEMA`
 *   in the same flow so site owners publish disclosure before lifting `off` for general visitors.
 * - Produces an authenticated `install_probe` verification visit link (60s live feedback) that
 *   is 100% excluded from human rollups & billing via the unified Lab Marker (§12.2).
 */

import {
  CANONICAL_SCHEMA,
  generatePrivacyDisclosure,
  type PrivacyDisclosureRecord,
} from '../contract/schema';
import {
  EMPTY_FILE_SRI,
  SNIPPET_MAX_BYTES,
  generatePinnedSnippet,
  verifyEmptyFileIntegrity,
  type GeneratedPinnedSnippet,
} from '../sdk-snippet';
import type { PublicKeyJwkLike } from '../../workers/link-signer';
import type { DisclosureStatus, LabMarkerToken } from './types';

export interface QuickstartOnboardingInput {
  readonly siteRef: string;
  readonly siteName: string;
  readonly siteOrigin: string;
  readonly cdnOrigin: string;
  readonly collectorOrigin: string;
  readonly offlinePubKeyJwk: PublicKeyJwkLike;
  readonly minManifestSeq: number;
  readonly legalRecipientName: string;
  readonly optOutUrl: string;
  readonly pagePathKeyHash?: string;
  /** Optional short-lived `install_probe` lab marker issued to logged-in installer. */
  readonly installProbeMarker?: LabMarkerToken;
}

export interface QuickstartBundle {
  readonly installHtmlBlock: string;
  readonly snippetResult: GeneratedPinnedSnippet;
  readonly disclosureRecord: PrivacyDisclosureRecord;
  readonly requiredCspDirectives: {
    readonly 'script-src': readonly string[];
    readonly 'connect-src': readonly string[];
    readonly 'require-trusted-types-for': string;
  };
  readonly installProbeUrl: string | null;
}

/**
 * Generates the complete 5-minute onboarding bundle (single pasteable HTML block +
 * auto-generated JP disclosure record + CSP checklist + optional `install_probe` verification URL).
 */
export async function generateQuickstartOnboarding(
  input: QuickstartOnboardingInput
): Promise<QuickstartBundle> {
  const snippetResult = await generatePinnedSnippet({
    siteRef: input.siteRef,
    offlinePubKeyJwk: input.offlinePubKeyJwk,
    minManifestSeq: input.minManifestSeq,
    cdnOrigin: input.cdnOrigin,
    pagePathKeyHash: input.pagePathKeyHash,
  });

  const disclosureRecord = generatePrivacyDisclosure(CANONICAL_SCHEMA, {
    siteName: input.siteName,
    legalRecipientName: input.legalRecipientName,
    optOutUrl: input.optOutUrl,
  });

  const installHtmlBlock = [
    '<!-- UGOKI LINK v2 Quickstart (Offline-Pinned Snippet + Empty-File SRI Census) -->',
    snippetResult.combinedHtml,
  ].join('\n');

  let installProbeUrl: string | null = null;
  if (input.installProbeMarker && input.installProbeMarker.purpose === 'install_probe') {
    const safeRun = encodeURIComponent(input.installProbeMarker.lab_run_id);
    installProbeUrl = `${input.siteOrigin.replace(/\/$/, '')}/?ugk_probe_run=${safeRun}&ugk_probe_purpose=install_probe`;
  }

  const cdnOriginClean = new URL(input.cdnOrigin).origin;
  const collectorOriginClean = new URL(input.collectorOrigin).origin;
  const connectOrigins = Array.from(new Set([cdnOriginClean, collectorOriginClean]));

  return {
    installHtmlBlock,
    snippetResult,
    disclosureRecord,
    requiredCspDirectives: {
      'script-src': [
        `'${snippetResult.snippetSri}'`,
        `'${EMPTY_FILE_SRI}'`,
        cdnOriginClean,
      ],
      'connect-src': connectOrigins,
      'require-trusted-types-for': "'script'",
    },
    installProbeUrl,
  };
}

export interface QuickstartDiagnosticReport {
  readonly readyForGeneralTraffic: boolean;
  readonly generalVisitorEffectiveMode: 'off' | 'cookieless_or_configured';
  readonly checks: {
    readonly snippetWithin2Kb: boolean;
    readonly emptyFileSriValid: boolean;
    readonly cspAllowsCollector: boolean;
    readonly disclosureVerified: boolean;
    readonly installProbeExcludedFromHumanRollups: boolean;
  };
  readonly warnings: readonly string[];
}

/**
 * Self-diagnostic runner verifying a 5-minute onboarding installation before general
 * visitor traffic leaves `off` (§11.11 #1 / tel.G12).
 */
export async function runQuickstartSelfDiagnostics(params: {
  readonly bundle: QuickstartBundle;
  readonly observedEmptyFileBytes: Uint8Array;
  readonly observedCspConnectSrc: readonly string[];
  readonly disclosureStatus: DisclosureStatus;
  readonly jpExternalTransmissionSubject?: boolean;
  readonly installProbeMarker?: LabMarkerToken | null;
}): Promise<QuickstartDiagnosticReport> {
  const warnings: string[] = [];

  const snippetWithin2Kb = params.bundle.snippetResult.snippetBytes <= SNIPPET_MAX_BYTES;
  if (!snippetWithin2Kb) {
    warnings.push(
      `Pinned snippet size ${params.bundle.snippetResult.snippetBytes}B exceeds ${SNIPPET_MAX_BYTES}B budget`
    );
  }

  const emptyFileSriValid = await verifyEmptyFileIntegrity(params.observedEmptyFileBytes);
  if (!emptyFileSriValid) {
    warnings.push('Empty census asset failed SRI verification (expected empty-file SHA-256)');
  }

  const requiredConnect = params.bundle.requiredCspDirectives['connect-src'];
  const cspAllowsCollector =
    params.observedCspConnectSrc.includes('*') ||
    requiredConnect.every((origin) => params.observedCspConnectSrc.includes(origin));
  if (!cspAllowsCollector) {
    warnings.push(
      `CSP connect-src is missing one or more required origins: ${requiredConnect.join(', ')}`
    );
  }

  const disclosureVerified = params.disclosureStatus === 'verified';
  const isJp = params.jpExternalTransmissionSubject ?? true;
  if (!disclosureVerified) {
    warnings.push(
      isJp
        ? 'JP External Transmission disclosure is not yet verified — general visitors remain in mode "off"'
        : 'Privacy disclosure not yet verified — general visitors capped at "cookieless"'
    );
  }

  const installProbeExcludedFromHumanRollups =
    !params.installProbeMarker || params.installProbeMarker.purpose === 'install_probe';

  const readyForGeneralTraffic =
    snippetWithin2Kb && emptyFileSriValid && cspAllowsCollector && (!isJp || disclosureVerified);

  return {
    readyForGeneralTraffic,
    generalVisitorEffectiveMode:
      isJp && !disclosureVerified ? 'off' : 'cookieless_or_configured',
    checks: {
      snippetWithin2Kb,
      emptyFileSriValid,
      cspAllowsCollector,
      disclosureVerified,
      installProbeExcludedFromHumanRollups,
    },
    warnings,
  };
}
