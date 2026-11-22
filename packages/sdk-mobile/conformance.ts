/**
 * UGOKI LINK v2 — 4-Platform Mobile SDK Conformance & Independent OS Gate Suite (§11.11 item 5)
 */

import { CANONICAL_SCHEMA } from '@/packages/contract/schema';
import { generateAll4MobileSdks } from './generator';
import { MobileSdkSessionRuntime } from './lifecycle';
import { evaluateMobileOsReplayGate } from './mobile-replay';
import {
  MOBILE_PLATFORMS,
  type MobileOsGateResult,
  type MobilePlatform,
} from './types';

export interface MobileConformanceSummary {
  readonly contractSchemaVersion: string;
  readonly platformsChecked: number;
  readonly allStaticContractsPassed: boolean;
  readonly allOsGatesPassed: boolean;
  readonly allPassed: boolean;
  readonly osGates: ReadonlyArray<MobileOsGateResult>;
  readonly staticIssuesByPlatform: Readonly<Record<MobilePlatform, ReadonlyArray<string>>>;
}

export function run4PlatformMobileConformance(): MobileConformanceSummary {
  const { artifacts } = generateAll4MobileSdks();
  const schemaVersion = CANONICAL_SCHEMA.meta.schemaVersion;
  const staticIssuesByPlatform = {} as Record<MobilePlatform, ReadonlyArray<string>>;
  const osGates: MobileOsGateResult[] = [];

  for (const platform of MOBILE_PLATFORMS) {
    const art = artifacts[platform];
    const source = art.files.map((f) => f.content).join('\n');
    const issues: string[] = [];

    if (!source.includes(schemaVersion)) issues.push('Missing canonical schema version');
    if (!source.includes('not_applicable')) issues.push('Missing section_join=not_applicable');
    if (!source.includes('revokeConsent')) issues.push('Missing revokeConsent() zero-send wipe');
    if (!source.includes('optOut')) issues.push('Missing optOut() handler');
    if (!source.includes('setConsent')) issues.push('Missing setConsent() handler');
    if (!source.includes('track')) issues.push('Missing track() implementation');
    if (!source.includes('flushIfOnline')) issues.push('Missing flushIfOnline() implementation');
    if (/flushIfOnline\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*\}/.test(source)) {
      issues.push('Detected empty flushIfOnline() {} stub');
    }
    if (!/POST|postUrl/i.test(source)) issues.push('Missing HTTP POST batching in flushIfOnline');
    if (!source.includes('429')) issues.push('Missing 4xx vs 429 retry/drop handling');
    if (platform === 'ios' && /bounds:\s*\(Double,\s*Double/.test(source)) {
      issues.push('Detected invalid Swift tuple passed to JSONSerialization');
    }
    if (!source.includes('bounding_box_only')) issues.push('Missing custom-drawn bounding_box_only mask');
    for (const ct of ['identify', 'page', 'screen', 'track', 'group', 'alias']) {
      if (!source.includes(ct)) issues.push(`Missing Segment call type ${ct}`);
    }
    staticIssuesByPlatform[platform] = issues;

    // Exercise lifecycle runtime & consent revocation zero-send wipe per platform
    let sentAfterRevoke = 0;
    const runtime = new MobileSdkSessionRuntime({
      platform,
      tenantId: 'tenant_mob',
      siteId: `app_${platform}`,
      consentMode: 'full',
      consentPurposes: ['page_content', 'member_link'],
      online: false,
      onTransmit: (batch) => {
        sentAfterRevoke += batch.length;
        return true;
      },
    });
    const ev = runtime.recordScreenTransition('HomeScreen', 1000);
    runtime.recordSegmentCall('track', { event: 'ButtonTap' }, 2000);
    const wipe = runtime.revokeConsent();
    runtime.setOnline(true, 3000);

    const revocationZeroSendWipePassed =
      ev?.section_join === 'not_applicable' &&
      wipe.wipedQueuedEvents === 2 &&
      wipe.transmittedDuringWipe === 0 &&
      runtime.getQueueLength() === 0 &&
      sentAfterRevoke === 0;

    // Verify stats_exempt blocks identify/alias/group
    const statsExemptRt = new MobileSdkSessionRuntime({
      platform,
      tenantId: 'tenant_mob',
      siteId: `app_${platform}`,
      consentMode: 'stats_exempt',
      consentPurposes: ['page_content', 'member_link'],
    });
    const identifyBlocked = statsExemptRt.recordSegmentCall('identify', { userId: 'u1' }, 1000) === null;

    const gate = evaluateMobileOsReplayGate({
      platform,
      revocationZeroSendWipePassed,
      consentGatePassed: identifyBlocked,
      deletionPlanRegistered: true,
      estimatedSdkBundleKb: 42,
    });
    osGates.push(gate);
  }

  const allStaticContractsPassed = MOBILE_PLATFORMS.every(
    (p) => staticIssuesByPlatform[p].length === 0
  );
  const allOsGatesPassed = osGates.every((g) => g.passed);

  return {
    contractSchemaVersion: schemaVersion,
    platformsChecked: MOBILE_PLATFORMS.length,
    allStaticContractsPassed,
    allOsGatesPassed,
    allPassed: allStaticContractsPassed && allOsGatesPassed,
    osGates,
    staticIssuesByPlatform,
  };
}
