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

  test('[M-17] rollbackClosedGrammarPatch blocks prototype pollution (__proto__, constructor, prototype) and forbidden attributes (onclick, srcdoc, style)', () => {
    const el: RuntimeDomElement = {
      matchKey: 'sec_target_1',
      textContent: 'Hello',
      hidden: false,
      attributes: { 'aria-label': 'safe-old' },
      styles: {},
    };
    const dom: RuntimeDomAdapter = {
      findByMatchKey: (k) => (k === 'sec_target_1' ? [el] : []),
      getHistoryLength: () => 1,
    };

    const poisonedPrevAttrs = JSON.parse(
      '{"__proto__":"polluted","constructor":"bad","prototype":"bad","onclick":"alert(1)","srcdoc":"<script>x</script>","style":"background:url(evil)","aria-label":"restored-clean"}'
    ) as Record<string, string>;

    const reverted = rollbackClosedGrammarPatch(dom, [
      {
        opId: 'adv_1',
        targetMatchKey: 'sec_target_1',
        kind: 'set_attribute',
        propOrAttrName: '__proto__',
        previousValue: 'polluted',
      },
      {
        opId: 'adv_2',
        targetMatchKey: 'sec_target_1',
        kind: 'set_attribute',
        propOrAttrName: 'onclick',
        previousValue: 'alert(1)',
      },
      {
        opId: 'adv_3',
        targetMatchKey: 'sec_target_1',
        kind: 'set_attribute',
        propOrAttrName: 'srcdoc',
        previousValue: '<script>1</script>',
      },
      {
        opId: 'adv_4',
        targetMatchKey: 'sec_target_1',
        kind: 'set_style',
        propOrAttrName: 'constructor',
        previousValue: 'polluted',
      },
      {
        opId: 'adv_5',
        targetMatchKey: 'sec_target_1',
        kind: 'set_attribute',
        previousValue: undefined,
        prevAttributes: poisonedPrevAttrs,
      },
    ]);

    expect(reverted).toBe(1); // Only safe `aria-label` in prevAttributes was applied
    expect(el.attributes['aria-label']).toBe('restored-clean');
    expect(Object.prototype.hasOwnProperty.call(el.attributes, 'onclick')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(el.attributes, 'srcdoc')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(el.attributes, 'style')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(typeof el.attributes.constructor).toBe('function');
  });
});
