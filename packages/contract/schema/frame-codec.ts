/**
 * Generator #1: SDK Binary Codec (`ugk-bin/1`), Frame Validator, State Checksum,
 * Size Budget Checker (16 KiB / 48 KiB), Closed String-Slot Enforcement,
 * and URL Parameter Masking Contract (§4.1–§4.5, §6.4, TEL M1/A1/A3, D-6/D-19).
 */

import { bytesToUtf8, canonicalJsonStringify, sha256Hex, utf8ToBytes } from './hash';
import { assertValidContractSchema } from './invariants';
import {
  CODEC_VERSION,
  CONSENT_MODES,
  CONSENT_PURPOSES,
  DOM_STATES,
  FRAME_CLASSES,
  FRAME_TRANSPORTS,
  FULL_REQUIRED_FRAME_CLASSES,
  HIDDEN_BUDGET_FRAME_CLASSES,
  LOG_ITEM_KINDS,
  NAV_TYPES,
  type ActivationKind,
  type CodecVersion,
  type ConsentMode,
  type ConsentPurpose,
  type ContractSchema,
  type DomState,
  type ExposureKind,
  type ExposureReason,
  type FrameClass,
  type FrameTransport,
  type LogItemKind,
  type NavType,
  type UrlParamClass,
} from './types';

export interface FrameChecksum {
  readonly nonZeroRegisters: number;
  readonly sumTimeMs: number;
  readonly sumCounts: number;
  readonly logHighWater: number;
}

export interface SeqPairedValue<T> {
  readonly value: T;
  readonly seq: number;
}

export interface SectionRegisterPayload {
  readonly sec_fp: string;
  readonly vis_ms: number;
  readonly t_first_ms: number;
  readonly entries: number;
  readonly max_frac_permille: number;
}

export interface BlockRegisterPayload {
  readonly blk_fp: string;
  readonly vis_ms: number;
  readonly copy_n: number;
}

export interface FieldRegisterPayload {
  readonly el_fp: string;
  readonly focus_ms: number;
  readonly invalid_n: number;
}

export interface FormRegisterPayload {
  readonly form_fp: string;
  readonly submit_attempts: number;
}

export interface MediaRegisterPayload {
  readonly blk_fp: string;
  readonly played_ms: number;
}

export interface VitalsRegisterPayload {
  readonly lcp_ms?: SeqPairedValue<number>;
  readonly inp_ms?: SeqPairedValue<number>;
  readonly cls_x1000?: SeqPairedValue<number>;
  readonly ttfb_ms?: SeqPairedValue<number>;
}

export interface PageStatePayload {
  readonly page_url_key: string;
  readonly external_referrer_key?: string | null;
  readonly campaign_param?: string | null;
  readonly nav_type: NavType;
  readonly started_hidden: boolean;
  readonly scroll_max_px: number;
  readonly doc_h_first: number;
  readonly doc_h_max: number;
  readonly doc_h_last: SeqPairedValue<number>;
  readonly vis_ms: number;
  readonly reversals: number;
  readonly js_error_n: number;
  readonly degrade_level: number;
  readonly dom_state: DomState;
  readonly skel_fp: string;
  readonly css_fp?: string | null;
  readonly head_fp?: string | null;
  readonly variant_key: string;
  readonly sample_pi: number;
}

export interface TelemetryLogItem {
  readonly i: number;
  readonly kind: LogItemKind;
  readonly t_mono: number;
  readonly activation_kind?: ActivationKind;
  readonly el_fp?: string;
  readonly dest_key_click?: string;
  readonly cv_key?: string;
  readonly ec_product_id?: string;
  readonly exposure_decision_id?: string;
  readonly exposure_kind?: ExposureKind;
  readonly exposure_reason?: ExposureReason;
  readonly timeline_ints?: readonly number[];
}

export interface TelemetryFrame {
  readonly codec_ver: CodecVersion;
  readonly schema_ver: number;
  readonly sdk_build: string;
  readonly pv_id: string;
  readonly seq: number;
  readonly cont_of?: string | null;
  readonly frame_class: FrameClass;
  readonly transport: FrameTransport;
  readonly full: boolean;
  readonly vis_episode: number;
  readonly t_mono: number;
  readonly t_wall: number;
  readonly ack_echo_seq: number;
  readonly pv_token?: string | null;
  readonly consent_mode: ConsentMode;
  readonly purposes: readonly ConsentPurpose[];
  readonly arm_bits: number;
  readonly def_ver: number;
  readonly url_id: string; // Decimal or hex uint64 serialized safely as string in JS
  readonly key_ver: number;
  readonly profile_rev: number;
  readonly dim_tuple_code: number;
  readonly live_word: number;
  readonly key_degraded: boolean;
  readonly handoff_token?: string | null;
  readonly visitor_id?: string | null;
  readonly session_id?: string | null;
  readonly member_hash?: string | null;
  readonly lab_run_id?: string | null;
  readonly chk: FrameChecksum;
  readonly state: PageStatePayload;
  readonly sections: readonly SectionRegisterPayload[];
  readonly blocks?: readonly BlockRegisterPayload[];
  readonly fields?: readonly FieldRegisterPayload[];
  readonly forms?: readonly FormRegisterPayload[];
  readonly media?: readonly MediaRegisterPayload[];
  readonly vitals?: VitalsRegisterPayload;
  readonly log_items: readonly TelemetryLogItem[];
  readonly string_slots?: Readonly<Record<string, string>>;
}

export interface UrlMaskingResult {
  readonly maskedParams: Readonly<Record<string, string>>;
  readonly droppedNoiseParams: readonly string[];
  readonly maskedUserInputParams: readonly string[];
  readonly maskedUnknownParams: readonly string[];
  readonly keyDegraded: boolean;
}

/**
 * Deterministic length-bucket token (§6.4 / D-6).
 * For `unknown` parameters, ONLY name and length bucket are emitted — never
 * revealing numeric/slug shape so visitor input cannot leak through URL params.
 */
export function toLengthBucketToken(rawValue: string): string {
  const len = rawValue.length;
  if (len === 0) return '__len_0';
  if (len <= 4) return '__len_1_4';
  if (len <= 16) return '__len_5_16';
  if (len <= 64) return '__len_17_64';
  return '__len_65p';
}

export function maskUrlParams(
  rawParams: Readonly<Record<string, string>>,
  paramClasses: Readonly<Record<string, UrlParamClass>>
): UrlMaskingResult {
  const maskedParams: Record<string, string> = {};
  const droppedNoiseParams: string[] = [];
  const maskedUserInputParams: string[] = [];
  const maskedUnknownParams: string[] = [];

  const keys = Object.keys(rawParams).sort();
  for (const key of keys) {
    const rawVal = rawParams[key];
    const paramClass: UrlParamClass = paramClasses[key] ?? 'unknown';

    if (paramClass === 'noise') {
      droppedNoiseParams.push(key);
      continue;
    }
    if (paramClass === 'content') {
      maskedParams[key] = rawVal;
      continue;
    }
    if (paramClass === 'user_input') {
      maskedParams[key] = toLengthBucketToken(rawVal);
      maskedUserInputParams.push(key);
      continue;
    }
    // `unknown`: emit ONLY length-bucket token (no shape leak per §6.4) & mark key_degraded
    maskedParams[key] = toLengthBucketToken(rawVal);
    maskedUnknownParams.push(key);
  }

  return {
    maskedParams,
    droppedNoiseParams,
    maskedUserInputParams,
    maskedUnknownParams,
    keyDegraded: maskedUnknownParams.length > 0,
  };
}

/**
 * Deterministic state checksum `chk` (§4.1 / TEL M1 / D-19):
 * - nonZeroRegisters: number of non-zero numeric state registers across page/sections/blocks/fields/forms/media
 * - sumTimeMs: sum of cumulative ms time registers
 * - sumCounts: sum of cumulative count registers
 * - logHighWater: highest log item ordinal `i` present, or -1 if no log items
 */
export function computeFrameChecksum(
  frame: Pick<
    TelemetryFrame,
    'state' | 'sections' | 'blocks' | 'fields' | 'forms' | 'media' | 'log_items'
  >
): FrameChecksum {
  let nonZeroRegisters = 0;
  let sumTimeMs = 0;
  let sumCounts = 0;

  const countNonZero = (v: number): void => {
    if (v > 0) nonZeroRegisters += 1;
  };

  // Page state registers
  countNonZero(frame.state.scroll_max_px);
  countNonZero(frame.state.doc_h_first);
  countNonZero(frame.state.doc_h_max);
  countNonZero(frame.state.doc_h_last.value);
  countNonZero(frame.state.vis_ms);
  countNonZero(frame.state.reversals);
  countNonZero(frame.state.js_error_n);
  countNonZero(frame.state.degrade_level);

  sumTimeMs += frame.state.vis_ms;
  sumCounts += frame.state.reversals + frame.state.js_error_n;

  for (const sec of frame.sections) {
    countNonZero(sec.vis_ms);
    countNonZero(sec.t_first_ms);
    countNonZero(sec.entries);
    countNonZero(sec.max_frac_permille);
    sumTimeMs += sec.vis_ms;
    sumCounts += sec.entries;
  }

  for (const blk of frame.blocks ?? []) {
    countNonZero(blk.vis_ms);
    countNonZero(blk.copy_n);
    sumTimeMs += blk.vis_ms;
    sumCounts += blk.copy_n;
  }

  for (const fld of frame.fields ?? []) {
    countNonZero(fld.focus_ms);
    countNonZero(fld.invalid_n);
    sumTimeMs += fld.focus_ms;
    sumCounts += fld.invalid_n;
  }

  for (const frm of frame.forms ?? []) {
    countNonZero(frm.submit_attempts);
    sumCounts += frm.submit_attempts;
  }

  for (const med of frame.media ?? []) {
    countNonZero(med.played_ms);
    sumTimeMs += med.played_ms;
  }

  let logHighWater = -1;
  for (const item of frame.log_items) {
    if (item.i > logHighWater) {
      logHighWater = item.i;
    }
  }

  return {
    nonZeroRegisters,
    sumTimeMs,
    sumCounts,
    logHighWater,
  };
}

export function verifyFrameChecksum(frame: TelemetryFrame): boolean {
  const expected = computeFrameChecksum(frame);
  return (
    frame.chk.nonZeroRegisters === expected.nonZeroRegisters &&
    frame.chk.sumTimeMs === expected.sumTimeMs &&
    frame.chk.sumCounts === expected.sumCounts &&
    frame.chk.logHighWater === expected.logHighWater
  );
}

const MAGIC_BYTES = new Uint8Array([0x55, 0x47, 0x4b, 0x31]); // 'UGK1'

export interface SdkFrameValidationError {
  readonly code:
    | 'INVALID_PV_ID'
    | 'INVALID_SEQ'
    | 'INVALID_CODEC_VERSION'
    | 'INVALID_SCHEMA_VERSION'
    | 'INVALID_FRAME_CLASS'
    | 'INVALID_TRANSPORT'
    | 'HIDDEN_FRAME_MUST_BE_FULL'
    | 'FRAME_SIZE_LIMIT_EXCEEDED'
    | 'CONSENT_OFF_FORBIDS_FRAMES'
    | 'CONSENT_DISALLOWS_IDENTIFIER'
    | 'CONSENT_DISALLOWS_PURPOSE'
    | 'CHECKSUM_MISMATCH'
    | 'UNREGISTERED_STRING_SLOT'
    | 'FORBIDDEN_BEHAVIOUR_STRING'
    | 'INVALID_URL_ID'
    | 'TIMELINE_MUST_BE_INTEGERS_ONLY'
    | 'INVALID_ENUM_VALUE';
  readonly path: string;
  readonly message: string;
}

export interface SdkFrameValidationResult {
  readonly valid: boolean;
  readonly rawByteLength: number;
  readonly maxAllowedBytes: number;
  readonly frameHash: string;
  readonly errors: readonly SdkFrameValidationError[];
}

export interface GeneratedSdkCodec {
  readonly schemaVersion: string;
  readonly codecVersion: CodecVersion;
  readonly encodeFrame: (frame: TelemetryFrame) => Uint8Array;
  readonly decodeFrame: (bytes: Uint8Array) => TelemetryFrame;
  readonly validateFrame: (frame: TelemetryFrame) => SdkFrameValidationResult;
  readonly computeChecksum: typeof computeFrameChecksum;
  readonly verifyChecksum: typeof verifyFrameChecksum;
  readonly maskUrlParams: typeof maskUrlParams;
  readonly maxBytesForClass: (frameClass: FrameClass) => number;
}

const HEX_128_RE = /^[0-9a-f]{32}$/;
const UINT64_RE = /^(?:0|[1-9][0-9]{0,19})$/;

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertValidWireHeader(bytes: Uint8Array, expectedWireVersion: number): DataView {
  if (bytes.length < 10) {
    throw new Error(`Invalid ugk-bin/1 frame: length ${bytes.length} < minimum header size 10`);
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new Error('Invalid ugk-bin/1 magic header');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wireVer = view.getUint16(4, false);
  if (wireVer !== expectedWireVersion) {
    throw new Error(
      `Unsupported wire schema version ${wireVer}; expected ${expectedWireVersion}`
    );
  }
  return view;
}

/**
 * Pure deterministic generator producing the SDK codec & validator bound to `schema`.
 */
export function createSdkFrameCodec(schema: ContractSchema): GeneratedSdkCodec {
  assertValidContractSchema(schema);

  const allowedBehaviourSlots = new Set(
    schema.stringSlots.filter((s) => s.allowedInBehaviourFrame).map((s) => s.id)
  );
  const slotMaxLengths = new Map(schema.stringSlots.map((s) => [s.id, s.maxLength]));
  const forbiddenNames = new Set(
    schema.forbiddenBehaviourFieldNames.map((n) => n.toLowerCase())
  );
  const modeSpecMap = new Map(schema.consentModes.map((m) => [m.mode, m]));
  const validFrameClasses = new Set<string>(FRAME_CLASSES);
  const validTransports = new Set<string>(FRAME_TRANSPORTS);
  const validConsentModes = new Set<string>(CONSENT_MODES);
  const validPurposes = new Set<string>(CONSENT_PURPOSES);
  const validNavTypes = new Set<string>(NAV_TYPES);
  const validDomStates = new Set<string>(DOM_STATES);
  const validLogKinds = new Set<string>(LOG_ITEM_KINDS);

  const maxBytesForClass = (frameClass: FrameClass): number =>
    HIDDEN_BUDGET_FRAME_CLASSES.has(frameClass)
      ? schema.frameLimits.hiddenMaxBytes
      : schema.frameLimits.visibleMaxBytes;

  const encodeFrame = (frame: TelemetryFrame): Uint8Array => {
    const payloadJson = canonicalJsonStringify(frame);
    const payloadBytes = utf8ToBytes(payloadJson);
    const totalLen = 10 + payloadBytes.length;

    const maxBytes = maxBytesForClass(frame.frame_class);
    if (totalLen > maxBytes) {
      throw new Error(
        `Frame exceeds size budget for class "${frame.frame_class}": ${totalLen} > ${maxBytes} bytes`
      );
    }

    const out = new Uint8Array(totalLen);
    out.set(MAGIC_BYTES, 0);
    const view = new DataView(out.buffer);
    view.setUint16(4, schema.meta.wireVersion, false);
    view.setUint32(6, payloadBytes.length, false);
    out.set(payloadBytes, 10);
    return out;
  };

  const decodeFrame = (bytes: Uint8Array): TelemetryFrame => {
    if (bytes.length > schema.frameLimits.inflateMaxBytes) {
      throw new Error(
        `Frame exceeds inflate cap: ${bytes.length} > ${schema.frameLimits.inflateMaxBytes}`
      );
    }
    const view = assertValidWireHeader(bytes, schema.meta.wireVersion);
    const payloadLen = view.getUint32(6, false);
    if (10 + payloadLen !== bytes.length) {
      throw new Error(
        `Frame payload length mismatch: header declares ${payloadLen}, actual ${bytes.length - 10}`
      );
    }
    const payloadBytes = bytes.subarray(10, 10 + payloadLen);
    const parsed = JSON.parse(bytesToUtf8(payloadBytes)) as TelemetryFrame;
    return parsed;
  };

  const validateFrame = (frame: TelemetryFrame): SdkFrameValidationResult => {
    const errors: SdkFrameValidationError[] = [];

    const canonicalPayload = canonicalJsonStringify(frame);
    const rawByteLength = 10 + utf8ToBytes(canonicalPayload).length;
    const frameHash = sha256Hex(canonicalPayload);
    const maxAllowedBytes = validFrameClasses.has(frame.frame_class)
      ? maxBytesForClass(frame.frame_class)
      : schema.frameLimits.hiddenMaxBytes;

    // 1. Codec & schema version
    if (frame.codec_ver !== CODEC_VERSION) {
      errors.push({
        code: 'INVALID_CODEC_VERSION',
        path: 'codec_ver',
        message: `Expected codec_ver="${CODEC_VERSION}", got "${String(frame.codec_ver)}"`,
      });
    }
    if (frame.schema_ver !== schema.meta.wireVersion) {
      errors.push({
        code: 'INVALID_SCHEMA_VERSION',
        path: 'schema_ver',
        message: `Expected schema_ver=${schema.meta.wireVersion}, got ${String(frame.schema_ver)}`,
      });
    }

    // 2. pv_id (128-bit lowercase hex) & seq
    if (typeof frame.pv_id !== 'string' || !HEX_128_RE.test(frame.pv_id)) {
      errors.push({
        code: 'INVALID_PV_ID',
        path: 'pv_id',
        message: 'pv_id must be a 32-char lowercase hex 128-bit random identifier',
      });
    }
    if (!isSafeNonNegativeInt(frame.seq) || frame.seq > 1000000) {
      errors.push({
        code: 'INVALID_SEQ',
        path: 'seq',
        message: `seq must be an integer in [0, 1000000], got ${String(frame.seq)}`,
      });
    }

    // 3. url_id required in every frame for standalone placement (D-19)
    if (typeof frame.url_id !== 'string' || !UINT64_RE.test(frame.url_id) || frame.url_id === '0') {
      errors.push({
        code: 'INVALID_URL_ID',
        path: 'url_id',
        message: 'Every frame must carry a positive uint64 url_id for standalone loader placement',
      });
    }

    // 4. Frame class, transport, and full-frame rule for hidden/deferred (§4.1 / TEL M1)
    if (!validFrameClasses.has(frame.frame_class)) {
      errors.push({
        code: 'INVALID_FRAME_CLASS',
        path: 'frame_class',
        message: `Unknown frame_class "${String(frame.frame_class)}"`,
      });
    } else if (FULL_REQUIRED_FRAME_CLASSES.has(frame.frame_class) && !frame.full) {
      errors.push({
        code: 'HIDDEN_FRAME_MUST_BE_FULL',
        path: 'full',
        message: `Frame class "${frame.frame_class}" must always set full=true`,
      });
    }

    if (!validTransports.has(frame.transport)) {
      errors.push({
        code: 'INVALID_TRANSPORT',
        path: 'transport',
        message: `Unknown transport "${String(frame.transport)}"`,
      });
    }

    // 5. Raw byte size budget (16 KiB hidden/critical/deferred; 48 KiB visible)
    if (rawByteLength > maxAllowedBytes) {
      errors.push({
        code: 'FRAME_SIZE_LIMIT_EXCEEDED',
        path: '$frame',
        message: `Encoded frame size ${rawByteLength} bytes exceeds ${maxAllowedBytes} byte limit for frame_class "${frame.frame_class}"`,
      });
    }

    // 6. Consent mode & purpose compliance (§4.5 / D-13)
    if (!validConsentModes.has(frame.consent_mode)) {
      errors.push({
        code: 'INVALID_ENUM_VALUE',
        path: 'consent_mode',
        message: `Unknown consent_mode "${String(frame.consent_mode)}"`,
      });
    } else {
      const modeSpec = modeSpecMap.get(frame.consent_mode);
      if (modeSpec && !modeSpec.allowsTelemetryFrames) {
        errors.push({
          code: 'CONSENT_OFF_FORBIDS_FRAMES',
          path: 'consent_mode',
          message: 'Consent mode "off" strictly forbids sending telemetry frames',
        });
      }
      if (frame.consent_mode === 'cookieless') {
        if (frame.visitor_id) {
          errors.push({
            code: 'CONSENT_DISALLOWS_IDENTIFIER',
            path: 'visitor_id',
            message: 'visitor_id is forbidden in cookieless mode',
          });
        }
        if (frame.session_id) {
          errors.push({
            code: 'CONSENT_DISALLOWS_IDENTIFIER',
            path: 'session_id',
            message: 'session_id is forbidden in cookieless mode',
          });
        }
      }
      if (modeSpec) {
        for (const p of frame.purposes) {
          if (!validPurposes.has(p)) {
            errors.push({
              code: 'INVALID_ENUM_VALUE',
              path: 'purposes',
              message: `Unknown purpose "${String(p)}"`,
            });
          } else if (modeSpec.disallowedPurposes.includes(p)) {
            errors.push({
              code: 'CONSENT_DISALLOWS_PURPOSE',
              path: 'purposes',
              message: `Purpose "${p}" is disallowed under consent_mode "${frame.consent_mode}"`,
            });
          }
        }
      }
      if (frame.member_hash && !frame.purposes.includes('member_link')) {
        errors.push({
          code: 'CONSENT_DISALLOWS_PURPOSE',
          path: 'member_hash',
          message: 'member_hash requires consent purpose "member_link"',
        });
      }
    }

    // 7. State enum checks
    if (!validNavTypes.has(frame.state.nav_type)) {
      errors.push({
        code: 'INVALID_ENUM_VALUE',
        path: 'state.nav_type',
        message: `Unknown nav_type "${String(frame.state.nav_type)}"`,
      });
    }
    if (!validDomStates.has(frame.state.dom_state)) {
      errors.push({
        code: 'INVALID_ENUM_VALUE',
        path: 'state.dom_state',
        message: `Unknown dom_state "${String(frame.state.dom_state)}"`,
      });
    }

    // 8. State integrity checksum `chk` (§4.1 / TEL M1)
    if (!verifyFrameChecksum(frame)) {
      errors.push({
        code: 'CHECKSUM_MISMATCH',
        path: 'chk',
        message: 'Frame state checksum chk does not match recomputed registers and log high-water mark',
      });
    }

    // 9. Closed string-slot enforcement & forbidden behaviour keys check (TEL A3 / G7)
    if (frame.string_slots) {
      for (const [slotName, slotVal] of Object.entries(frame.string_slots)) {
        if (forbiddenNames.has(slotName.toLowerCase())) {
          errors.push({
            code: 'FORBIDDEN_BEHAVIOUR_STRING',
            path: `string_slots.${slotName}`,
            message: `Forbidden field "${slotName}" is not permitted in telemetry frames`,
          });
          continue;
        }
        if (!allowedBehaviourSlots.has(slotName as typeof schema.stringSlots[number]['id'])) {
          errors.push({
            code: 'UNREGISTERED_STRING_SLOT',
            path: `string_slots.${slotName}`,
            message: `String slot "${slotName}" is not in the closed allow-list for behaviour frames`,
          });
          continue;
        }
        const maxLen = slotMaxLengths.get(slotName as typeof schema.stringSlots[number]['id']);
        if (maxLen !== undefined && slotVal.length > maxLen) {
          errors.push({
            code: 'UNREGISTERED_STRING_SLOT',
            path: `string_slots.${slotName}`,
            message: `String slot "${slotName}" length ${slotVal.length} exceeds max ${maxLen}`,
          });
        }
      }
    }

    // Detect any forbidden keys attached at runtime to state or log items
    const stateRecord = frame.state as unknown as Record<string, unknown>;
    for (const k of Object.keys(stateRecord)) {
      if (forbiddenNames.has(k.toLowerCase())) {
        errors.push({
          code: 'FORBIDDEN_BEHAVIOUR_STRING',
          path: `state.${k}`,
          message: `Forbidden v2 field "${k}" detected in page state`,
        });
      }
    }

    // 10. Log items & integer-only timeline invariant (D-11R)
    for (let idx = 0; idx < frame.log_items.length; idx++) {
      const item = frame.log_items[idx];
      if (!validLogKinds.has(item.kind)) {
        errors.push({
          code: 'INVALID_ENUM_VALUE',
          path: `log_items[${idx}].kind`,
          message: `Unknown log item kind "${String(item.kind)}"`,
        });
      }
      if (item.kind === 'timeline_chunk') {
        if (!Array.isArray(item.timeline_ints)) {
          errors.push({
            code: 'TIMELINE_MUST_BE_INTEGERS_ONLY',
            path: `log_items[${idx}].timeline_ints`,
            message: 'timeline_chunk must carry an integer array timeline_ints',
          });
        } else {
          for (const val of item.timeline_ints) {
            if (typeof val !== 'number' || !Number.isInteger(val)) {
              errors.push({
                code: 'TIMELINE_MUST_BE_INTEGERS_ONLY',
                path: `log_items[${idx}].timeline_ints`,
                message: `timeline_chunk must contain integers only; found ${typeof val}`,
              });
              break;
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      rawByteLength,
      maxAllowedBytes,
      frameHash,
      errors,
    };
  };

  return {
    schemaVersion: schema.meta.schemaVersion,
    codecVersion: schema.meta.codecVersion,
    encodeFrame,
    decodeFrame,
    validateFrame,
    computeChecksum: computeFrameChecksum,
    verifyChecksum: verifyFrameChecksum,
    maskUrlParams,
    maxBytesForClass,
  };
}
