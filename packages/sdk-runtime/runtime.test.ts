import path from 'node:path';
import {
  A3IsolatedFrameController,
  DELIVERY_CORE_MAX_GZIP_BYTES,
  applyClosedGrammarPatch,
  auditRuntimeSourceFile,
  rollbackClosedGrammarPatch,
  type A3BundleKillEvent,
  type RuntimeDomAdapter,
  type RuntimeDomElement,
} from './index';

describe('packages/sdk-runtime — Closed-Grammar Interpreter, Reversible Rollback, A3 History Guard & <=14 KB Gzip / Zero Unsafe Primitives', () => {
  test('applies closed-grammar A2 mutations atomically, blocks protected regions, and rolls back cleanly in reverse order', () => {
    const elements: RuntimeDomElement[] = [
      {
        matchKey: 'sec_hero_cta',
        textContent: 'Original CTA',
        hidden: false,
        attributes: {},
        styles: {},
      },
      {
        matchKey: 'sec_protected_legal',
        protectedRegion: true,
        textContent: 'Legal Notice',
        hidden: false,
        attributes: {},
        styles: {},
      },
    ];
    const dom: RuntimeDomAdapter = {
      findByMatchKey: (k) => elements.filter((e) => e.matchKey === k),
      getHistoryLength: () => 2,
    };

    const applied = applyClosedGrammarPatch(dom, [
      { opId: 'o1', kind: 'replace_text', targetMatchKey: 'sec_hero_cta', text: 'Updated CTA' },
      { opId: 'o2', kind: 'set_style', targetMatchKey: 'sec_hero_cta', prop: 'backgroundColor', value: '#1d4ed8' },
    ]);
    expect(applied.applied).toBe(true);
    expect(elements[0].textContent).toBe('Updated CTA');
    expect(elements[0].styles.backgroundColor).toBe('#1d4ed8');

    // Full rollback restores exact original state
    expect(rollbackClosedGrammarPatch(dom, applied.inverseOps)).toBe(2);
    expect(elements[0].textContent).toBe('Original CTA');
    expect(elements[0].styles.backgroundColor).toBeUndefined();

    // Touching a protected region rolls back earlier ops in the batch atomically
    const blocked = applyClosedGrammarPatch(dom, [
      { opId: 'o3', kind: 'replace_text', targetMatchKey: 'sec_hero_cta', text: 'Should Revert' },
      { opId: 'o4', kind: 'hide', targetMatchKey: 'sec_protected_legal' },
    ]);
    expect(blocked.applied).toBe(false);
    expect(blocked.skippedReason).toBe('PROTECTED_REGION_BLOCKED');
    expect(elements[0].textContent).toBe('Original CTA');
    expect(elements[1].hidden).toBe(false);
  });

  test('A3 isolated frame controller detects history.length increment, immediately closes frame, and kills bundle', () => {
    let historyLen = 3;
    const dom: RuntimeDomAdapter = {
      findByMatchKey: () => [],
      getHistoryLength: () => historyLen,
    };
    const killEvents: A3BundleKillEvent[] = [];

    const controller = new A3IsolatedFrameController({
      bundleHash: 'a3_sha256_deadbeef',
      isolatedOrigin: 'https://a3-sandbox.ugokilink.invalid',
      dom,
      onKillBundle: (ev) => killEvents.push(ev),
    });

    expect(controller.mount()).toBe(true);
    expect(controller.pollHistoryGuard(1000).violationDetected).toBe(false);

    // Malicious A3 bundle pushes a history entry -> immediate frame unmount + bundle kill!
    historyLen = 4;
    const detected = controller.pollHistoryGuard(1100);
    expect(detected.violationDetected).toBe(true);
    expect(detected.frameClosed).toBe(true);
    expect(detected.bundleKilled).toBe(true);
    expect(controller.isMounted()).toBe(false);
    expect(controller.isKilled()).toBe(true);
    expect(killEvents[0]?.reason).toBe('A3_HISTORY_LENGTH_INCREMENT_DETECTED');
  });

  test('Static safety & budget audit confirms 0 unsafe primitives (innerHTML/eval/<style>), CSP/Trusted Types pass, and gzipped runtime <= 14 KB', () => {
    const interpreterPath = path.resolve(__dirname, 'interpreter.ts');
    const report = auditRuntimeSourceFile(interpreterPath);

    expect(report.unsafePrimitiveViolations).toEqual([]);
    expect(report.gzipBytes).toBeLessThanOrEqual(DELIVERY_CORE_MAX_GZIP_BYTES);
    expect(report.within14KbGzipBudget).toBe(true);
    expect(report.cspTrustedTypesMatrix.every((m) => m.passed && m.runtimeCausedViolations === 0)).toBe(
      true
    );
    expect(report.passed).toBe(true);
  });
});
