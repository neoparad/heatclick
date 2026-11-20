/**
 * UGOKI LINK v2 — Closed-Grammar Delivery Runtime Interpreter (<= 14 KB gzipped, §10.3 & §10.5)
 *
 * Security & CSP/Trusted Types guarantees:
 *   - ZERO `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`
 *   - ZERO `eval` / `new Function`
 *   - ZERO `<style>` element injection (applies strictly whitelisted style properties via DOM API)
 *   - Reversible A2 mutations: every applied operation records its exact inverse for instant rollback
 *   - A3 isolated iframe controller monitors `history.length` and immediately closes frame + kills bundle
 *     on any history increment (§10.3)
 */

export interface RuntimeDomElement {
  readonly matchKey: string;
  readonly protectedRegion?: boolean;
  textContent: string;
  hidden: boolean;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  imageSrc?: string;
}

export interface RuntimeDomAdapter {
  findByMatchKey(matchKey: string): ReadonlyArray<RuntimeDomElement>;
  getHistoryLength(): number;
}

export type RuntimePatchOp =
  | { readonly opId: string; readonly kind: 'replace_text'; readonly targetMatchKey: string; readonly text: string }
  | { readonly opId: string; readonly kind: 'set_style'; readonly targetMatchKey: string; readonly prop: string; readonly value: string }
  | { readonly opId: string; readonly kind: 'hide'; readonly targetMatchKey: string }
  | { readonly opId: string; readonly kind: 'set_attribute'; readonly targetMatchKey: string; readonly name: string; readonly value: string };

export interface InverseOpRecord {
  readonly opId: string;
  readonly targetMatchKey: string;
  readonly kind: RuntimePatchOp['kind'];
  readonly previousValue: string | boolean | undefined;
  readonly propOrAttrName?: string;
}

const ALLOWED_RUNTIME_STYLE_PROPS = new Set([
  'color',
  'backgroundColor',
  'fontWeight',
  'fontSize',
  'padding',
  'margin',
  'borderRadius',
  'border',
  'display',
  'opacity',
]);

const ALLOWED_RUNTIME_ATTRS = new Set(['aria-label', 'title', 'data-ugk-variant']);

export interface AppliedPatchHandle {
  readonly applied: boolean;
  readonly inverseOps: ReadonlyArray<InverseOpRecord>;
  readonly skippedReason?: string;
}

/**
 * Applies a sequence of closed-grammar A2 operations atomically using pure DOM property APIs
 * (zero `innerHTML`, zero `<style>`, zero `eval`). If ANY op fails pre-write checks (non-unique
 * target, protected region, disallowed style/attr), rolls back all previously applied ops!
 */
export function applyClosedGrammarPatch(
  dom: RuntimeDomAdapter,
  ops: ReadonlyArray<RuntimePatchOp>
): AppliedPatchHandle {
  const inverses: InverseOpRecord[] = [];

  for (const op of ops) {
    const matches = dom.findByMatchKey(op.targetMatchKey);
    if (matches.length !== 1) {
      rollbackClosedGrammarPatch(dom, inverses);
      return {
        applied: false,
        inverseOps: [],
        skippedReason: matches.length === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_NOT_UNIQUE',
      };
    }

    const el = matches[0];
    if (el.protectedRegion) {
      rollbackClosedGrammarPatch(dom, inverses);
      return { applied: false, inverseOps: [], skippedReason: 'PROTECTED_REGION_BLOCKED' };
    }

    if (op.kind === 'replace_text') {
      inverses.push({
        opId: op.opId,
        targetMatchKey: op.targetMatchKey,
        kind: 'replace_text',
        previousValue: el.textContent,
      });
      el.textContent = op.text;
    } else if (op.kind === 'set_style') {
      if (!ALLOWED_RUNTIME_STYLE_PROPS.has(op.prop) || /url\s*\(|expression\s*\(|javascript:/i.test(op.value)) {
        rollbackClosedGrammarPatch(dom, inverses);
        return { applied: false, inverseOps: [], skippedReason: `FORBIDDEN_STYLE:${op.prop}` };
      }
      inverses.push({
        opId: op.opId,
        targetMatchKey: op.targetMatchKey,
        kind: 'set_style',
        propOrAttrName: op.prop,
        previousValue: el.styles[op.prop],
      });
      el.styles[op.prop] = op.value;
    } else if (op.kind === 'hide') {
      inverses.push({
        opId: op.opId,
        targetMatchKey: op.targetMatchKey,
        kind: 'hide',
        previousValue: el.hidden,
      });
      el.hidden = true;
    } else if (op.kind === 'set_attribute') {
      if (!ALLOWED_RUNTIME_ATTRS.has(op.name)) {
        rollbackClosedGrammarPatch(dom, inverses);
        return { applied: false, inverseOps: [], skippedReason: `FORBIDDEN_ATTR:${op.name}` };
      }
      inverses.push({
        opId: op.opId,
        targetMatchKey: op.targetMatchKey,
        kind: 'set_attribute',
        propOrAttrName: op.name,
        previousValue: el.attributes[op.name],
      });
      el.attributes[op.name] = op.value;
    }
  }

  return { applied: true, inverseOps: inverses };
}

/**
 * Reverts every applied operation in strict reverse order using stored inverse records.
 */
export function rollbackClosedGrammarPatch(
  dom: RuntimeDomAdapter,
  inverseOps: ReadonlyArray<InverseOpRecord>
): number {
  let reverted = 0;
  for (let i = inverseOps.length - 1; i >= 0; i--) {
    const inv = inverseOps[i];
    const matches = dom.findByMatchKey(inv.targetMatchKey);
    if (matches.length !== 1) continue;
    const el = matches[0];

    if (inv.kind === 'replace_text' && typeof inv.previousValue === 'string') {
      el.textContent = inv.previousValue;
      reverted += 1;
    } else if (inv.kind === 'hide' && typeof inv.previousValue === 'boolean') {
      el.hidden = inv.previousValue;
      reverted += 1;
    } else if (inv.kind === 'set_style' && inv.propOrAttrName) {
      if (inv.previousValue === undefined) {
        delete el.styles[inv.propOrAttrName];
      } else {
        el.styles[inv.propOrAttrName] = String(inv.previousValue);
      }
      reverted += 1;
    } else if (inv.kind === 'set_attribute' && inv.propOrAttrName) {
      if (inv.previousValue === undefined) {
        delete el.attributes[inv.propOrAttrName];
      } else {
        el.attributes[inv.propOrAttrName] = String(inv.previousValue);
      }
      reverted += 1;
    }
  }
  return reverted;
}

// =========================================================================
// A3 Isolated Cross-Origin Frame Host Controller (`history.length` Guard, §10.3)
// =========================================================================

export interface A3BundleKillEvent {
  readonly bundleHash: string;
  readonly reason: 'A3_HISTORY_LENGTH_INCREMENT_DETECTED' | 'HOST_CLOSE_CLICKED' | 'LEASE_EXPIRED';
  readonly previousHistoryLength: number;
  readonly observedHistoryLength: number;
  readonly timestampMs: number;
}

export class A3IsolatedFrameController {
  public readonly bundleHash: string;
  public readonly isolatedOrigin: string;
  private readonly dom: RuntimeDomAdapter;
  private readonly onKillBundle: (ev: A3BundleKillEvent) => void;
  private mounted = false;
  private baselineHistoryLength = 0;
  private killed = false;

  constructor(params: {
    readonly bundleHash: string;
    readonly isolatedOrigin: string;
    readonly dom: RuntimeDomAdapter;
    readonly onKillBundle: (ev: A3BundleKillEvent) => void;
  }) {
    this.bundleHash = params.bundleHash;
    this.isolatedOrigin = params.isolatedOrigin;
    this.dom = params.dom;
    this.onKillBundle = params.onKillBundle;
  }

  public mount(): boolean {
    if (this.killed) return false;
    this.baselineHistoryLength = this.dom.getHistoryLength();
    this.mounted = true;
    return true;
  }

  public isMounted(): boolean {
    return this.mounted;
  }

  public isKilled(): boolean {
    return this.killed;
  }

  /**
   * Monitors `history.length` while the A3 cross-origin frame is mounted (§10.3).
   * If `history.length` increases, IMMEDIATELY unmounts the frame and kills the bundle!
   */
  public pollHistoryGuard(nowMs: number = Date.now()): {
    readonly violationDetected: boolean;
    readonly frameClosed: boolean;
    readonly bundleKilled: boolean;
  } {
    if (!this.mounted) {
      return { violationDetected: false, frameClosed: false, bundleKilled: this.killed };
    }
    const currentLen = this.dom.getHistoryLength();
    if (currentLen > this.baselineHistoryLength) {
      this.mounted = false;
      this.killed = true;
      this.onKillBundle({
        bundleHash: this.bundleHash,
        reason: 'A3_HISTORY_LENGTH_INCREMENT_DETECTED',
        previousHistoryLength: this.baselineHistoryLength,
        observedHistoryLength: currentLen,
        timestampMs: nowMs,
      });
      return { violationDetected: true, frameClosed: true, bundleKilled: true };
    }
    return { violationDetected: false, frameClosed: false, bundleKilled: false };
  }

  public closeByHostButton(nowMs: number = Date.now()): void {
    this.mounted = false;
    this.onKillBundle({
      bundleHash: this.bundleHash,
      reason: 'HOST_CLOSE_CLICKED',
      previousHistoryLength: this.baselineHistoryLength,
      observedHistoryLength: this.dom.getHistoryLength(),
      timestampMs: nowMs,
    });
  }
}
