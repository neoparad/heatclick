import {
  MOBILE_PLATFORMS,
  MobileSdkSessionRuntime,
  generateAll4MobileSdks,
  maskMobileViewHierarchy,
  run4PlatformMobileConformance,
} from './index';

describe('packages/sdk-mobile — 4-Platform Mobile SDKs (iOS/Android/RN/Flutter), Lifecycle, Offline Queue, Revocation Wipe & Independent OS Gates', () => {
  test('generates all 4 platform SDKs deterministically from CANONICAL_SCHEMA with identical manifest hashes', () => {
    const r1 = generateAll4MobileSdks();
    const r2 = generateAll4MobileSdks();

    expect(Object.keys(r1.artifacts).sort()).toEqual([...MOBILE_PLATFORMS].sort());
    expect(r1.combinedManifestSha256).toBe(r2.combinedManifestSha256);

    expect(r1.artifacts.ios.language).toBe('swift');
    expect(r1.artifacts.android.language).toBe('kotlin');
    expect(r1.artifacts.react_native.language).toBe('typescript');
    expect(r1.artifacts.flutter.language).toBe('dart');
  });

  test('handles screen transitions (section_join=not_applicable), background stop & flush, offline cap/TTL FIFO loss ledger, and zero-send consent-revocation wipe', () => {
    const sentBatches: number[] = [];
    const rt = new MobileSdkSessionRuntime({
      platform: 'ios',
      tenantId: 'tenant_a',
      siteId: 'app_ios_1',
      consentMode: 'full',
      consentPurposes: ['page_content', 'member_link'],
      online: false,
      offlineConfig: {
        maxEvents: 3,
        maxBytes: 100_000,
        maxRetentionMs: 60_000, // 60s TTL
      },
      onTransmit: (batch) => {
        sentBatches.push(batch.length);
        return true;
      },
    });

    // Screen transitions carry section_join='not_applicable' & mobile_app_integrity
    const s1 = rt.recordScreenTransition('Home', 1000);
    expect(s1?.section_join).toBe('not_applicable');
    expect(s1?.actor_instrument).toBe('mobile_app_integrity');

    rt.recordScreenTransition('ProductDetail', 5000);
    rt.recordSegmentCall('track', { event: 'AddToCart' }, 8000);
    expect(rt.getQueueLength()).toBe(3);

    // 4th event while offline evicts oldest FIFO and records droppedOverflow in loss ledger
    rt.recordSegmentCall('identify', { userId: 'u_1' }, 10_000);
    expect(rt.getQueueLength()).toBe(3);
    expect(rt.getLossLedger().droppedOverflow).toBe(1);

    // Background pause halts timer (while offline -> stays queued, evicts 1 more FIFO)
    const bg = rt.onEnterBackground(15_000);
    expect(bg.stoppedScreen).toBe('ProductDetail');
    expect(bg.elapsedForegroundMs).toBe(10_000);
    expect(rt.isInBackground()).toBe(true);
    expect(bg.flushedCount).toBe(0);

    // Advance time past 60s TTL -> expired items pruned & recorded in loss ledger
    const pruned = rt.pruneExpiredOffline(90_000);
    expect(pruned).toBe(3);
    expect(rt.getLossLedger().droppedExpired).toBe(3);
    expect(rt.getQueueLength()).toBe(0);

    // Buffer 2 new events offline, then REVOKE CONSENT -> immediate zero-send wipe!
    rt.recordScreenTransition('Settings', 91_000);
    rt.recordSegmentCall('track', { event: 'OpenPrivacy' }, 92_000);
    expect(rt.getQueueLength()).toBe(2);

    const wipe = rt.revokeConsent();
    expect(wipe.wipedQueuedEvents).toBe(2);
    expect(wipe.transmittedDuringWipe).toBe(0);
    expect(rt.getQueueLength()).toBe(0);
    expect(rt.getLossLedger().droppedRevokedConsent).toBe(2);

    // Coming back online transmits ZERO events, and new events are rejected while off
    expect(rt.setOnline(true, 93_000)).toBe(0);
    expect(sentBatches).toEqual([]);
    expect(rt.recordScreenTransition('AfterOptOut', 94_000)).toBeNull();
    expect(rt.getTransmittedEvents()).toHaveLength(0);
  });

  test('masks custom-drawn mobile surfaces (Canvas/Metal/Skia/WebView) to bounding box only and passes independent 4-OS conformance & zero-leak gates', () => {
    const masked = maskMobileViewHierarchy({
      viewId: 'root',
      widgetKind: 'standard_text',
      nativeClassName: 'UIView',
      bounds: { x: 0, y: 0, width: 390, height: 844 },
      text: 'SECRET_MOBILE_LABEL',
      children: [
        {
          viewId: 'metal_surface',
          widgetKind: 'custom_metal_skia',
          nativeClassName: 'MTKView',
          bounds: { x: 0, y: 100, width: 390, height: 300 },
          text: 'SECRET_METAL_TEXT',
        },
        {
          viewId: 'wk_web',
          widgetKind: 'webview',
          nativeClassName: 'WKWebView',
          bounds: { x: 0, y: 420, width: 390, height: 300 },
          text: 'SECRET_WEBVIEW_TEXT',
        },
      ],
    });
    expect(JSON.stringify(masked)).not.toContain('SECRET_MOBILE_LABEL');
    expect(JSON.stringify(masked)).not.toContain('SECRET_METAL_TEXT');
    expect(JSON.stringify(masked)).not.toContain('SECRET_WEBVIEW_TEXT');
    expect(masked.unreproducibleRegions).toHaveLength(2);

    const summary = run4PlatformMobileConformance();
    expect(summary.platformsChecked).toBe(4);
    expect(summary.allStaticContractsPassed).toBe(true);
    expect(summary.allOsGatesPassed).toBe(true);
    expect(summary.allPassed).toBe(true);
    for (const osGate of summary.osGates) {
      expect(osGate.independentOfWebGate).toBe(true);
      expect(osGate.maskingZeroLeakPassed).toBe(true);
      expect(osGate.customDrawnBoxOnlyPassed).toBe(true);
      expect(osGate.revocationZeroSendWipePassed).toBe(true);
      expect(osGate.passed).toBe(true);
    }
  });
});
