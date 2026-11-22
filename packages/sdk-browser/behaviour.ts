/**
 * UGOKI LINK v2 — Behaviour Capture Engine, Conversion Rules & Replay-Lite Buffer
 *
 * Implements §4.3, §4.6, §4.8, §4.10, TEL M3 / M6 / M8 / M10, TEL A1 / A5, tel.G7:
 * - Zero polling: single event-driven `advance()` credits elapsed time to sections in the
 *   middle-40% focal band.
 * - 4-bin input gaps (<5s, 5-15s, 15-60s, >=60s) & 4-bin scroll velocity per section.
 * - Always-watched blocks + per-PV sampled blocks with exact `sample_pi` inverse-probability weight.
 * - Forms: values NEVER read; focus order, hesitation, refocus, non-composition correction bursts,
 *   IME share, native/aria/node validation errors; password/payment fields record PRESENCE ONLY
 *   and immediately suppress Tier 1/2 kinematic timeline emission for the PV.
 * - Activations: `el_fp`, relative coords (omitted inside forms/choice groups/keypads per TEL A5 #10),
 *   `multi_click` / rage-click & `no_effect_click` / dead-click statistics, `tel:`/`mailto:` scheme-only
 *   counting (no PII), ≤50 in-browser conversion rules with 2s/order-hash deduplication.
 * - Replay Tier 0/1/2: integers-only 8 KiB ring buffer; Tier 1/2 strictly gated behind Owner
 *   Decision `D-08` (`requireDecisionEntitled('D-08')` -> `not_entitled` until recorded).
 * - Heavy-device degradation ladder (`degrade_level`: 0 -> 1 -> 2 -> 3).
 */

import { requireDecisionEntitled } from '../contract/ledgers';
import {
  sha256Hex,
  type ActivationKind,
  type ConsentPurpose,
  type VitalsRegisterPayload,
} from '../contract/schema';
import { rewriteOutboundForLabSink } from './lab-sink';
import type {
  BlockGeometryInput,
  BrowserBlockRegisterPayload,
  BrowserFieldRegisterPayload,
  BrowserFormRegisterPayload,
  BrowserMediaRegisterPayload,
  BrowserSectionRegisterPayload,
  BrowserTelemetryLogItem,
  ClickEventInput,
  ConversionPredicateKind,
  ConversionRuleSpec,
  DegradeLevel,
  FormErrorInput,
  FormFocusInput,
  FormInteractionInput,
  LabMarkerToken,
  ReplayEntitlementConfig,
  SectionGeometryInput,
} from './types';

export const MAX_CONVERSION_RULES = 50 as const;
const MAX_SECTION_TOKENS = 64;
const MAX_ERROR_HASHES = 8;
const MAX_TIMELINE_RING_INTS = 2048; // 2048 * 4B = 8 KiB ring cap (TEL M6)

export interface NormalizedConversionRule {
  readonly cv_key: string;
  readonly rule_ver: number;
  readonly predicate_kind: ConversionPredicateKind;
  readonly predicate_values: readonly string[];
}

export function normalizeConversionRule(rule: ConversionRuleSpec): NormalizedConversionRule {
  const rec = rule as unknown as Record<string, unknown>;
  const rawKind = (rec.predicate_kind ?? rec.match_kind ?? 'selector') as string;
  const rawValue = rec.predicate_value ?? rec.match_value ?? '';
  const ruleVer =
    typeof rec.rule_ver === 'number' && Number.isFinite(rec.rule_ver) && rec.rule_ver >= 1
      ? Math.trunc(rec.rule_ver)
      : 1;

  let kind: ConversionPredicateKind;
  switch (rawKind) {
    case 'id':
    case 'class':
    case 'selector':
    case 'text':
    case 'href':
    case 'href_prefix':
    case 'el_fp':
    case 'el_fp_set':
      kind = rawKind;
      break;
    default:
      kind = 'selector';
      break;
  }

  let values: string[];
  if (Array.isArray(rawValue)) {
    values = rawValue.map((v) => String(v).trim()).filter((v) => v.length > 0);
  } else if (typeof rawValue === 'string') {
    if (kind === 'el_fp_set' || kind === 'el_fp') {
      values = rawValue
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      values = [rawValue];
    }
  } else {
    values = [];
  }

  return {
    cv_key: String(rec.cv_key ?? ''),
    rule_ver: ruleVer,
    predicate_kind: kind,
    predicate_values: values,
  };
}

export interface InternalSectionState {
  readonly sec_fp: string;
  vis_ms: number;
  t_first_ms: number;
  entries: number;
  max_frac_permille: number;
  /** 4 input gap bins: [<5s, 5-15s, 15-60s, >=60s] (ms accumulated) */
  gap_ms: [number, number, number, number];
  /** 4 scroll velocity bins: [<=80, 80-400, 400-1500, >1500 px/s] (ms accumulated) */
  vel_ms: [number, number, number, number];
  inFocalLastTick: boolean;
  dirty: boolean;
}

export interface InternalBlockState {
  readonly blk_fp: string;
  readonly alwaysWatch: boolean;
  readonly inclusionProb: number;
  vis_ms: number;
  copy_n: number;
  dirty: boolean;
}

export interface InternalFieldState {
  readonly form_fp: string;
  readonly el_fp: string;
  readonly isSensitive: boolean;
  order_idx: number;
  focus_n: number;
  focus_ms: number;
  first_input_latency_ms: number | null;
  refocus_n: number;
  edit_bursts: number;
  correction_bursts: number;
  composition_inputs: number;
  total_inputs: number;
  invalid_n: number;
  validation_observable: boolean;
  filled_ever: boolean;
  lastFocusStartMs: number | null;
  dirty: boolean;
}

export interface InternalFormState {
  readonly form_fp: string;
  started: boolean;
  t_first_ms: number;
  submit_attempts: number;
  blocked_submits: number;
  last_field_fp: string | null;
  dirty: boolean;
}

export interface InternalMediaState {
  readonly blk_fp: string;
  played_ms: number;
  plays: number;
  completed: boolean;
  dirty: boolean;
}

export interface MultiClickStat {
  readonly el_fp: string;
  readonly count: number;
  readonly minIntervalMs: number;
  readonly spreadPx: number;
  readonly rageClick: boolean;
}

export interface NoEffectClickStat {
  readonly el_fp: string;
  readonly effectBits: number;
  readonly timeToFirstEffectBin: 0 | 1 | 2 | 3; // 0: <600ms, 1: 600-2000ms, 2: >2000ms, 3: none
  readonly deadClick: boolean;
}

export interface ReplayEmissionDecision {
  readonly allowed: boolean;
  readonly tier: 0 | 1 | 2;
  readonly status: 'ok' | 'not_entitled';
  readonly reason: string;
}

export interface BehaviourEngineOptions {
  readonly pvId: string;
  readonly pageOrigin: string;
  readonly viewportHeightPx: number;
  readonly fixedTopPx: number;
  readonly fixedBottomPx: number;
  readonly initialDocHeightPx: number;
  readonly blockSampleRate: number;
  readonly conversionRules: readonly ConversionRuleSpec[];
  readonly replay: ReplayEntitlementConfig;
  readonly labMarker?: LabMarkerToken | null;
  readonly labSinkPath?: string;
}

function deterministicSampleUnit(pvId: string, blkFp: string): number {
  const hex = sha256Hex(`${pvId}:blk:${blkFp}`).slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

function gapBinIndex(gapMs: number): 0 | 1 | 2 | 3 {
  if (gapMs < 5_000) return 0;
  if (gapMs < 15_000) return 1;
  if (gapMs < 60_000) return 2;
  return 3;
}

function velocityBinIndex(pxPerSec: number): 0 | 1 | 2 | 3 {
  if (pxPerSec <= 80) return 0;
  if (pxPerSec <= 400) return 1;
  if (pxPerSec <= 1500) return 2;
  return 3;
}

function clampPermille(val: number | undefined): number | undefined {
  if (val === undefined || !Number.isFinite(val)) return undefined;
  return Math.max(0, Math.min(1000, Math.round(val)));
}

function sanitizeDestKeyClick(
  rawHref: string,
  pageOrigin: string,
  allowedRoleParams: readonly string[] = []
): string | undefined {
  const trimmed = rawHref.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('tel:')) {
    // §4.10: NEVER send phone numbers — destination kind only!
    return 'tel_scheme';
  }
  if (lower.startsWith('mailto:')) {
    // §4.10: NEVER send email addresses — destination kind only!
    return 'mailto_scheme';
  }
  try {
    const parsed = new URL(trimmed, pageOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const allowedSet = new Set(allowedRoleParams.map((p) => p.toLowerCase()));
    const kept: string[] = [];
    parsed.searchParams.forEach((val, key) => {
      if (allowedSet.has(key.toLowerCase())) {
        kept.push(`${key.toLowerCase()}=${val}`);
      }
    });
    kept.sort();
    const base = `${parsed.host.toLowerCase()}${parsed.pathname}`;
    return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
  } catch {
    return undefined;
  }
}

export class BehaviourCaptureEngine {
  private readonly pvId: string;
  private readonly pageOrigin: string;
  private viewportHeightPx: number;
  private readonly fixedTopPx: number;
  private readonly fixedBottomPx: number;
  private readonly blockSampleRate: number;
  private readonly normalizedRules: readonly NormalizedConversionRule[];
  private readonly replayCfg: ReplayEntitlementConfig;
  private readonly labMarker: LabMarkerToken | null;
  private readonly labSinkPath?: string;

  public scrollMaxPx = 0;
  public docHFirst: number;
  public docHMax: number;
  public docHLastValue: number;
  public docHLastSeq = 0;
  public visMs = 0;
  public reversals = 0;
  public jsErrorN = 0;
  public degradeLevel: DegradeLevel = 0;
  public readonly errorHashes: string[] = [];
  public readonly sectionTokens: string[] = [];
  public readonly multiClickStats: MultiClickStat[] = [];
  public readonly noEffectClickStats: NoEffectClickStat[] = [];
  public hasSensitiveFieldOnPv = false;
  public totalSelfCpuMs = 0;
  public maxHandlerTaskMs = 0;
  public timelineTolerancePct: 2 | 4 | 8 = 2;

  private readonly sections = new Map<string, InternalSectionState>();
  private readonly blocks = new Map<string, InternalBlockState>();
  private readonly blockWatchDecision = new Map<string, boolean>();
  private readonly fields = new Map<string, InternalFieldState>();
  private readonly forms = new Map<string, InternalFormState>();
  private readonly media = new Map<string, InternalMediaState>();
  private vitals: VitalsRegisterPayload = {};
  private vitalsDirty = false;
  private errorHashesDirty = false;
  private emittedSectionTokenCount = 0;

  private readonly logItems: BrowserTelemetryLogItem[] = [];
  private nextLogOrdinal = 1;
  private readonly conversionDedupeKeys = new Set<string>();
  private readonly recentClicksByEl = new Map<string, Array<{ t: number; y: number }>>();
  private readonly timelineRingInts: number[] = [];

  private lastAdvanceMs = 0;
  private lastInputMs = 0;
  private lastScrollY = 0;
  private lastScrollDir: -1 | 0 | 1 = 0;
  private lastFocalSectionIdx = -1;
  private lastFocalSectionFp: string | null = null;
  private formFocusOrderCounter = 0;
  private lastTimelineScrollPx = 0;
  private lastTimelineMs = 0;
  private overBudgetHandlerCount = 0;

  constructor(options: BehaviourEngineOptions) {
    this.pvId = options.pvId;
    this.pageOrigin = options.pageOrigin;
    this.viewportHeightPx = Math.max(100, options.viewportHeightPx);
    this.fixedTopPx = Math.max(0, options.fixedTopPx);
    this.fixedBottomPx = Math.max(0, options.fixedBottomPx);
    this.docHFirst = Math.max(100, options.initialDocHeightPx);
    this.docHMax = this.docHFirst;
    this.docHLastValue = this.docHFirst;
    this.blockSampleRate = Math.min(1, Math.max(0.001, options.blockSampleRate));
    this.normalizedRules = options.conversionRules
      .slice(0, MAX_CONVERSION_RULES)
      .map(normalizeConversionRule)
      .filter((r) => r.cv_key.length > 0 && r.predicate_values.length > 0);
    this.replayCfg = options.replay;
    this.labMarker = options.labMarker ?? null;
    this.labSinkPath = options.labSinkPath;
  }

  public getSamplePi(): number {
    return this.blockSampleRate;
  }

  public getSectionSnapshot(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [fp, s] of this.sections) {
      out[fp] = s.vis_ms;
    }
    return out;
  }

  public getSectionDetails(secFp: string): InternalSectionState | undefined {
    return this.sections.get(secFp);
  }

  public getFieldDetails(elFp: string): InternalFieldState | undefined {
    return this.fields.get(elFp);
  }

  public getBlockInverseWeight(blkFp: string): number | null {
    const blk = this.blocks.get(blkFp);
    if (!blk) return null;
    return blk.alwaysWatch ? 1 : 1 / blk.inclusionProb;
  }

  /**
   * Heavy-device degradation ladder (§4.8 / TEL M8):
   * 0 = full, 1 = drop pointer & kinematic timeline, 2 = sections only, 3 = counter only.
   */
  public recordHandlerSelfCost(durationMs: number): void {
    this.totalSelfCpuMs += Math.max(0, durationMs);
    if (durationMs > this.maxHandlerTaskMs) {
      this.maxHandlerTaskMs = durationMs;
    }
    if (durationMs > 16) {
      this.overBudgetHandlerCount += 1;
      if (this.overBudgetHandlerCount >= 6 && this.degradeLevel < 3) {
        this.degradeLevel = 3;
      } else if (this.overBudgetHandlerCount >= 4 && this.degradeLevel < 2) {
        this.degradeLevel = 2;
      } else if (this.overBudgetHandlerCount >= 2 && this.degradeLevel < 1) {
        this.degradeLevel = 1;
      }
    }
  }

  public markUserInput(tMono: number): void {
    if (tMono > this.lastInputMs) {
      this.lastInputMs = tMono;
    }
  }

  /**
   * Event-driven dwell integrator (`advance()`, §4.3 / TEL M3):
   * Credits elapsed ms to sections intersecting the middle-40% focal band,
   * tracks 4-bin input gaps & 4-bin scroll velocity, re-read transitions,
   * document height changes, and block visibility (always-watched + sampled).
   */
  public advance(params: {
    readonly tMono: number;
    readonly scrollY: number;
    readonly visible: boolean;
    readonly docHeightPx?: number;
    readonly viewportHeightPx?: number;
    readonly sections: readonly SectionGeometryInput[];
    readonly blocks?: readonly BlockGeometryInput[];
    readonly currentSeq: number;
    readonly isInputTick?: boolean;
  }): void {
    const now = Math.max(this.lastAdvanceMs, Math.round(params.tMono));
    const dtMs = this.lastAdvanceMs === 0 ? 0 : Math.max(0, now - this.lastAdvanceMs);

    if (params.viewportHeightPx && params.viewportHeightPx > 0) {
      this.viewportHeightPx = params.viewportHeightPx;
    }
    if (params.docHeightPx && params.docHeightPx > 0) {
      const dh = Math.round(params.docHeightPx);
      if (dh > this.docHMax) this.docHMax = dh;
      if (dh !== this.docHLastValue) {
        this.docHLastValue = dh;
        this.docHLastSeq = params.currentSeq;
      }
    }

    const scrollY = Math.max(0, Math.round(params.scrollY));
    if (scrollY > this.scrollMaxPx) {
      this.scrollMaxPx = scrollY;
    }

    const dy = scrollY - this.lastScrollY;
    const speedPxPerSec = dtMs > 0 ? (Math.abs(dy) * 1000) / dtMs : 0;
    if (Math.abs(dy) >= 24) {
      const dir: -1 | 1 = dy > 0 ? 1 : -1;
      if (this.lastScrollDir === 1 && dir === -1) {
        this.reversals += 1;
      }
      this.lastScrollDir = dir;
    }

    const inputGapMs = Math.max(0, now - this.lastInputMs);
    const gBin = gapBinIndex(inputGapMs);
    const vBin = velocityBinIndex(speedPxPerSec);

    if (params.visible && dtMs > 0) {
      this.visMs += dtMs;
    }

    // Middle-40% focal band free of fixed header/footer (join M2 / §4.3)
    const freeH = Math.max(1, this.viewportHeightPx - this.fixedTopPx - this.fixedBottomPx);
    const focalTop = scrollY + this.fixedTopPx + freeH * 0.3;
    const focalBottom = scrollY + this.fixedTopPx + freeH * 0.7;

    let primaryFocalIdx = -1;
    let primaryFocalFp: string | null = null;
    let maxOverlap = 0;

    if (this.degradeLevel < 3) {
      for (let idx = 0; idx < params.sections.length; idx++) {
        const geo = params.sections[idx];
        const secHeight = Math.max(1, geo.bottomPx - geo.topPx);
        const overlapTop = Math.max(focalTop, geo.topPx);
        const overlapBottom = Math.min(focalBottom, geo.bottomPx);
        const overlapPx = Math.max(0, overlapBottom - overlapTop);
        const inFocal = overlapPx > 0;
        const fracPermille = Math.min(
          1000,
          Math.round((overlapPx / Math.min(secHeight, freeH * 0.4)) * 1000)
        );

        if (overlapPx > maxOverlap) {
          maxOverlap = overlapPx;
          primaryFocalIdx = idx;
          primaryFocalFp = geo.sec_fp;
        }

        let reg = this.sections.get(geo.sec_fp);
        if (inFocal && !reg) {
          reg = {
            sec_fp: geo.sec_fp,
            vis_ms: 0,
            t_first_ms: now,
            entries: 0,
            max_frac_permille: 0,
            gap_ms: [0, 0, 0, 0],
            vel_ms: [0, 0, 0, 0],
            inFocalLastTick: false,
            dirty: true,
          };
          this.sections.set(geo.sec_fp, reg);
        }

        if (reg) {
          if (inFocal) {
            if (!reg.inFocalLastTick) {
              reg.entries += 1;
              reg.dirty = true;
            }
            if (params.visible && dtMs > 0) {
              reg.vis_ms += dtMs;
              reg.gap_ms[gBin] += dtMs;
              reg.vel_ms[vBin] += dtMs;
              reg.dirty = true;
            }
            if (fracPermille > reg.max_frac_permille) {
              reg.max_frac_permille = fracPermille;
              reg.dirty = true;
            }
          }
          reg.inFocalLastTick = inFocal;
        }
      }

      // Section transition & re-read tracking (Tier 0 aggregate replay foundation)
      if (primaryFocalFp && primaryFocalFp !== this.lastFocalSectionFp) {
        if (this.sectionTokens.length < MAX_SECTION_TOKENS) {
          this.sectionTokens.push(primaryFocalFp);
        }
        if (this.lastFocalSectionIdx >= 0 && primaryFocalIdx < this.lastFocalSectionIdx) {
          this.pushLogItem({
            kind: 'reread_transition',
            t_mono: now,
            el_fp: primaryFocalFp,
          });
        }
        this.lastFocalSectionIdx = primaryFocalIdx;
        this.lastFocalSectionFp = primaryFocalFp;
      }
    }

    // Block visibility watching (degradeLevel <= 1): always-watched + deterministic sampled subset
    if (this.degradeLevel <= 1 && params.visible && dtMs > 0 && params.blocks) {
      for (const blk of params.blocks) {
        let watched = this.blockWatchDecision.get(blk.blk_fp);
        if (watched === undefined) {
          watched =
            blk.alwaysWatch || deterministicSampleUnit(this.pvId, blk.blk_fp) < this.blockSampleRate;
          this.blockWatchDecision.set(blk.blk_fp, watched);
        }
        if (!watched || !blk.inViewport) continue;

        let bReg = this.blocks.get(blk.blk_fp);
        if (!bReg) {
          bReg = {
            blk_fp: blk.blk_fp,
            alwaysWatch: blk.alwaysWatch,
            inclusionProb: blk.alwaysWatch ? 1 : this.blockSampleRate,
            vis_ms: 0,
            copy_n: 0,
            dirty: true,
          };
          this.blocks.set(blk.blk_fp, bReg);
        }
        bReg.vis_ms += dtMs;
        bReg.dirty = true;
      }
    }

    // Kinematic dead-reckoning buffer (integers only, 8 KiB ring, degradeLevel === 0)
    if (this.degradeLevel === 0 && params.visible && !this.hasSensitiveFieldOnPv) {
      const tolPx = Math.max(
        8,
        Math.round((this.viewportHeightPx * this.timelineTolerancePct) / 100)
      );
      if (
        Math.abs(scrollY - this.lastTimelineScrollPx) >= tolPx ||
        now - this.lastTimelineMs >= 150
      ) {
        const dt100 = Math.max(0, Math.round((now - this.lastTimelineMs) / 100));
        const secOrd = Math.max(0, primaryFocalIdx);
        const offsetPx8 = Math.round(scrollY / 8);
        this.appendTimelineKeyframe(dt100, 1, secOrd, offsetPx8);
        this.lastTimelineScrollPx = scrollY;
        this.lastTimelineMs = now;
      }
    }

    if (params.isInputTick) {
      this.markUserInput(now);
    }
    this.lastScrollY = scrollY;
    this.lastAdvanceMs = now;
  }

  private appendTimelineKeyframe(
    dt100: number,
    tableRev: number,
    secOrd: number,
    offsetPx8: number
  ): void {
    if (this.timelineRingInts.length + 4 > MAX_TIMELINE_RING_INTS) {
      // Coarsen tolerance 2 -> 4 -> 8% and decimate ring by half (TEL M6)
      this.timelineTolerancePct = this.timelineTolerancePct === 2 ? 4 : 8;
      const compacted: number[] = [];
      for (let i = 0; i < this.timelineRingInts.length; i += 8) {
        if (i + 3 < this.timelineRingInts.length) {
          compacted.push(
            this.timelineRingInts[i],
            this.timelineRingInts[i + 1],
            this.timelineRingInts[i + 2],
            this.timelineRingInts[i + 3]
          );
        }
      }
      this.timelineRingInts.length = 0;
      this.timelineRingInts.push(...compacted);
    }
    this.timelineRingInts.push(
      Math.trunc(dt100),
      Math.trunc(tableRev),
      Math.trunc(secOrd),
      Math.trunc(offsetPx8)
    );
  }

  // =========================================================================
  // Forms (Values NEVER read — tel.G7 Non-Interference)
  // =========================================================================

  public recordFormFocus(input: FormFocusInput): void {
    this.markUserInput(input.tMono);
    if (input.isSensitive) {
      // Sensitive fields (password / payment): PRESENCE ONLY + disables Tier 1/2 timeline
      this.hasSensitiveFieldOnPv = true;
    }

    let form = this.forms.get(input.form_fp);
    if (!form) {
      form = {
        form_fp: input.form_fp,
        started: true,
        t_first_ms: Math.round(input.tMono),
        submit_attempts: 0,
        blocked_submits: 0,
        last_field_fp: input.el_fp,
        dirty: true,
      };
      this.forms.set(input.form_fp, form);
    } else {
      form.last_field_fp = input.el_fp;
      form.dirty = true;
    }

    let fld = this.fields.get(input.el_fp);
    if (!fld) {
      this.formFocusOrderCounter += 1;
      fld = {
        form_fp: input.form_fp,
        el_fp: input.el_fp,
        isSensitive: input.isSensitive,
        order_idx: this.formFocusOrderCounter,
        focus_n: input.isSensitive ? 0 : 1,
        focus_ms: 0,
        first_input_latency_ms: null,
        refocus_n: 0,
        edit_bursts: 0,
        correction_bursts: 0,
        composition_inputs: 0,
        total_inputs: 0,
        invalid_n: 0,
        validation_observable: false,
        filled_ever: false,
        lastFocusStartMs: input.isSensitive ? null : Math.round(input.tMono),
        dirty: true,
      };
      this.fields.set(input.el_fp, fld);
    } else if (!input.isSensitive) {
      fld.focus_n += 1;
      fld.refocus_n += 1;
      fld.lastFocusStartMs = Math.round(input.tMono);
      fld.dirty = true;
    }
  }

  public recordFormBlur(elFp: string, tMono: number): void {
    const fld = this.fields.get(elFp);
    if (!fld || fld.isSensitive || fld.lastFocusStartMs === null) return;
    const elapsed = Math.max(0, Math.round(tMono) - fld.lastFocusStartMs);
    fld.focus_ms += elapsed;
    fld.lastFocusStartMs = null;
    fld.dirty = true;
  }

  /**
   * Records structural form input statistics ONLY.
   * NEVER accepts or reads typed characters, selected options, or keypad values (`tel.G7`).
   */
  public recordFormInteraction(input: FormInteractionInput): void {
    this.markUserInput(input.tMono);
    if (input.isSensitive) {
      // Sensitive fields: presence only — zero timing / edit counters recorded!
      this.hasSensitiveFieldOnPv = true;
      return;
    }
    let fld = this.fields.get(input.el_fp);
    if (!fld) {
      this.recordFormFocus({
        tMono: input.tMono,
        form_fp: input.form_fp,
        el_fp: input.el_fp,
        isSensitive: false,
      });
      fld = this.fields.get(input.el_fp)!;
    }
    if (fld.first_input_latency_ms === null && fld.lastFocusStartMs !== null) {
      fld.first_input_latency_ms = Math.max(0, Math.round(input.tMono) - fld.lastFocusStartMs);
    }
    fld.total_inputs += 1;
    if (input.isComposition) {
      fld.composition_inputs += 1;
    } else if (input.isDeletion) {
      fld.correction_bursts += 1;
    } else {
      fld.edit_bursts += 1;
    }
    if (input.becameFilled) {
      fld.filled_ever = true;
    }
    fld.dirty = true;
  }

  public recordFormError(input: FormErrorInput): void {
    let fld = this.fields.get(input.el_fp);
    if (!fld) {
      this.recordFormFocus({
        tMono: this.lastAdvanceMs,
        form_fp: input.form_fp,
        el_fp: input.el_fp,
        isSensitive: false,
      });
      fld = this.fields.get(input.el_fp)!;
    }
    fld.validation_observable = true;
    fld.invalid_n += 1;
    fld.dirty = true;
  }

  public recordFormSubmit(formFp: string, tMono: number, blocked: boolean): void {
    this.markUserInput(tMono);
    let form = this.forms.get(formFp);
    if (!form) {
      form = {
        form_fp: formFp,
        started: true,
        t_first_ms: Math.round(tMono),
        submit_attempts: 0,
        blocked_submits: 0,
        last_field_fp: null,
        dirty: true,
      };
      this.forms.set(formFp, form);
    }
    form.submit_attempts += 1;
    if (blocked) form.blocked_submits += 1;
    form.dirty = true;
  }

  // =========================================================================
  // Clicks, Activations, Multi-Click / No-Effect Stats & Conversions (<=50 rules)
  // =========================================================================

  public recordClick(input: ClickEventInput, nowWallMs: number): {
    readonly isCritical: boolean;
    readonly effectiveHref: string | undefined;
    readonly matchedConversions: readonly string[];
  } {
    this.markUserInput(input.tMono);

    // Inside form / choice group / keypad: record ONLY group_fp, omit coords (TEL A5 #10 / tel.G7)
    const suppressCoords = Boolean(input.insideFormOrChoiceOrKeypad);
    const recordedElFp = suppressCoords ? (input.groupFp ?? 'group_redacted') : input.el_fp;
    const xPermille = suppressCoords ? undefined : clampPermille(input.xPermille);
    const yPermille = suppressCoords ? undefined : clampPermille(input.yPermille);

    // Detect tel:/mailto: destination kinds without leaking phone/email PII (§4.10)
    let activationKind: ActivationKind = input.activation_kind;
    let effectiveHref = input.href;
    let destKeyClick: string | undefined;
    if (input.href) {
      const lowerHref = input.href.trim().toLowerCase();
      if (lowerHref.startsWith('tel:')) {
        activationKind = 'tel_link';
        destKeyClick = 'tel_scheme';
      } else if (lowerHref.startsWith('mailto:')) {
        activationKind = 'mailto_link';
        destKeyClick = 'mailto_scheme';
      } else {
        // Lab marker outbound sink rewrite (§12.1 #4 / D-22): affiliate hosts = 0 requests!
        const sinkRes = rewriteOutboundForLabSink(
          input.href,
          this.pageOrigin,
          this.labMarker,
          nowWallMs,
          this.labSinkPath
        );
        effectiveHref = sinkRes.href;
        destKeyClick = sanitizeDestKeyClick(
          input.href,
          this.pageOrigin,
          input.allowedDestRoleParams
        );
      }
    }

    let isRageClick = false;
    let isDeadClick = false;
    let effectBitsVal: number | undefined;
    let effectBinVal: 0 | 1 | 2 | 3 | undefined;

    // Track multi_click / rage-click & dead-click / no-effect statistics
    if (!suppressCoords) {
      const history = this.recentClicksByEl.get(recordedElFp) ?? [];
      const cutoff = input.tMono - 1000;
      const recent = history.filter((c) => c.t >= cutoff);
      recent.push({ t: input.tMono, y: input.yDocPx ?? 0 });
      this.recentClicksByEl.set(recordedElFp, recent);

      if (recent.length >= 3) {
        let minInterval = Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < recent.length; i++) {
          if (i > 0) {
            minInterval = Math.min(minInterval, recent[i].t - recent[i - 1].t);
          }
          minY = Math.min(minY, recent[i].y);
          maxY = Math.max(maxY, recent[i].y);
        }
        const safeMinInterval = Number.isFinite(minInterval) ? minInterval : 0;
        const spreadPx = Math.max(0, maxY - minY);
        isRageClick = safeMinInterval <= 500 && spreadPx <= 64;
        this.multiClickStats.push({
          el_fp: recordedElFp,
          count: recent.length,
          minIntervalMs: safeMinInterval,
          spreadPx,
          rageClick: isRageClick,
        });
        this.pushLogItem({
          kind: 'multi_click_burst',
          t_mono: Math.round(input.tMono),
          el_fp: recordedElFp,
          click_count: recent.length,
          min_interval_ms: safeMinInterval,
          spread_px: spreadPx,
          rage_click: isRageClick,
        });
      }

      if (input.effectBits !== undefined || input.timeToFirstEffectMs !== undefined) {
        const effMs = input.timeToFirstEffectMs;
        const bin: 0 | 1 | 2 | 3 =
          effMs === undefined
            ? 3
            : effMs < 600
              ? 0
              : effMs <= 2000
                ? 1
                : 2;
        effectBitsVal = input.effectBits ?? 0;
        effectBinVal = bin;
        isDeadClick = effectBitsVal === 0 && (effMs === undefined || effMs > 2000);
        this.noEffectClickStats.push({
          el_fp: recordedElFp,
          effectBits: effectBitsVal,
          timeToFirstEffectBin: bin,
          deadClick: isDeadClick,
        });
      }
    }

    this.pushLogItem({
      kind: 'activation',
      t_mono: Math.round(input.tMono),
      activation_kind: activationKind,
      el_fp: recordedElFp,
      ...(destKeyClick !== undefined ? { dest_key_click: destKeyClick } : {}),
      ...(xPermille !== undefined ? { x_permille: xPermille } : {}),
      ...(yPermille !== undefined ? { y_permille: yPermille } : {}),
      ...(isRageClick ? { rage_click: true } : {}),
      ...(effectBitsVal !== undefined ? { effect_bits: effectBitsVal } : {}),
      ...(effectBinVal !== undefined ? { time_to_first_effect_bin: effectBinVal } : {}),
      ...(isDeadClick ? { dead_click: true } : {}),
    });

    // Evaluate <=50 conversion rules IN-BROWSER; emit ONLY [cv_key, rule_ver, el_fp] (§4.10)
    const matchedConversions: string[] = [];
    for (const rule of this.normalizedRules) {
      if (!this.matchesConversionRule(rule, input)) continue;
      const dedupeKey = input.orderRefHash
        ? `ord:${rule.cv_key}:${input.orderRefHash}`
        : `win:${rule.cv_key}:${recordedElFp}:${Math.floor(input.tMono / 2000)}`;
      if (this.conversionDedupeKeys.has(dedupeKey)) continue;
      this.conversionDedupeKeys.add(dedupeKey);

      matchedConversions.push(`${rule.cv_key}@${rule.rule_ver}`);
      this.pushLogItem({
        kind: 'conversion',
        t_mono: Math.round(input.tMono),
        el_fp: recordedElFp,
        cv_key: `${rule.cv_key}@${rule.rule_ver}`,
      });
    }

    const isOutbound =
      destKeyClick !== undefined &&
      destKeyClick !== 'tel_scheme' &&
      destKeyClick !== 'mailto_scheme' &&
      !destKeyClick.startsWith(new URL(this.pageOrigin).host.toLowerCase());

    return {
      isCritical:
        isOutbound ||
        matchedConversions.length > 0 ||
        activationKind === 'tel_link' ||
        activationKind === 'mailto_link',
      effectiveHref,
      matchedConversions,
    };
  }

  private matchesConversionRule(rule: NormalizedConversionRule, input: ClickEventInput): boolean {
    const vals = rule.predicate_values;
    if (vals.length === 0) return false;
    switch (rule.predicate_kind) {
      case 'id':
        return Boolean(input.elementId && vals.includes(input.elementId));
      case 'class':
        return Boolean(input.elementClasses?.some((c) => vals.includes(c)));
      case 'selector':
        return Boolean(input.elementSelector && vals.includes(input.elementSelector));
      case 'text':
        return Boolean(
          input.elementTextForRuleMatchOnly &&
            vals.some((v) => input.elementTextForRuleMatchOnly!.includes(v))
        );
      case 'href':
        return Boolean(input.href && vals.some((v) => input.href!.includes(v)));
      case 'href_prefix': {
        if (!input.href) return false;
        const rawHref = input.href;
        let resolvedHref: string | null = null;
        let resolvedPath: string | null = null;
        try {
          const parsed = new URL(rawHref, this.pageOrigin);
          resolvedHref = parsed.href;
          resolvedPath = parsed.pathname;
        } catch {
          // ignore malformed URL
        }
        return vals.some(
          (prefix) =>
            rawHref.startsWith(prefix) ||
            (resolvedHref !== null && resolvedHref.startsWith(prefix)) ||
            (resolvedPath !== null && resolvedPath.startsWith(prefix))
        );
      }
      case 'el_fp':
      case 'el_fp_set':
        return vals.includes(input.el_fp);
    }
  }

  public recordExplicitConversion(
    cvKey: string,
    ruleVer: number,
    tMono: number,
    orderRefHash?: string
  ): boolean {
    const dedupeKey = orderRefHash
      ? `ord:${cvKey}:${orderRefHash}`
      : `win:${cvKey}:api:${Math.floor(tMono / 2000)}`;
    if (this.conversionDedupeKeys.has(dedupeKey)) return false;
    this.conversionDedupeKeys.add(dedupeKey);
    this.pushLogItem({
      kind: 'conversion',
      t_mono: Math.round(tMono),
      cv_key: `${cvKey}@${ruleVer}`,
    });
    return true;
  }

  public recordCopy(blkFp: string): void {
    // NEVER read clipboard text — count ONLY (TEL A5 #3)
    let bReg = this.blocks.get(blkFp);
    if (!bReg) {
      bReg = {
        blk_fp: blkFp,
        alwaysWatch: true,
        inclusionProb: 1,
        vis_ms: 0,
        copy_n: 0,
        dirty: true,
      };
      this.blocks.set(blkFp, bReg);
    }
    bReg.copy_n += 1;
    bReg.dirty = true;
  }

  public recordMediaProgress(
    blkFp: string,
    playedMs: number,
    completed = false,
    incrementPlays = false
  ): void {
    let mReg = this.media.get(blkFp);
    if (!mReg) {
      mReg = { blk_fp: blkFp, played_ms: 0, plays: 1, completed: false, dirty: true };
      this.media.set(blkFp, mReg);
    } else if (incrementPlays) {
      mReg.plays += 1;
      mReg.dirty = true;
    }
    if (playedMs > mReg.played_ms) {
      mReg.played_ms = Math.round(playedMs);
      mReg.dirty = true;
    }
    if (completed && !mReg.completed) {
      mReg.completed = true;
      mReg.dirty = true;
    }
  }

  public recordJsError(errorName: string, lineNo: number, colNo: number): void {
    this.jsErrorN += 1;
    this.errorHashesDirty = true;
    const h = sha256Hex(`${errorName}:${lineNo}:${colNo}`).slice(0, 12);
    if (this.errorHashes.length < MAX_ERROR_HASHES && !this.errorHashes.includes(h)) {
      this.errorHashes.push(h);
    }
  }

  public recordVital(
    kind: 'lcp_ms' | 'inp_ms' | 'cls_x1000' | 'ttfb_ms',
    value: number,
    seq: number
  ): void {
    this.vitals = {
      ...this.vitals,
      [kind]: { value: Math.max(0, Math.round(value)), seq },
    };
    this.vitalsDirty = true;
  }

  public recordAnchorJump(tMono: number): void {
    this.pushLogItem({
      kind: 'anchor_jump',
      t_mono: Math.round(tMono),
    });
  }

  // =========================================================================
  // Replay Tier 0/1/2 Entitlement Gate (Owner Decision D-08)
  // =========================================================================

  /**
   * Evaluates whether integer-only kinematic timeline chunks (Tier 1 / Tier 2) are
   * permitted to leave the browser (§4.6 / TEL M6 / Owner Decision D-08).
   */
  public evaluateKinematicTimelineEmission(
    purposes: readonly ConsentPurpose[]
  ): ReplayEmissionDecision {
    // Verified hosted agent or own lab trace bypasses human D-08 restriction (actors M6)
    if (this.replayCfg.isVerifiedAgentOrLabTrace) {
      return {
        allowed: true,
        tier: 1,
        status: 'ok',
        reason: 'verified_agent_or_lab_trace',
      };
    }

    // Hard safety blocks: sensitive industry sites & PVs with password/payment fields
    if (this.replayCfg.sensitiveIndustrySite) {
      return {
        allowed: false,
        tier: 0,
        status: 'not_entitled',
        reason: 'sensitive_industry_site_disabled',
      };
    }
    if (this.hasSensitiveFieldOnPv) {
      return {
        allowed: false,
        tier: 0,
        status: 'not_entitled',
        reason: 'password_or_payment_field_present',
      };
    }

    // Check canonical ledger D-08 (unless explicitly approved & legally signed off)
    const ledgerCheck = requireDecisionEntitled('D-08', { enforceLegalSignOff: true });
    const explicitlyApproved =
      this.replayCfg.ownerDecisionD08Approved === true &&
      this.replayCfg.legalSignOffRecorded === true;

    if (!ledgerCheck.entitled && !explicitlyApproved) {
      return {
        allowed: false,
        tier: 0,
        status: 'not_entitled',
        reason: 'replay_decision_D08_pending',
      };
    }

    if (!this.replayCfg.serverRequestedTimeline) {
      return {
        allowed: false,
        tier: 0,
        status: 'ok',
        reason: 'awaiting_need_timeline',
      };
    }

    const tier: 1 | 2 = purposes.includes('timeline') ? 2 : 1;
    return {
      allowed: true,
      tier,
      status: 'ok',
      reason: tier === 2 ? 'tier2_timeline_consented' : 'tier1_aggregate_entitled',
    };
  }

  public getBufferedTimelineInts(): readonly number[] {
    return [...this.timelineRingInts];
  }

  // =========================================================================
  // Frame Register Extraction (Delta vs Full) & Log Item Ack Compaction
  // =========================================================================

  private pushLogItem(item: Omit<BrowserTelemetryLogItem, 'i'>): BrowserTelemetryLogItem {
    const fullItem: BrowserTelemetryLogItem = {
      i: this.nextLogOrdinal,
      ...item,
    };
    this.nextLogOrdinal += 1;
    this.logItems.push(fullItem);
    return fullItem;
  }

  public acknowledgeLogItems(ackedHighWater: number): void {
    let keepIdx = 0;
    while (keepIdx < this.logItems.length && this.logItems[keepIdx].i <= ackedHighWater) {
      keepIdx += 1;
    }
    if (keepIdx > 0) {
      this.logItems.splice(0, keepIdx);
    }
  }

  public markRegistersClean(): void {
    for (const s of this.sections.values()) s.dirty = false;
    for (const b of this.blocks.values()) b.dirty = false;
    for (const f of this.fields.values()) f.dirty = false;
    for (const fm of this.forms.values()) fm.dirty = false;
    for (const m of this.media.values()) m.dirty = false;
    this.vitalsDirty = false;
    this.errorHashesDirty = false;
  }

  public hasDirtyState(): boolean {
    if (this.logItems.length > 0) return true;
    if (this.vitalsDirty || this.errorHashesDirty) return true;
    if (this.sectionTokens.length > this.emittedSectionTokenCount) return true;
    for (const s of this.sections.values()) if (s.dirty) return true;
    for (const b of this.blocks.values()) if (b.dirty) return true;
    for (const f of this.fields.values()) if (f.dirty) return true;
    for (const fm of this.forms.values()) if (fm.dirty) return true;
    for (const m of this.media.values()) if (m.dirty) return true;
    return false;
  }

  public buildRegistersAndLogs(options: {
    readonly full: boolean;
    readonly purposes: readonly ConsentPurpose[];
    readonly tMono: number;
  }): {
    readonly sections: readonly BrowserSectionRegisterPayload[];
    readonly blocks: readonly BrowserBlockRegisterPayload[];
    readonly fields: readonly BrowserFieldRegisterPayload[];
    readonly forms: readonly BrowserFormRegisterPayload[];
    readonly media: readonly BrowserMediaRegisterPayload[];
    readonly vitals: VitalsRegisterPayload | undefined;
    readonly section_tokens: readonly string[];
    readonly error_hashes: readonly string[];
    readonly log_items: readonly BrowserTelemetryLogItem[];
  } {
    const sections: BrowserSectionRegisterPayload[] = [];
    for (const s of this.sections.values()) {
      if (options.full || s.dirty) {
        sections.push({
          sec_fp: s.sec_fp,
          vis_ms: s.vis_ms,
          t_first_ms: s.t_first_ms,
          entries: s.entries,
          max_frac_permille: s.max_frac_permille,
          gap_ms: [s.gap_ms[0], s.gap_ms[1], s.gap_ms[2], s.gap_ms[3]],
          vel_ms: [s.vel_ms[0], s.vel_ms[1], s.vel_ms[2], s.vel_ms[3]],
        });
      }
    }

    const blocks: BrowserBlockRegisterPayload[] = [];
    for (const b of this.blocks.values()) {
      if (options.full || b.dirty) {
        blocks.push({
          blk_fp: b.blk_fp,
          vis_ms: b.vis_ms,
          copy_n: b.copy_n,
          always_watch: b.alwaysWatch,
          sample_pi: b.inclusionProb,
        });
      }
    }

    const fields: BrowserFieldRegisterPayload[] = [];
    for (const f of this.fields.values()) {
      if (options.full || f.dirty) {
        fields.push({
          el_fp: f.el_fp,
          form_fp: f.form_fp,
          is_sensitive: f.isSensitive,
          order_idx: f.order_idx,
          focus_n: f.focus_n,
          focus_ms: f.focus_ms,
          first_input_latency_ms: f.first_input_latency_ms,
          refocus_n: f.refocus_n,
          edit_bursts: f.edit_bursts,
          correction_bursts: f.correction_bursts,
          composition_inputs: f.composition_inputs,
          total_inputs: f.total_inputs,
          invalid_n: f.invalid_n,
          validation_observable: f.validation_observable,
          filled_ever: f.filled_ever,
        });
      }
    }

    const forms: BrowserFormRegisterPayload[] = [];
    for (const fm of this.forms.values()) {
      if (options.full || fm.dirty) {
        forms.push({
          form_fp: fm.form_fp,
          started: fm.started,
          t_first_ms: fm.t_first_ms,
          submit_attempts: fm.submit_attempts,
          blocked_submits: fm.blocked_submits,
          last_field_fp: fm.last_field_fp,
        });
      }
    }

    const media: BrowserMediaRegisterPayload[] = [];
    for (const m of this.media.values()) {
      if (options.full || m.dirty) {
        media.push({
          blk_fp: m.blk_fp,
          played_ms: m.played_ms,
          plays: m.plays,
          completed: m.completed,
        });
      }
    }

    // Emit section_tokens log item when new focal section transitions occurred ([H-10])
    if (this.sectionTokens.length > this.emittedSectionTokenCount) {
      this.pushLogItem({
        kind: 'section_tokens',
        t_mono: Math.round(options.tMono),
        section_tokens: [...this.sectionTokens],
      });
      this.emittedSectionTokenCount = this.sectionTokens.length;
    }

    // Unacknowledged log items ride every frame (§4.1 / TEL M1)
    const outgoingLogs: BrowserTelemetryLogItem[] = [...this.logItems];

    // Kinematic timeline_chunk leaves the browser ONLY when D-08 entitlement passes!
    const replayDecision = this.evaluateKinematicTimelineEmission(options.purposes);
    if (replayDecision.allowed && this.timelineRingInts.length > 0) {
      const chunkItem = this.pushLogItem({
        kind: 'timeline_chunk',
        t_mono: Math.round(options.tMono),
        timeline_ints: [...this.timelineRingInts],
      });
      outgoingLogs.push(chunkItem);
      this.timelineRingInts.length = 0;
    }

    const hasVitals = Object.keys(this.vitals).length > 0 && (options.full || this.vitalsDirty);

    return {
      sections,
      blocks,
      fields,
      forms,
      media,
      vitals: hasVitals ? { ...this.vitals } : undefined,
      section_tokens: [...this.sectionTokens],
      error_hashes: [...this.errorHashes],
      log_items: outgoingLogs,
    };
  }
}
