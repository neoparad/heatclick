/**
 * UGOKI LINK v2 — Deterministic Commutative/Idempotent PV State Merger & Placement Calculator
 *
 * Implements the 5 merge classes (`max`, `min`, `set`, `bitOr`, `argMax_seq`)
 * defined in Master Spec §4.1 / §5.1 & `store-final.md` M1/A2 so any sequence
 * of dropped, duplicated, reordered, or regrouped frames converges to the exact
 * browser state at the highest delivered `seq`.
 */

import type { TelemetryFrame, TelemetryLogItem } from '../../packages/contract/schema';
import type {
  ArgMaxRegister,
  MergedBlockState,
  MergedEventRow,
  MergedFieldState,
  MergedFormState,
  MergedMediaState,
  MergedPvState,
  MergedSectionState,
  MergedVitalsState,
  PvPlacement,
} from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Pure algebraic merge primitives (commutative, associative, idempotent).
 */
export function mergeMax(a: number, b: number): number {
  return a >= b ? a : b;
}

export function mergeMin(a: number, b: number): number {
  return a <= b ? a : b;
}

export function mergeBitOr(a: number, b: number): number {
  return (a | b) >>> 0;
}

export function mergeSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>(a);
  for (const item of b) {
    out.add(item);
  }
  return out;
}

/**
 * Deterministic `argMax_seq` with `(seq, frameHash)` tie-breaking:
 * higher `seq` wins; if `seq` is identical, lexicographically greater
 * `frameHash` wins so merging in any order produces identical state.
 */
export function mergeArgMaxSeq<T>(
  current: ArgMaxRegister<T> | null,
  incoming: ArgMaxRegister<T> | null
): ArgMaxRegister<T> | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  if (incoming.seq > current.seq) return incoming;
  if (incoming.seq < current.seq) return current;
  return incoming.frameHash >= current.frameHash ? incoming : current;
}

export function mergeArgMaxSeqRequired<T>(
  current: ArgMaxRegister<T>,
  incoming: ArgMaxRegister<T>
): ArgMaxRegister<T> {
  if (incoming.seq > current.seq) return incoming;
  if (incoming.seq < current.seq) return current;
  return incoming.frameHash >= current.frameHash ? incoming : current;
}

/**
 * Computes UTC hour floor in epoch milliseconds.
 */
export function floorUtcHourMs(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

const HOUR_ISO_CACHE = new Map<number, string>();
const DAY_MONDAY_CACHE = new Map<number, string>();

function getCachedHourIso(pvHourMs: number): string {
  let iso = HOUR_ISO_CACHE.get(pvHourMs);
  if (iso === undefined) {
    iso = new Date(pvHourMs).toISOString();
    if (HOUR_ISO_CACHE.size > 512) HOUR_ISO_CACHE.clear();
    HOUR_ISO_CACHE.set(pvHourMs, iso);
  }
  return iso;
}

/**
 * Computes Monday (`YYYY-MM-DD`, UTC) of the week containing `timestampMs`.
 */
export function toUtcMondayDateString(timestampMs: number): string {
  const dayKey = Math.floor(timestampMs / DAY_MS);
  const cached = DAY_MONDAY_CACHE.get(dayKey);
  if (cached !== undefined) return cached;

  const d = new Date(timestampMs);
  const utcDay = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offsetFromMonday = utcDay === 0 ? 6 : utcDay - 1;
  const mondayMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - offsetFromMonday
  );
  const monday = new Date(mondayMs);
  const yyyy = monday.getUTCFullYear().toString().padStart(4, '0');
  const mm = (monday.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = monday.getUTCDate().toString().padStart(2, '0');
  const formatted = `${yyyy}-${mm}-${dd}`;
  if (DAY_MONDAY_CACHE.size > 512) DAY_MONDAY_CACHE.clear();
  DAY_MONDAY_CACHE.set(dayKey, formatted);
  return formatted;
}

/**
 * Computes server-side PV start estimate clamped within `[received_at - 24h, received_at]`
 * (`store-final.md` A2). Never relies on client wall clock (`t_wall`).
 */
export function estimatePvStartSrvMs(
  receivedAtMs: number,
  tMonoMs: number,
  ageMs = 0
): number {
  const safeTMono = Math.max(0, Math.floor(tMonoMs));
  const safeAge = Math.max(0, Math.floor(ageMs));
  const rawEstimate = receivedAtMs - safeTMono - safeAge;
  const minAllowed = receivedAtMs - DAY_MS;
  if (rawEstimate < minAllowed) return minAllowed;
  if (rawEstimate > receivedAtMs) return receivedAtMs;
  return rawEstimate;
}

/**
 * Assigns immutable once-per-PV placement (`store-final.md` M1 / A2).
 */
export function computeInitialPlacement(args: {
  readonly tenantId: string;
  readonly siteId: string;
  readonly pvId: string;
  readonly urlId: string;
  readonly keyVer: number;
  readonly profileRev: number;
  readonly receivedAtMs: number;
  readonly tMonoMs: number;
  readonly ageMs?: number;
  readonly retentionDays: number;
}): PvPlacement {
  const pvStartSrvMs = estimatePvStartSrvMs(
    args.receivedAtMs,
    args.tMonoMs,
    args.ageMs ?? 0
  );
  const pvHourMs = floorUtcHourMs(pvStartSrvMs);
  const expiryMs = pvStartSrvMs + Math.max(1, args.retentionDays) * DAY_MS;
  const expWeek = toUtcMondayDateString(expiryMs);

  return {
    tenantId: args.tenantId,
    siteId: args.siteId,
    pvId: args.pvId,
    urlId: args.urlId,
    keyVer: args.keyVer,
    profileRev: args.profileRev,
    pvStartSrvMs,
    pvHourMs,
    pvHourIso: getCachedHourIso(pvHourMs),
    retentionDays: args.retentionDays,
    expWeek,
    placementBiasMs: 0,
  };
}

/**
 * Fast deterministic 64-bit hex fingerprint for log-item conflict detection.
 */
export function computeLogItemContentHash(item: TelemetryLogItem): string {
  const str = `${item.i}|${item.kind}|${item.t_mono}|${item.activation_kind ?? ''}|${item.el_fp ?? ''}|${item.dest_key_click ?? ''}|${item.cv_key ?? ''}|${item.ec_product_id ?? ''}|${item.exposure_decision_id ?? ''}|${item.exposure_kind ?? ''}|${item.exposure_reason ?? ''}|${item.timeline_ints ? item.timeline_ints.join(',') : ''}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let idx = 0; idx < str.length; idx += 1) {
    const c = str.charCodeAt(idx);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c + idx) & 0xffff), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Fast deterministic 64-bit frame hash when a caller runs high-throughput
 * simulations (100,000+ schedules) without SHA-256 overhead.
 */
export function computeFastFrameHash(frame: TelemetryFrame): string {
  const s = `${frame.pv_id}|${frame.seq}|${frame.t_mono}|${frame.live_word}|${frame.state.scroll_max_px}|${frame.state.vis_ms}|${frame.state.doc_h_last.value}|${frame.state.doc_h_last.seq}|${frame.log_items.length}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x27d4eb2f) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Idempotently merges a single validated `TelemetryFrame` into an existing
 * `MergedPvState` (or creates the initial state if `existing` is null).
 *
 * Commutative & associative across all frames of the same PV regardless of
 * duplicates, reordering, or batch regrouping.
 */
export function mergeFrameIntoPvState(
  existing: MergedPvState | null,
  frame: TelemetryFrame,
  frameHash: string,
  placement: PvPlacement,
  stateIncomplete = false
): MergedPvState {
  const seq = frame.seq;

  if (existing === null) {
    const sections = new Map<string, MergedSectionState>();
    for (const sec of frame.sections) {
      const prev = sections.get(sec.sec_fp);
      if (!prev) {
        sections.set(sec.sec_fp, { ...sec });
      } else {
        sections.set(sec.sec_fp, {
          sec_fp: sec.sec_fp,
          vis_ms: mergeMax(prev.vis_ms, sec.vis_ms),
          t_first_ms: mergeMin(prev.t_first_ms, sec.t_first_ms),
          entries: mergeMax(prev.entries, sec.entries),
          max_frac_permille: mergeMax(prev.max_frac_permille, sec.max_frac_permille),
        });
      }
    }

    const blocks = new Map<string, MergedBlockState>();
    if (frame.blocks) {
      for (const blk of frame.blocks) {
        const prev = blocks.get(blk.blk_fp);
        blocks.set(
          blk.blk_fp,
          prev
            ? {
                blk_fp: blk.blk_fp,
                vis_ms: mergeMax(prev.vis_ms, blk.vis_ms),
                copy_n: mergeMax(prev.copy_n, blk.copy_n),
              }
            : { ...blk }
        );
      }
    }

    const fields = new Map<string, MergedFieldState>();
    if (frame.fields) {
      for (const fld of frame.fields) {
        const prev = fields.get(fld.el_fp);
        fields.set(
          fld.el_fp,
          prev
            ? {
                el_fp: fld.el_fp,
                focus_ms: mergeMax(prev.focus_ms, fld.focus_ms),
                invalid_n: mergeMax(prev.invalid_n, fld.invalid_n),
              }
            : { ...fld }
        );
      }
    }

    const forms = new Map<string, MergedFormState>();
    if (frame.forms) {
      for (const frm of frame.forms) {
        const prev = forms.get(frm.form_fp);
        forms.set(
          frm.form_fp,
          prev
            ? {
                form_fp: frm.form_fp,
                submit_attempts: mergeMax(prev.submit_attempts, frm.submit_attempts),
              }
            : { ...frm }
        );
      }
    }

    const media = new Map<string, MergedMediaState>();
    if (frame.media) {
      for (const m of frame.media) {
        const prev = media.get(m.blk_fp);
        media.set(
          m.blk_fp,
          prev
            ? {
                blk_fp: m.blk_fp,
                played_ms: mergeMax(prev.played_ms, m.played_ms),
              }
            : { ...m }
        );
      }
    }

    const vitals: MergedVitalsState = {
      lcp_ms: frame.vitals?.lcp_ms
        ? { value: frame.vitals.lcp_ms.value, seq: frame.vitals.lcp_ms.seq, frameHash }
        : null,
      inp_ms: frame.vitals?.inp_ms
        ? { value: frame.vitals.inp_ms.value, seq: frame.vitals.inp_ms.seq, frameHash }
        : null,
      cls_x1000: frame.vitals?.cls_x1000
        ? { value: frame.vitals.cls_x1000.value, seq: frame.vitals.cls_x1000.seq, frameHash }
        : null,
      ttfb_ms: frame.vitals?.ttfb_ms
        ? { value: frame.vitals.ttfb_ms.value, seq: frame.vitals.ttfb_ms.seq, frameHash }
        : null,
    };

    const events = new Map<number, MergedEventRow>();
    let logConflictCount = 0;
    for (const item of frame.log_items) {
      const contentHash = computeLogItemContentHash(item);
      const prev = events.get(item.i);
      if (!prev) {
        events.set(item.i, {
          tenantId: placement.tenantId,
          siteId: placement.siteId,
          pvHourMs: placement.pvHourMs,
          urlId: placement.urlId,
          pvId: placement.pvId,
          log_i: item.i,
          item,
          contentHash,
          conflictDetected: false,
        });
      } else if (prev.contentHash !== contentHash && !prev.conflictDetected) {
        logConflictCount += 1;
        events.set(item.i, { ...prev, conflictDetected: true });
      }
    }

    return {
      placement,
      maxSeq: seq,
      seenSeqs: new Set<number>([seq]),
      maxAckEchoSeq: frame.ack_echo_seq,
      visEpisode: frame.vis_episode,
      maxTMono: frame.t_mono,
      minTMono: frame.t_mono,
      tWall: { value: frame.t_wall, seq, frameHash },
      consentMode: { value: frame.consent_mode, seq, frameHash },
      purposes: { value: [...frame.purposes].sort(), seq, frameHash },
      pageUrlKey: frame.state.page_url_key,
      navType: frame.state.nav_type,
      startedHidden: frame.state.started_hidden,
      scrollMaxPx: frame.state.scroll_max_px,
      docHFirst: frame.state.doc_h_first,
      docHMax: frame.state.doc_h_max,
      docHLast: {
        value: frame.state.doc_h_last.value,
        seq: frame.state.doc_h_last.seq,
        frameHash,
      },
      visMs: frame.state.vis_ms,
      reversals: frame.state.reversals,
      jsErrorN: frame.state.js_error_n,
      degradeLevel: frame.state.degrade_level,
      liveWord: frame.live_word >>> 0,
      keyDegraded: frame.key_degraded,
      domState: { value: frame.state.dom_state, seq, frameHash },
      skelFp: { value: frame.state.skel_fp, seq, frameHash },
      cssFp: { value: frame.state.css_fp ?? null, seq, frameHash },
      headFp: { value: frame.state.head_fp ?? null, seq, frameHash },
      variantKey: { value: frame.state.variant_key, seq, frameHash },
      samplePi: { value: frame.state.sample_pi, seq, frameHash },
      stateIncomplete,
      sections,
      blocks,
      fields,
      forms,
      media,
      vitals,
      events,
      logConflictCount,
      visitorId: frame.visitor_id ?? null,
      sessionId: frame.session_id ?? null,
    };
  }

  // Merge into existing state
  const seenSeqs = new Set<number>(existing.seenSeqs);
  seenSeqs.add(seq);

  const sections = new Map<string, MergedSectionState>(existing.sections);
  for (const sec of frame.sections) {
    const prev = sections.get(sec.sec_fp);
    if (!prev) {
      sections.set(sec.sec_fp, { ...sec });
    } else {
      sections.set(sec.sec_fp, {
        sec_fp: sec.sec_fp,
        vis_ms: mergeMax(prev.vis_ms, sec.vis_ms),
        t_first_ms: mergeMin(prev.t_first_ms, sec.t_first_ms),
        entries: mergeMax(prev.entries, sec.entries),
        max_frac_permille: mergeMax(prev.max_frac_permille, sec.max_frac_permille),
      });
    }
  }

  const blocks = new Map<string, MergedBlockState>(existing.blocks);
  if (frame.blocks) {
    for (const blk of frame.blocks) {
      const prev = blocks.get(blk.blk_fp);
      blocks.set(
        blk.blk_fp,
        prev
          ? {
              blk_fp: blk.blk_fp,
              vis_ms: mergeMax(prev.vis_ms, blk.vis_ms),
              copy_n: mergeMax(prev.copy_n, blk.copy_n),
            }
          : { ...blk }
      );
    }
  }

  const fields = new Map<string, MergedFieldState>(existing.fields);
  if (frame.fields) {
    for (const fld of frame.fields) {
      const prev = fields.get(fld.el_fp);
      fields.set(
        fld.el_fp,
        prev
          ? {
              el_fp: fld.el_fp,
              focus_ms: mergeMax(prev.focus_ms, fld.focus_ms),
              invalid_n: mergeMax(prev.invalid_n, fld.invalid_n),
            }
          : { ...fld }
      );
    }
  }

  const forms = new Map<string, MergedFormState>(existing.forms);
  if (frame.forms) {
    for (const frm of frame.forms) {
      const prev = forms.get(frm.form_fp);
      forms.set(
        frm.form_fp,
        prev
          ? {
              form_fp: frm.form_fp,
              submit_attempts: mergeMax(prev.submit_attempts, frm.submit_attempts),
            }
          : { ...frm }
      );
    }
  }

  const media = new Map<string, MergedMediaState>(existing.media);
  if (frame.media) {
    for (const m of frame.media) {
      const prev = media.get(m.blk_fp);
      media.set(
        m.blk_fp,
        prev
          ? {
              blk_fp: m.blk_fp,
              played_ms: mergeMax(prev.played_ms, m.played_ms),
            }
          : { ...m }
      );
    }
  }

  const vitals: MergedVitalsState = {
    lcp_ms: mergeArgMaxSeq(
      existing.vitals.lcp_ms,
      frame.vitals?.lcp_ms
        ? { value: frame.vitals.lcp_ms.value, seq: frame.vitals.lcp_ms.seq, frameHash }
        : null
    ),
    inp_ms: mergeArgMaxSeq(
      existing.vitals.inp_ms,
      frame.vitals?.inp_ms
        ? { value: frame.vitals.inp_ms.value, seq: frame.vitals.inp_ms.seq, frameHash }
        : null
    ),
    cls_x1000: mergeArgMaxSeq(
      existing.vitals.cls_x1000,
      frame.vitals?.cls_x1000
        ? { value: frame.vitals.cls_x1000.value, seq: frame.vitals.cls_x1000.seq, frameHash }
        : null
    ),
    ttfb_ms: mergeArgMaxSeq(
      existing.vitals.ttfb_ms,
      frame.vitals?.ttfb_ms
        ? { value: frame.vitals.ttfb_ms.value, seq: frame.vitals.ttfb_ms.seq, frameHash }
        : null
    ),
  };

  const events = new Map<number, MergedEventRow>(existing.events);
  let logConflictCount = existing.logConflictCount;
  for (const item of frame.log_items) {
    const contentHash = computeLogItemContentHash(item);
    const prev = events.get(item.i);
    if (!prev) {
      events.set(item.i, {
        tenantId: existing.placement.tenantId,
        siteId: existing.placement.siteId,
        pvHourMs: existing.placement.pvHourMs,
        urlId: existing.placement.urlId,
        pvId: existing.placement.pvId,
        log_i: item.i,
        item,
        contentHash,
        conflictDetected: false,
      });
    } else if (prev.contentHash !== contentHash && !prev.conflictDetected) {
      logConflictCount += 1;
      events.set(item.i, { ...prev, conflictDetected: true });
    }
  }

  return {
    placement: existing.placement, // NEVER mutates placement once assigned!
    maxSeq: mergeMax(existing.maxSeq, seq),
    seenSeqs,
    maxAckEchoSeq: mergeMax(existing.maxAckEchoSeq, frame.ack_echo_seq),
    visEpisode: mergeMax(existing.visEpisode, frame.vis_episode),
    maxTMono: mergeMax(existing.maxTMono, frame.t_mono),
    minTMono: mergeMin(existing.minTMono, frame.t_mono),
    tWall: mergeArgMaxSeqRequired(existing.tWall, {
      value: frame.t_wall,
      seq,
      frameHash,
    }),
    consentMode: mergeArgMaxSeqRequired(existing.consentMode, {
      value: frame.consent_mode,
      seq,
      frameHash,
    }),
    purposes: mergeArgMaxSeqRequired(existing.purposes, {
      value: [...frame.purposes].sort(),
      seq,
      frameHash,
    }),
    pageUrlKey: existing.pageUrlKey,
    navType: existing.navType,
    startedHidden: existing.startedHidden,
    scrollMaxPx: mergeMax(existing.scrollMaxPx, frame.state.scroll_max_px),
    docHFirst: mergeMin(existing.docHFirst, frame.state.doc_h_first),
    docHMax: mergeMax(existing.docHMax, frame.state.doc_h_max),
    docHLast: mergeArgMaxSeqRequired(existing.docHLast, {
      value: frame.state.doc_h_last.value,
      seq: frame.state.doc_h_last.seq,
      frameHash,
    }),
    visMs: mergeMax(existing.visMs, frame.state.vis_ms),
    reversals: mergeMax(existing.reversals, frame.state.reversals),
    jsErrorN: mergeMax(existing.jsErrorN, frame.state.js_error_n),
    degradeLevel: mergeMax(existing.degradeLevel, frame.state.degrade_level),
    liveWord: mergeBitOr(existing.liveWord, frame.live_word),
    keyDegraded: existing.keyDegraded || frame.key_degraded,
    domState: mergeArgMaxSeqRequired(existing.domState, {
      value: frame.state.dom_state,
      seq,
      frameHash,
    }),
    skelFp: mergeArgMaxSeqRequired(existing.skelFp, {
      value: frame.state.skel_fp,
      seq,
      frameHash,
    }),
    cssFp: mergeArgMaxSeqRequired(existing.cssFp, {
      value: frame.state.css_fp ?? null,
      seq,
      frameHash,
    }),
    headFp: mergeArgMaxSeqRequired(existing.headFp, {
      value: frame.state.head_fp ?? null,
      seq,
      frameHash,
    }),
    variantKey: mergeArgMaxSeqRequired(existing.variantKey, {
      value: frame.state.variant_key,
      seq,
      frameHash,
    }),
    samplePi: mergeArgMaxSeqRequired(existing.samplePi, {
      value: frame.state.sample_pi,
      seq,
      frameHash,
    }),
    stateIncomplete: existing.stateIncomplete || stateIncomplete,
    sections,
    blocks,
    fields,
    forms,
    media,
    vitals,
    events,
    logConflictCount,
    visitorId: existing.visitorId ?? frame.visitor_id ?? null,
    sessionId: existing.sessionId ?? frame.session_id ?? null,
  };
}

/**
 * Compares two `MergedPvState` instances for semantic equivalence across all
 * cumulative registers, maps, vitals, and deduplicated log items (ignoring
 * placement arrival timestamps when comparing browser-oracle vs reordered arrival).
 */
export function areMergedStatesEquivalent(
  a: MergedPvState,
  b: MergedPvState
): boolean {
  if (
    a.maxSeq !== b.maxSeq ||
    a.visEpisode !== b.visEpisode ||
    a.maxTMono !== b.maxTMono ||
    a.scrollMaxPx !== b.scrollMaxPx ||
    a.docHFirst !== b.docHFirst ||
    a.docHMax !== b.docHMax ||
    a.docHLast.value !== b.docHLast.value ||
    a.docHLast.seq !== b.docHLast.seq ||
    a.visMs !== b.visMs ||
    a.reversals !== b.reversals ||
    a.jsErrorN !== b.jsErrorN ||
    a.degradeLevel !== b.degradeLevel ||
    a.liveWord !== b.liveWord ||
    a.keyDegraded !== b.keyDegraded ||
    a.domState.value !== b.domState.value ||
    a.skelFp.value !== b.skelFp.value ||
    a.cssFp.value !== b.cssFp.value ||
    a.headFp.value !== b.headFp.value ||
    a.variantKey.value !== b.variantKey.value ||
    a.consentMode.value !== b.consentMode.value ||
    a.stateIncomplete !== b.stateIncomplete ||
    a.vitals.lcp_ms?.value !== b.vitals.lcp_ms?.value ||
    a.vitals.inp_ms?.value !== b.vitals.inp_ms?.value ||
    a.vitals.cls_x1000?.value !== b.vitals.cls_x1000?.value ||
    a.vitals.ttfb_ms?.value !== b.vitals.ttfb_ms?.value ||
    a.sections.size !== b.sections.size ||
    a.blocks.size !== b.blocks.size ||
    a.fields.size !== b.fields.size ||
    a.forms.size !== b.forms.size ||
    a.media.size !== b.media.size ||
    a.events.size !== b.events.size
  ) {
    return false;
  }

  for (const [k, sa] of a.sections.entries()) {
    const sb = b.sections.get(k);
    if (
      !sb ||
      sa.vis_ms !== sb.vis_ms ||
      sa.t_first_ms !== sb.t_first_ms ||
      sa.entries !== sb.entries ||
      sa.max_frac_permille !== sb.max_frac_permille
    ) {
      return false;
    }
  }

  for (const [k, ba] of a.blocks.entries()) {
    const bb = b.blocks.get(k);
    if (!bb || ba.vis_ms !== bb.vis_ms || ba.copy_n !== bb.copy_n) {
      return false;
    }
  }

  for (const [k, fa] of a.fields.entries()) {
    const fb = b.fields.get(k);
    if (!fb || fa.focus_ms !== fb.focus_ms || fa.invalid_n !== fb.invalid_n) {
      return false;
    }
  }

  for (const [k, fra] of a.forms.entries()) {
    const frb = b.forms.get(k);
    if (!frb || fra.submit_attempts !== frb.submit_attempts) {
      return false;
    }
  }

  for (const [k, ma] of a.media.entries()) {
    const mb = b.media.get(k);
    if (!mb || ma.played_ms !== mb.played_ms) {
      return false;
    }
  }

  for (const [i, ea] of a.events.entries()) {
    const eb = b.events.get(i);
    if (!eb || ea.contentHash !== eb.contentHash) {
      return false;
    }
  }

  return true;
}

/**
 * High-throughput batch merger using a single freshly-allocated mutable
 * accumulator (eliminates per-frame Map/Set cloning while executing the exact
 * same algebraic merge primitives `mergeMax`, `mergeMin`, `mergeBitOr`,
 * `mergeArgMaxSeq` as `mergeFrameIntoPvState`).
 */
export function mergeFramesBatchIntoPvState(
  frames: readonly TelemetryFrame[],
  placement: PvPlacement
): MergedPvState | null {
  if (frames.length === 0) return null;

  const first = frames[0]!;
  const firstHash = computeFastFrameHash(first);
  const firstSeq = first.seq;

  let maxSeq = firstSeq;
  const seenSeqs = new Set<number>([firstSeq]);
  let maxAckEchoSeq = first.ack_echo_seq;
  let visEpisode = first.vis_episode;
  let maxTMono = first.t_mono;
  let minTMono = first.t_mono;
  let tWall: ArgMaxRegister<number> = { value: first.t_wall, seq: firstSeq, frameHash: firstHash };
  let consentMode = { value: first.consent_mode, seq: firstSeq, frameHash: firstHash };
  let purposes = { value: first.purposes, seq: firstSeq, frameHash: firstHash };
  let scrollMaxPx = first.state.scroll_max_px;
  let docHFirst = first.state.doc_h_first;
  let docHMax = first.state.doc_h_max;
  let docHLast: ArgMaxRegister<number> = {
    value: first.state.doc_h_last.value,
    seq: first.state.doc_h_last.seq,
    frameHash: firstHash,
  };
  let visMs = first.state.vis_ms;
  let reversals = first.state.reversals;
  let jsErrorN = first.state.js_error_n;
  let degradeLevel = first.state.degrade_level;
  let liveWord = first.live_word >>> 0;
  let keyDegraded = first.key_degraded;
  let domState = { value: first.state.dom_state, seq: firstSeq, frameHash: firstHash };
  let skelFp = { value: first.state.skel_fp, seq: firstSeq, frameHash: firstHash };
  let cssFp = { value: first.state.css_fp ?? null, seq: firstSeq, frameHash: firstHash };
  let headFp = { value: first.state.head_fp ?? null, seq: firstSeq, frameHash: firstHash };
  let variantKey = { value: first.state.variant_key, seq: firstSeq, frameHash: firstHash };
  let samplePi = { value: first.state.sample_pi, seq: firstSeq, frameHash: firstHash };
  let visitorId = first.visitor_id ?? null;
  let sessionId = first.session_id ?? null;

  const sections = new Map<string, MergedSectionState>();
  const blocks = new Map<string, MergedBlockState>();
  const fields = new Map<string, MergedFieldState>();
  const forms = new Map<string, MergedFormState>();
  const media = new Map<string, MergedMediaState>();
  const events = new Map<number, MergedEventRow>();
  let logConflictCount = 0;

  let lcpMs: ArgMaxRegister<number> | null = null;
  let inpMs: ArgMaxRegister<number> | null = null;
  let clsX1000: ArgMaxRegister<number> | null = null;
  let ttfbMs: ArgMaxRegister<number> | null = null;

  for (let idx = 0; idx < frames.length; idx += 1) {
    const frame = frames[idx]!;
    const frameHash = idx === 0 ? firstHash : computeFastFrameHash(frame);
    const seq = frame.seq;

    if (idx > 0) {
      seenSeqs.add(seq);
      maxSeq = mergeMax(maxSeq, seq);
      maxAckEchoSeq = mergeMax(maxAckEchoSeq, frame.ack_echo_seq);
      visEpisode = mergeMax(visEpisode, frame.vis_episode);
      maxTMono = mergeMax(maxTMono, frame.t_mono);
      minTMono = mergeMin(minTMono, frame.t_mono);
      tWall = mergeArgMaxSeqRequired(tWall, { value: frame.t_wall, seq, frameHash });
      consentMode = mergeArgMaxSeqRequired(consentMode, {
        value: frame.consent_mode,
        seq,
        frameHash,
      });
      purposes = mergeArgMaxSeqRequired(purposes, {
        value: frame.purposes,
        seq,
        frameHash,
      });
      scrollMaxPx = mergeMax(scrollMaxPx, frame.state.scroll_max_px);
      docHFirst = mergeMin(docHFirst, frame.state.doc_h_first);
      docHMax = mergeMax(docHMax, frame.state.doc_h_max);
      docHLast = mergeArgMaxSeqRequired(docHLast, {
        value: frame.state.doc_h_last.value,
        seq: frame.state.doc_h_last.seq,
        frameHash,
      });
      visMs = mergeMax(visMs, frame.state.vis_ms);
      reversals = mergeMax(reversals, frame.state.reversals);
      jsErrorN = mergeMax(jsErrorN, frame.state.js_error_n);
      degradeLevel = mergeMax(degradeLevel, frame.state.degrade_level);
      liveWord = mergeBitOr(liveWord, frame.live_word);
      keyDegraded = keyDegraded || frame.key_degraded;
      domState = mergeArgMaxSeqRequired(domState, {
        value: frame.state.dom_state,
        seq,
        frameHash,
      });
      skelFp = mergeArgMaxSeqRequired(skelFp, {
        value: frame.state.skel_fp,
        seq,
        frameHash,
      });
      cssFp = mergeArgMaxSeqRequired(cssFp, {
        value: frame.state.css_fp ?? null,
        seq,
        frameHash,
      });
      headFp = mergeArgMaxSeqRequired(headFp, {
        value: frame.state.head_fp ?? null,
        seq,
        frameHash,
      });
      variantKey = mergeArgMaxSeqRequired(variantKey, {
        value: frame.state.variant_key,
        seq,
        frameHash,
      });
      samplePi = mergeArgMaxSeqRequired(samplePi, {
        value: frame.state.sample_pi,
        seq,
        frameHash,
      });
      if (visitorId === null && frame.visitor_id) visitorId = frame.visitor_id;
      if (sessionId === null && frame.session_id) sessionId = frame.session_id;
    }

    for (let s = 0; s < frame.sections.length; s += 1) {
      const sec = frame.sections[s]!;
      const prev = sections.get(sec.sec_fp);
      if (!prev) {
        sections.set(sec.sec_fp, sec);
      } else {
        sections.set(sec.sec_fp, {
          sec_fp: sec.sec_fp,
          vis_ms: mergeMax(prev.vis_ms, sec.vis_ms),
          t_first_ms: mergeMin(prev.t_first_ms, sec.t_first_ms),
          entries: mergeMax(prev.entries, sec.entries),
          max_frac_permille: mergeMax(prev.max_frac_permille, sec.max_frac_permille),
        });
      }
    }

    if (frame.blocks) {
      for (let b = 0; b < frame.blocks.length; b += 1) {
        const blk = frame.blocks[b]!;
        const prev = blocks.get(blk.blk_fp);
        blocks.set(
          blk.blk_fp,
          prev
            ? {
                blk_fp: blk.blk_fp,
                vis_ms: mergeMax(prev.vis_ms, blk.vis_ms),
                copy_n: mergeMax(prev.copy_n, blk.copy_n),
              }
            : blk
        );
      }
    }

    if (frame.fields) {
      for (let f = 0; f < frame.fields.length; f += 1) {
        const fld = frame.fields[f]!;
        const prev = fields.get(fld.el_fp);
        fields.set(
          fld.el_fp,
          prev
            ? {
                el_fp: fld.el_fp,
                focus_ms: mergeMax(prev.focus_ms, fld.focus_ms),
                invalid_n: mergeMax(prev.invalid_n, fld.invalid_n),
              }
            : fld
        );
      }
    }

    if (frame.forms) {
      for (let f = 0; f < frame.forms.length; f += 1) {
        const frm = frame.forms[f]!;
        const prev = forms.get(frm.form_fp);
        forms.set(
          frm.form_fp,
          prev
            ? {
                form_fp: frm.form_fp,
                submit_attempts: mergeMax(prev.submit_attempts, frm.submit_attempts),
              }
            : frm
        );
      }
    }

    if (frame.media) {
      for (let m = 0; m < frame.media.length; m += 1) {
        const med = frame.media[m]!;
        const prev = media.get(med.blk_fp);
        media.set(
          med.blk_fp,
          prev
            ? {
                blk_fp: med.blk_fp,
                played_ms: mergeMax(prev.played_ms, med.played_ms),
              }
            : med
        );
      }
    }

    if (frame.vitals) {
      if (frame.vitals.lcp_ms) {
        lcpMs = mergeArgMaxSeq(lcpMs, {
          value: frame.vitals.lcp_ms.value,
          seq: frame.vitals.lcp_ms.seq,
          frameHash,
        });
      }
      if (frame.vitals.inp_ms) {
        inpMs = mergeArgMaxSeq(inpMs, {
          value: frame.vitals.inp_ms.value,
          seq: frame.vitals.inp_ms.seq,
          frameHash,
        });
      }
      if (frame.vitals.cls_x1000) {
        clsX1000 = mergeArgMaxSeq(clsX1000, {
          value: frame.vitals.cls_x1000.value,
          seq: frame.vitals.cls_x1000.seq,
          frameHash,
        });
      }
      if (frame.vitals.ttfb_ms) {
        ttfbMs = mergeArgMaxSeq(ttfbMs, {
          value: frame.vitals.ttfb_ms.value,
          seq: frame.vitals.ttfb_ms.seq,
          frameHash,
        });
      }
    }

    for (let e = 0; e < frame.log_items.length; e += 1) {
      const item = frame.log_items[e]!;
      const prev = events.get(item.i);
      if (prev && prev.item === item) {
        continue;
      }
      const contentHash = computeLogItemContentHash(item);
      if (!prev) {
        events.set(item.i, {
          tenantId: placement.tenantId,
          siteId: placement.siteId,
          pvHourMs: placement.pvHourMs,
          urlId: placement.urlId,
          pvId: placement.pvId,
          log_i: item.i,
          item,
          contentHash,
          conflictDetected: false,
        });
      } else if (prev.contentHash !== contentHash && !prev.conflictDetected) {
        logConflictCount += 1;
        events.set(item.i, { ...prev, conflictDetected: true });
      }
    }
  }

  return {
    placement,
    maxSeq,
    seenSeqs,
    maxAckEchoSeq,
    visEpisode,
    maxTMono,
    minTMono,
    tWall,
    consentMode,
    purposes: { ...purposes, value: [...purposes.value].sort() },
    pageUrlKey: first.state.page_url_key,
    navType: first.state.nav_type,
    startedHidden: first.state.started_hidden,
    scrollMaxPx,
    docHFirst,
    docHMax,
    docHLast,
    visMs,
    reversals,
    jsErrorN,
    degradeLevel,
    liveWord,
    keyDegraded,
    domState,
    skelFp,
    cssFp,
    headFp,
    variantKey,
    samplePi,
    stateIncomplete: false,
    sections,
    blocks,
    fields,
    forms,
    media,
    vitals: {
      lcp_ms: lcpMs,
      inp_ms: inpMs,
      cls_x1000: clsX1000,
      ttfb_ms: ttfbMs,
    },
    events,
    logConflictCount,
    visitorId,
    sessionId,
  };
}
