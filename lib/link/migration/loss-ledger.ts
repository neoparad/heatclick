/**
 * UGOKI LINK v2 — 11-Class Telemetry Loss Ledger (§4.4 / telemetry-final.md Appendix A2)
 *
 * Strictly classifies and counts all 11 loss classes (L0..L10) per
 * `site × day × device × browser_family` (treating in-app browsers as distinct
 * families), computes Wilson 95% confidence intervals, checks ceiling breaches,
 * and produces the `MeasurementBlock` summary attached to every response envelope.
 */

import { getConstant } from '../../../packages/contract/ledgers';
import type { MeasurementBlock } from '../../../packages/contract/response';

export const LOSS_CLASSES = [
  'L0_loader_never_fetched',
  'L1_loader_fetched_no_frame',
  'L2_ended_before_sdk_start',
  'L3_intermediate_unacked_gap',
  'L4_terminal_frame_unconfirmed',
  'L5_post_ack_loss',
  'L6_quarantine_and_field_drop',
  'L7_coarsening_cap_hit',
  'L8_degrade_ladder',
  'L9_field_dark',
  'L10_consent_optout_privacy',
] as const;

export type LossClassId = (typeof LOSS_CLASSES)[number];

export interface LossClassDescriptor {
  readonly id: LossClassId;
  readonly code: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10';
  readonly labelJa: string;
  readonly denominatorKind: 'server_docs' | 'loader_fetches' | 'pvs' | 'frames' | 'acked_frames' | 'fields';
  readonly defaultMaxRateAlert: number | null;
}

export const LOSS_CLASS_CATALOG: Readonly<Record<LossClassId, LossClassDescriptor>> = {
  L0_loader_never_fetched: {
    id: 'L0_loader_never_fetched',
    code: 'L0',
    labelJa: 'スクリプト未取得（ブロッカー・JS無効・HTML専用クライアント）',
    denominatorKind: 'server_docs',
    defaultMaxRateAlert: 0.35,
  },
  L1_loader_fetched_no_frame: {
    id: 'L1_loader_fetched_no_frame',
    code: 'L1',
    labelJa: 'スクリプト取得済・初回送信なし（connect-src遮断・エラー等）',
    denominatorKind: 'loader_fetches',
    defaultMaxRateAlert: 0.15,
  },
  L2_ended_before_sdk_start: {
    id: 'L2_ended_before_sdk_start',
    code: 'L2',
    labelJa: 'SDK起動前の即時離脱',
    denominatorKind: 'loader_fetches',
    defaultMaxRateAlert: 0.1,
  },
  L3_intermediate_unacked_gap: {
    id: 'L3_intermediate_unacked_gap',
    code: 'L3',
    labelJa: '途中の未確認フレーム欠損（seq_gap）',
    denominatorKind: 'frames',
    defaultMaxRateAlert: 0.05,
  },
  L4_terminal_frame_unconfirmed: {
    id: 'L4_terminal_frame_unconfirmed',
    code: 'L4',
    labelJa: 'タブ閉じ・離脱時の末尾フレーム未確認（terminal_unconfirmed）',
    denominatorKind: 'pvs',
    defaultMaxRateAlert: 0.35,
  },
  L5_post_ack_loss: {
    id: 'L5_post_ack_loss',
    code: 'L5',
    labelJa: '確認応答後のデータ損失（ack_echo_seq / chk 不一致）',
    denominatorKind: 'acked_frames',
    defaultMaxRateAlert: 0.0001, // tel.post_ack_loss_max_rate
  },
  L6_quarantine_and_field_drop: {
    id: 'L6_quarantine_and_field_drop',
    code: 'L6',
    labelJa: '検証隔離・項目切り捨て／クランプ（quarantine / drop_flag / clamp_flag）',
    denominatorKind: 'frames',
    defaultMaxRateAlert: 0.01,
  },
  L7_coarsening_cap_hit: {
    id: 'L7_coarsening_cap_hit',
    code: 'L7',
    labelJa: '上限到達による粗化（cap_hit / ブロック→区画折畳み）',
    denominatorKind: 'pvs',
    defaultMaxRateAlert: 0.05,
  },
  L8_degrade_ladder: {
    id: 'L8_degrade_ladder',
    code: 'L8',
    labelJa: '重い端末での段階的機能縮退（degrade_level > 0）',
    denominatorKind: 'pvs',
    defaultMaxRateAlert: 0.05, // tel.G16 ceiling
  },
  L9_field_dark: {
    id: 'L9_field_dark',
    code: 'L9',
    labelJa: 'ブラウザ・サイト変更による項目充填率崩壊（field_dark -> not_collected）',
    denominatorKind: 'fields',
    defaultMaxRateAlert: 0.01,
  },
  L10_consent_optout_privacy: {
    id: 'L10_consent_optout_privacy',
    code: 'L10',
    labelJa: '同意拒否・オプトアウト・プライバシー信号による除外',
    denominatorKind: 'server_docs',
    defaultMaxRateAlert: null, // Legal/consent choice, tracked without defect alarm
  },
};

export interface LossSliceKey {
  readonly tenantId: string;
  readonly siteId: string;
  readonly dayUtc: string; // YYYY-MM-DD
  readonly deviceClass: 'mobile' | 'desktop' | 'tablet';
  /** In-app browsers MUST be distinct families (e.g. `line_inapp`, `yahoo_jp_inapp`, `google_inapp`). */
  readonly browserFamily: string;
}

export interface LossSliceDenominators {
  readonly serverDocumentRequests: number;
  readonly loaderFetches: number;
  readonly pvs: number;
  readonly frames: number;
  readonly ackedFrames: number;
  readonly fieldsExpected: number;
  readonly stateIncompletePvs?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface WilsonInterval {
  readonly lower: number;
  readonly upper: number;
  readonly halfWidth: number;
}

export interface LossClassMetric {
  readonly lossClass: LossClassId;
  readonly code: LossClassDescriptor['code'];
  readonly count: number;
  readonly denominator: number;
  readonly observable: boolean;
  readonly rate: number | null;
  readonly wilson95: WilsonInterval | null;
  readonly maxAllowedRate: number | null;
  readonly breached: boolean;
}

export interface LossLedgerAlert {
  readonly lossClass: LossClassId;
  readonly code: string;
  readonly observedRate: number;
  readonly upper95Rate: number;
  readonly threshold: number;
  readonly severity: 'sev1' | 'sev2' | 'warn';
  readonly message: string;
}

export interface LossSliceReport {
  readonly slice: LossSliceKey;
  readonly denominators: LossSliceDenominators;
  readonly classes: Readonly<Record<LossClassId, LossClassMetric>>;
  readonly alerts: readonly LossLedgerAlert[];
  readonly measurementBlock: MeasurementBlock;
}

/**
 * Exact 95% Wilson score confidence interval (`z = 1.959963984540054`).
 */
export function computeWilson95(successes: number, trials: number): WilsonInterval {
  if (trials <= 0) {
    return { lower: 0, upper: 1, halfWidth: 0.5 };
  }
  const k = Math.max(0, Math.min(successes, trials));
  const p = k / trials;
  const z = 1.959963984540054;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    lower: Number(lower.toFixed(6)),
    upper: Number(upper.toFixed(6)),
    halfWidth: Number(((upper - lower) / 2).toFixed(6)),
  };
}

function resolvePostAckThreshold(): number {
  const entry = getConstant('tel.post_ack_loss_max_rate');
  return typeof entry?.value === 'number' ? entry.value : 0.0001;
}

function resolveStateIncompleteThreshold(): number {
  const entry = getConstant('tel.state_incomplete_max_rate');
  return typeof entry?.value === 'number' ? entry.value : 0.001;
}

function sliceCompositeKey(slice: LossSliceKey): string {
  return `${slice.tenantId}\u0000${slice.siteId}\u0000${slice.dayUtc}\u0000${slice.deviceClass}\u0000${slice.browserFamily}`;
}

interface MutableSliceState {
  readonly slice: LossSliceKey;
  denominators: {
    serverDocumentRequests: number;
    loaderFetches: number;
    pvs: number;
    frames: number;
    ackedFrames: number;
    fieldsExpected: number;
    stateIncompletePvs: number;
    heartbeatIntervalMs: number;
  };
  readonly counts: Record<LossClassId, number>;
}

/**
 * In-memory 11-class telemetry loss ledger supporting incremental accumulation
 * and structured reporting per `site × day × device × browser_family`.
 */
export class TelemetryLossLedger {
  private readonly slices = new Map<string, MutableSliceState>();
  private readonly customThresholds: Partial<Record<LossClassId, number | null>>;

  public constructor(options?: {
    readonly thresholdOverrides?: Partial<Record<LossClassId, number | null>>;
  }) {
    this.customThresholds = options?.thresholdOverrides ?? {};
  }

  private getOrCreate(slice: LossSliceKey): MutableSliceState {
    const key = sliceCompositeKey(slice);
    let state = this.slices.get(key);
    if (!state) {
      const counts = {} as Record<LossClassId, number>;
      for (const id of LOSS_CLASSES) {
        counts[id] = 0;
      }
      state = {
        slice,
        denominators: {
          serverDocumentRequests: 0,
          loaderFetches: 0,
          pvs: 0,
          frames: 0,
          ackedFrames: 0,
          fieldsExpected: 0,
          stateIncompletePvs: 0,
          heartbeatIntervalMs: 10_000,
        },
        counts,
      };
      this.slices.set(key, state);
    }
    return state;
  }

  public addDenominators(
    slice: LossSliceKey,
    delta: Partial<LossSliceDenominators>
  ): void {
    const st = this.getOrCreate(slice);
    st.denominators.serverDocumentRequests += delta.serverDocumentRequests ?? 0;
    st.denominators.loaderFetches += delta.loaderFetches ?? 0;
    st.denominators.pvs += delta.pvs ?? 0;
    st.denominators.frames += delta.frames ?? 0;
    st.denominators.ackedFrames += delta.ackedFrames ?? 0;
    st.denominators.fieldsExpected += delta.fieldsExpected ?? 0;
    st.denominators.stateIncompletePvs += delta.stateIncompletePvs ?? 0;
    if (delta.heartbeatIntervalMs !== undefined) {
      st.denominators.heartbeatIntervalMs = delta.heartbeatIntervalMs;
    }
  }

  public recordLoss(
    slice: LossSliceKey,
    lossClass: LossClassId,
    count = 1
  ): void {
    if (count < 0 || !Number.isFinite(count)) {
      throw new Error(`Loss count must be non-negative finite number, got ${count}`);
    }
    const st = this.getOrCreate(slice);
    st.counts[lossClass] += count;
  }

  public evaluateSlice(slice: LossSliceKey): LossSliceReport {
    const st = this.getOrCreate(slice);
    const d = st.denominators;

    const classes = {} as Record<LossClassId, LossClassMetric>;
    const alerts: LossLedgerAlert[] = [];

    for (const id of LOSS_CLASSES) {
      const desc = LOSS_CLASS_CATALOG[id];
      const count = st.counts[id];

      let denominator = 0;
      switch (desc.denominatorKind) {
        case 'server_docs':
          denominator = d.serverDocumentRequests;
          break;
        case 'loader_fetches':
          denominator = d.loaderFetches;
          break;
        case 'pvs':
          denominator = d.pvs;
          break;
        case 'frames':
          denominator = d.frames;
          break;
        case 'acked_frames':
          denominator = d.ackedFrames;
          break;
        case 'fields':
          denominator = d.fieldsExpected;
          break;
      }

      const threshold =
        id in this.customThresholds
          ? (this.customThresholds[id] ?? null)
          : id === 'L5_post_ack_loss'
            ? resolvePostAckThreshold()
            : desc.defaultMaxRateAlert;

      const observable = denominator > 0;
      const rate = observable ? count / denominator : null;
      const wilson95 = observable ? computeWilson95(count, denominator) : null;

      // For L5 (post-ack loss), gate tests against upper 95% bound OR point rate if count > 0
      const breached =
        observable &&
        threshold !== null &&
        rate !== null &&
        wilson95 !== null &&
        (id === 'L5_post_ack_loss'
          ? count > 0 && wilson95.upper > threshold
          : rate > threshold);

      classes[id] = {
        lossClass: id,
        code: desc.code,
        count,
        denominator,
        observable,
        rate: rate !== null ? Number(rate.toFixed(6)) : null,
        wilson95,
        maxAllowedRate: threshold,
        breached,
      };

      if (breached && rate !== null && wilson95 !== null && threshold !== null) {
        alerts.push({
          lossClass: id,
          code: desc.code,
          observedRate: Number(rate.toFixed(6)),
          upper95Rate: wilson95.upper,
          threshold,
          severity:
            id === 'L5_post_ack_loss' || id === 'L9_field_dark' ? 'sev1' : 'sev2',
          message: `${desc.code} (${id}) exceeded ceiling ${threshold}: observed ${(rate * 100).toFixed(3)}% (95% CI upper ${(wilson95.upper * 100).toFixed(3)}%)`,
        });
      }
    }

    // Check state_incomplete rate against ledger constant `tel.state_incomplete_max_rate`
    const stateIncThreshold = resolveStateIncompleteThreshold();
    const stateIncompleteRate =
      d.pvs > 0 ? d.stateIncompletePvs / d.pvs : 0;
    if (d.pvs > 0 && stateIncompleteRate > stateIncThreshold) {
      alerts.push({
        lossClass: 'L5_post_ack_loss',
        code: 'STATE_INCOMPLETE',
        observedRate: Number(stateIncompleteRate.toFixed(6)),
        upper95Rate: computeWilson95(d.stateIncompletePvs, d.pvs).upper,
        threshold: stateIncThreshold,
        severity: 'sev1',
        message: `state_incomplete rate ${(stateIncompleteRate * 100).toFixed(3)}% exceeded ceiling ${(stateIncThreshold * 100).toFixed(3)}%`,
      });
    }

    const l4 = classes.L4_terminal_frame_unconfirmed;
    const measurementBlock: MeasurementBlock = {
      ...(l4.wilson95
        ? { terminal_unconfirmed: [l4.wilson95.lower, l4.wilson95.upper] as const }
        : {}),
      tail_bound_ms: d.heartbeatIntervalMs,
      ...(classes.L5_post_ack_loss.rate !== null
        ? { post_ack_loss: classes.L5_post_ack_loss.rate }
        : {}),
      state_incomplete: Number(stateIncompleteRate.toFixed(6)),
      ...(classes.L3_intermediate_unacked_gap.rate !== null
        ? { seq_gap: classes.L3_intermediate_unacked_gap.rate }
        : {}),
      ...(classes.L6_quarantine_and_field_drop.rate !== null
        ? { quarantine: classes.L6_quarantine_and_field_drop.rate }
        : {}),
    };

    return {
      slice,
      denominators: { ...d },
      classes,
      alerts,
      measurementBlock,
    };
  }
}
