/**
 * UGOKI LINK v2 — Mobile App SDK Types (iOS, Android, React Native, Flutter — §11.11 item 5)
 */

import type { CollectionLane, ConsentMode, ConsentPurpose } from '@/packages/contract/schema';

export const MOBILE_PLATFORMS = [
  'ios',
  'android',
  'react_native',
  'flutter',
] as const;

export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

export type MobileDataLane = CollectionLane;

export type MobileSegmentCallType =
  | 'identify'
  | 'page'
  | 'screen'
  | 'track'
  | 'group'
  | 'alias';

export interface MobileOfflineQueueConfig {
  /** Maximum number of buffered frames/events while offline. */
  readonly maxEvents: number;
  /** Maximum serialized byte size of offline buffer. */
  readonly maxBytes: number;
  /** Maximum offline retention age in milliseconds (expired items dropped FIFO). */
  readonly maxRetentionMs: number;
}

export const DEFAULT_MOBILE_OFFLINE_CONFIG: MobileOfflineQueueConfig = Object.freeze({
  maxEvents: 500,
  maxBytes: 512 * 1024, // 512 KiB
  maxRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
});

export interface MobileLossLedger {
  droppedExpired: number;
  droppedOverflow: number;
  droppedRevokedConsent: number;
  rejectedConsentMode: number;
}

export interface MobileEnvelopeEvent {
  readonly eventId: string;
  readonly platform: MobilePlatform;
  readonly lane: MobileDataLane;
  readonly callType: MobileSegmentCallType | 'screen_view';
  readonly tenantId: string;
  readonly siteId: string;
  readonly schemaVersion: string;
  readonly screenName: string | null;
  /** Mobile apps lack CRAWL HTML structure -> section join is ALWAYS `not_applicable` (§11.11.5). */
  readonly section_join: 'not_applicable';
  /** Mobile apps use a dedicated app-integrity actor instrument distinct from Web. */
  readonly actor_instrument: 'mobile_app_integrity';
  readonly consentMode: ConsentMode;
  readonly consentPurposes: ReadonlyArray<ConsentPurpose>;
  readonly consentGeneration: number;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly serializedBytes: number;
}

export type MobileReplayWidgetKind =
  | 'standard_text'
  | 'standard_input'
  | 'standard_password'
  | 'standard_payment'
  | 'standard_image'
  | 'custom_canvas'
  | 'custom_metal_skia'
  | 'custom_opengl'
  | 'webview';

export interface RawMobileViewNode {
  readonly viewId: string;
  readonly widgetKind: MobileReplayWidgetKind;
  readonly nativeClassName: string;
  readonly allowlistKey?: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly text?: string;
  readonly inputValue?: string;
  readonly sensitiveFlag?: boolean;
  readonly children?: ReadonlyArray<RawMobileViewNode>;
}

export interface MobileGeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface GeneratedMobileSdkArtifact {
  readonly platform: MobilePlatform;
  readonly language: 'swift' | 'kotlin' | 'typescript' | 'dart';
  readonly contractSchemaVersion: string;
  readonly files: ReadonlyArray<MobileGeneratedFile>;
  readonly manifestSha256: string;
}

export interface MobileOsGateResult {
  readonly platform: MobilePlatform;
  readonly independentOfWebGate: true;
  readonly consentGatePassed: boolean;
  readonly maskingZeroLeakPassed: boolean;
  readonly customDrawnBoxOnlyPassed: boolean;
  readonly revocationZeroSendWipePassed: boolean;
  readonly deletionPlanRegistered: boolean;
  readonly weightBudgetWithinCap: boolean;
  readonly passed: boolean;
  readonly details: ReadonlyArray<string>;
}
