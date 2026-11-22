/**
 * Generator #2: Collector / Ingest Validation Schema with Partial Acceptance
 *
 * Implements §4.1 & TEL M1 / M4 / A1:
 * - Envelope errors reject the frame and emit a sanitized quarantine record
 *   (strings found in integer positions are replaced with `{ type: 'string', length }`).
 * - Single invalid fields NEVER drop the whole frame:
 *   - `drop_flag`: drops only that field and records a flag in `fieldFlags` & `rej[]`
 *   - `clamp_flag`: clamps the value to static bounds and records a flag in `fieldFlags` & `rej[]`
 * - Dynamic bounds check against server elapsed time (`serverElapsedMs + walAllowanceMs`).
 */

import {
  computeFrameChecksum,
  createSdkFrameCodec,
  verifyFrameChecksum,
  type PageStatePayload,
  type TelemetryFrame,
} from './frame-codec';
import { canonicalJsonStringify, sha256Hex, utf8ToBytes } from './hash';
import { assertValidContractSchema } from './invariants';
import {
  CODEC_VERSION,
  CONSENT_MODES,
  FRAME_CLASSES,
  FRAME_TRANSPORTS,
  FULL_REQUIRED_FRAME_CLASSES,
  type ContractSchema,
  type FieldSpec,
} from './types';

export interface FieldValidationFlag {
  readonly field: string;
  readonly action: 'dropped' | 'clamped';
  readonly reason: string;
  readonly originalValue?: unknown;
  readonly clampedValue?: number;
}

export interface SanitizedQuarantineRecord {
  readonly reason: string;
  readonly pvId: string | null;
  readonly seq: number | null;
  readonly sanitizedFields: Readonly<Record<string, unknown>>;
  readonly payloadSha256: string;
}

export interface IngestContext {
  readonly serverNowMs?: number;
  readonly pvStartServerMs?: number;
  readonly walAllowanceMs?: number;
}

export interface IngestValidationResult {
  readonly accepted: boolean;
  readonly partial: boolean;
  readonly stateIncomplete: boolean;
  readonly sanitizedFrame: TelemetryFrame | null;
  readonly fieldFlags: readonly FieldValidationFlag[];
  readonly rej: readonly string[];
  readonly quarantineRecord: SanitizedQuarantineRecord | null;
  readonly ackHints: {
    readonly seq: number | null;
    readonly i_hw: number;
    readonly rej: readonly string[];
  };
}

export interface GeneratedIngestValidator {
  readonly schemaVersion: string;
  readonly validateIngestFrame: (
    rawInput: unknown,
    context?: IngestContext
  ) => IngestValidationResult;
}

const HEX_128_RE = /^[0-9a-f]{32}$/;
const UINT64_RE = /^(?:0|[1-9][0-9]{0,19})$/;

function sanitizeValueForQuarantine(
  value: unknown,
  expectNumeric: boolean
): unknown {
  if (expectNumeric && typeof value === 'string') {
    // TEL A1: strings found in integer positions are stored ONLY as { type, length }
    return { type: 'string', length: value.length };
  }
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => sanitizeValueForQuarantine(item, expectNumeric));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValueForQuarantine(v, expectNumeric);
    }
    return out;
  }
  return value;
}

export function createIngestValidator(schema: ContractSchema): GeneratedIngestValidator {
  assertValidContractSchema(schema);
  const sdkCodec = createSdkFrameCodec(schema);

  const pageFieldMap = new Map<string, FieldSpec>();
  for (const field of schema.fields) {
    if (field.domain === 'page_state' || field.domain === 'envelope') {
      pageFieldMap.set(field.name, field);
    }
  }

  const forbiddenNames = new Set(
    schema.forbiddenBehaviourFieldNames.map((n) => n.toLowerCase())
  );
  const allowedBehaviourSlots = new Set<string>(
    schema.stringSlots.filter((s) => s.allowedInBehaviourFrame).map((s) => s.id)
  );
  const validFrameClasses = new Set<string>(FRAME_CLASSES);
  const validTransports = new Set<string>(FRAME_TRANSPORTS);
  const validConsentModes = new Set<string>(CONSENT_MODES);

  const rejectWithQuarantine = (
    raw: Record<string, unknown>,
    reason: string,
    rejCodes: string[]
  ): IngestValidationResult => {
    const pvId = typeof raw.pv_id === 'string' && HEX_128_RE.test(raw.pv_id) ? raw.pv_id : null;
    const seq = typeof raw.seq === 'number' && Number.isInteger(raw.seq) ? raw.seq : null;

    const sanitizedFields = sanitizeValueForQuarantine(raw, true) as Record<string, unknown>;
    const payloadSha256 = sha256Hex(canonicalJsonStringify(sanitizedFields));

    return {
      accepted: false,
      partial: false,
      stateIncomplete: true,
      sanitizedFrame: null,
      fieldFlags: [],
      rej: rejCodes,
      quarantineRecord: {
        reason,
        pvId,
        seq,
        sanitizedFields,
        payloadSha256,
      },
      ackHints: {
        seq,
        i_hw: -1,
        rej: rejCodes,
      },
    };
  };

  const validateIngestFrame = (
    rawInput: unknown,
    context?: IngestContext
  ): IngestValidationResult => {
    if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return rejectWithQuarantine({}, 'malformed_envelope', ['envelope:not_object']);
    }
    const raw = rawInput as Record<string, unknown>;

    // 1. Envelope-level checks (rejection only on envelope/framing/consent-off/size violations)
    if (raw.codec_ver !== CODEC_VERSION) {
      return rejectWithQuarantine(raw, 'invalid_codec_ver', ['envelope:invalid_codec_ver']);
    }
    if (raw.schema_ver !== schema.meta.wireVersion) {
      return rejectWithQuarantine(raw, 'invalid_schema_ver', ['envelope:invalid_schema_ver']);
    }
    if (typeof raw.pv_id !== 'string' || !HEX_128_RE.test(raw.pv_id)) {
      return rejectWithQuarantine(raw, 'invalid_pv_id', ['envelope:invalid_pv_id']);
    }
    if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0 || raw.seq > 1000000) {
      return rejectWithQuarantine(raw, 'invalid_seq', ['envelope:invalid_seq']);
    }
    if (typeof raw.frame_class !== 'string' || !validFrameClasses.has(raw.frame_class)) {
      return rejectWithQuarantine(raw, 'invalid_frame_class', ['envelope:invalid_frame_class']);
    }
    if (typeof raw.transport !== 'string' || !validTransports.has(raw.transport)) {
      return rejectWithQuarantine(raw, 'invalid_transport', ['envelope:invalid_transport']);
    }
    if (typeof raw.consent_mode !== 'string' || !validConsentModes.has(raw.consent_mode)) {
      return rejectWithQuarantine(raw, 'invalid_consent_mode', ['envelope:invalid_consent_mode']);
    }
    if (raw.consent_mode === 'off') {
      return rejectWithQuarantine(raw, 'consent_off', ['envelope:consent_off']);
    }
    if (FULL_REQUIRED_FRAME_CLASSES.has(raw.frame_class as TelemetryFrame['frame_class']) && raw.full !== true) {
      return rejectWithQuarantine(raw, 'hidden_not_full', ['envelope:hidden_not_full']);
    }
    if (typeof raw.url_id !== 'string' || !UINT64_RE.test(raw.url_id) || raw.url_id === '0') {
      return rejectWithQuarantine(raw, 'invalid_url_id', ['envelope:invalid_url_id']);
    }

    // Raw frame byte size cap check
    const rawSize = 10 + utf8ToBytes(canonicalJsonStringify(raw)).length;
    const maxBytes = sdkCodec.maxBytesForClass(raw.frame_class as TelemetryFrame['frame_class']);
    if (rawSize > maxBytes) {
      return rejectWithQuarantine(raw, 'frame_too_large', ['envelope:size_exceeded']);
    }

    if (raw.state === null || typeof raw.state !== 'object' || Array.isArray(raw.state)) {
      return rejectWithQuarantine(raw, 'missing_state', ['envelope:missing_state']);
    }

    // Check for raw string injected into integer position -> quarantine with {type, length}
    const rawState = raw.state as Record<string, unknown>;
    const numericPageFields = [
      'scroll_max_px',
      'doc_h_first',
      'doc_h_max',
      'vis_ms',
      'reversals',
      'js_error_n',
      'degrade_level',
    ] as const;

    for (const numField of numericPageFields) {
      if (typeof rawState[numField] === 'string') {
        return rejectWithQuarantine(
          raw,
          `string_in_numeric_slot:${numField}`,
          [`quarantine:string_in_int_slot:${numField}`]
        );
      }
    }

    // 2. Partial Acceptance: sanitize individual fields using schema `onInvalid` (drop_flag | clamp_flag)
    const fieldFlags: FieldValidationFlag[] = [];
    const rej: string[] = [];

    const frame = raw as unknown as TelemetryFrame;
    const mutableState: Record<string, unknown> = { ...frame.state };

    // Remove any forbidden v2 behaviour field names via drop_flag
    for (const key of Object.keys(mutableState)) {
      if (forbiddenNames.has(key.toLowerCase())) {
        delete mutableState[key];
        fieldFlags.push({
          field: `state.${key}`,
          action: 'dropped',
          reason: 'forbidden_behaviour_field',
        });
        rej.push(`drop:state.${key}:forbidden_behaviour_field`);
      }
    }

    // Compute dynamic elapsed bound if server context is available (TEL M4)
    const maxDynamicElapsedMs =
      context?.serverNowMs !== undefined && context?.pvStartServerMs !== undefined
        ? Math.max(0, context.serverNowMs - context.pvStartServerMs) +
          (context.walAllowanceMs ?? 5000)
        : undefined;

    // Validate numeric page_state fields with static + dynamic bounds
    for (const fieldName of numericPageFields) {
      const spec = pageFieldMap.get(fieldName);
      if (!spec) continue;
      const val = mutableState[fieldName];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        mutableState[fieldName] = 0;
        fieldFlags.push({
          field: `state.${fieldName}`,
          action: 'dropped',
          reason: 'invalid_number',
          originalValue: val,
        });
        rej.push(`drop:state.${fieldName}:invalid_number`);
        continue;
      }

      const min = spec.staticBounds?.min ?? 0;
      const max = spec.staticBounds?.max ?? Number.MAX_SAFE_INTEGER;

      if (spec.dynamicBound === 'elapsed_ms' && maxDynamicElapsedMs !== undefined && val > maxDynamicElapsedMs) {
        if (spec.onInvalid === 'clamp_flag') {
          const clamped = Math.min(max, maxDynamicElapsedMs);
          mutableState[fieldName] = clamped;
          fieldFlags.push({
            field: `state.${fieldName}`,
            action: 'clamped',
            reason: 'dynamic_elapsed_bound_exceeded',
            originalValue: val,
            clampedValue: clamped,
          });
          rej.push(`clamp:state.${fieldName}:dynamic_elapsed_bound`);
        } else {
          mutableState[fieldName] = 0;
          fieldFlags.push({
            field: `state.${fieldName}`,
            action: 'dropped',
            reason: 'dynamic_elapsed_bound_exceeded',
            originalValue: val,
          });
          rej.push(`drop:state.${fieldName}:dynamic_elapsed_bound`);
        }
        continue;
      }

      if (val < min || val > max) {
        if (spec.onInvalid === 'clamp_flag') {
          const clamped = Math.min(max, Math.max(min, val));
          mutableState[fieldName] = clamped;
          fieldFlags.push({
            field: `state.${fieldName}`,
            action: 'clamped',
            reason: 'static_bound_exceeded',
            originalValue: val,
            clampedValue: clamped,
          });
          rej.push(`clamp:state.${fieldName}:static_bound`);
        } else {
          mutableState[fieldName] = 0;
          fieldFlags.push({
            field: `state.${fieldName}`,
            action: 'dropped',
            reason: 'static_bound_exceeded',
            originalValue: val,
          });
          rej.push(`drop:state.${fieldName}:static_bound`);
        }
      }
    }

    // Validate sample_pi bound [0.001, 1]
    const piVal = mutableState.sample_pi;
    if (typeof piVal !== 'number' || !Number.isFinite(piVal) || piVal < 0.001 || piVal > 1) {
      const clamped =
        typeof piVal === 'number' && Number.isFinite(piVal)
          ? Math.min(1, Math.max(0.001, piVal))
          : 1;
      mutableState.sample_pi = clamped;
      fieldFlags.push({
        field: 'state.sample_pi',
        action: 'clamped',
        reason: 'static_bound_exceeded',
        originalValue: piVal,
        clampedValue: clamped,
      });
      rej.push('clamp:state.sample_pi:static_bound');
    }

    // Validate optional envelope identifiers against consent mode (drop_flag)
    let sanitizedVisitorId = frame.visitor_id ?? null;
    let sanitizedSessionId = frame.session_id ?? null;
    let sanitizedMemberHash = frame.member_hash ?? null;

    if (frame.consent_mode === 'cookieless') {
      if (sanitizedVisitorId !== null) {
        sanitizedVisitorId = null;
        fieldFlags.push({
          field: 'visitor_id',
          action: 'dropped',
          reason: 'disallowed_in_cookieless',
        });
        rej.push('drop:visitor_id:disallowed_in_cookieless');
      }
      if (sanitizedSessionId !== null) {
        sanitizedSessionId = null;
        fieldFlags.push({
          field: 'session_id',
          action: 'dropped',
          reason: 'disallowed_in_cookieless',
        });
        rej.push('drop:session_id:disallowed_in_cookieless');
      }
    }

    if (sanitizedMemberHash !== null && !frame.purposes.includes('member_link')) {
      sanitizedMemberHash = null;
      fieldFlags.push({
        field: 'member_hash',
        action: 'dropped',
        reason: 'missing_purpose_member_link',
      });
      rej.push('drop:member_hash:missing_purpose_member_link');
    }

    // Validate string_slots (drop any unregistered slot rather than dropping the whole frame)
    let sanitizedStringSlots: Record<string, string> | undefined;
    if (frame.string_slots) {
      sanitizedStringSlots = {};
      for (const [slotName, slotVal] of Object.entries(frame.string_slots)) {
        if (!allowedBehaviourSlots.has(slotName) || forbiddenNames.has(slotName.toLowerCase())) {
          fieldFlags.push({
            field: `string_slots.${slotName}`,
            action: 'dropped',
            reason: 'unregistered_string_slot',
          });
          rej.push(`drop:string_slots.${slotName}:unregistered_string_slot`);
          continue;
        }
        sanitizedStringSlots[slotName] = slotVal;
      }
    }

    // Sanitize vitals bounds (drop_flag per vital, preserving valid vitals)
    let sanitizedVitals = frame.vitals ? { ...frame.vitals } : undefined;
    if (sanitizedVitals) {
      const vitalLimits: ReadonlyArray<readonly [keyof NonNullable<TelemetryFrame['vitals']>, number]> = [
        ['lcp_ms', 600000],
        ['inp_ms', 600000],
        ['cls_x1000', 100000],
        ['ttfb_ms', 600000],
      ];
      for (const [vKey, vMax] of vitalLimits) {
        const entry = sanitizedVitals[vKey];
        if (entry !== undefined) {
          if (
            typeof entry.value !== 'number' ||
            !Number.isFinite(entry.value) ||
            entry.value < 0 ||
            entry.value > vMax
          ) {
            delete sanitizedVitals[vKey];
            fieldFlags.push({
              field: `vitals.${vKey}`,
              action: 'dropped',
              reason: 'static_bound_exceeded',
              originalValue: entry.value,
            });
            rej.push(`drop:vitals.${vKey}:static_bound`);
          }
        }
      }
    }

    // Sanitize section registers (clamp out-of-range vis_ms / max_frac_permille per field)
    const sanitizedSections = Array.isArray(frame.sections)
      ? frame.sections
          .map((sec, idx) => {
            if (!sec || typeof sec.sec_fp !== 'string' || !/^[0-9a-f]{12}$/.test(sec.sec_fp)) {
              fieldFlags.push({
                field: `sections[${idx}].sec_fp`,
                action: 'dropped',
                reason: 'invalid_sec_fp',
              });
              rej.push(`drop:sections[${idx}].sec_fp`);
              return null;
            }
            let visMs = sec.vis_ms;
            const visCap = maxDynamicElapsedMs !== undefined ? Math.min(86400000, maxDynamicElapsedMs) : 86400000;
            if (typeof visMs !== 'number' || !Number.isFinite(visMs) || visMs < 0 || visMs > visCap) {
              const clamped = typeof visMs === 'number' && Number.isFinite(visMs) ? Math.min(visCap, Math.max(0, visMs)) : 0;
              fieldFlags.push({
                field: `sections[${idx}].vis_ms`,
                action: 'clamped',
                reason: 'bound_exceeded',
                originalValue: visMs,
                clampedValue: clamped,
              });
              rej.push(`clamp:sections[${idx}].vis_ms`);
              visMs = clamped;
            }
            let maxFrac = sec.max_frac_permille;
            if (typeof maxFrac !== 'number' || !Number.isFinite(maxFrac) || maxFrac < 0 || maxFrac > 1000) {
              const clamped = typeof maxFrac === 'number' && Number.isFinite(maxFrac) ? Math.min(1000, Math.max(0, maxFrac)) : 0;
              fieldFlags.push({
                field: `sections[${idx}].max_frac_permille`,
                action: 'clamped',
                reason: 'static_bound_exceeded',
                originalValue: maxFrac,
                clampedValue: clamped,
              });
              rej.push(`clamp:sections[${idx}].max_frac_permille`);
              maxFrac = clamped;
            }
            return { ...sec, vis_ms: visMs, max_frac_permille: maxFrac };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null)
      : [];

    // Sanitize log_items (drop invalid log item kinds or non-integer timeline chunks without dropping the whole frame)
    const sanitizedLogItems = Array.isArray(frame.log_items)
      ? frame.log_items.filter((item, idx) => {
          if (item.kind === 'timeline_chunk') {
            const validInts =
              Array.isArray(item.timeline_ints) &&
              item.timeline_ints.every((v: unknown) => typeof v === 'number' && Number.isInteger(v));
            if (!validInts) {
              fieldFlags.push({
                field: `log_items[${idx}]`,
                action: 'dropped',
                reason: 'timeline_not_integers_only',
              });
              rej.push(`drop:log_items[${idx}]:timeline_not_integers_only`);
              return false;
            }
          }
          return true;
        })
      : [];

    // Check original checksum before any clamping/dropping to track state_incomplete
    const checksumValid = verifyFrameChecksum(frame);

    const sanitizedWithoutChk: Omit<TelemetryFrame, 'chk'> = {
      ...frame,
      visitor_id: sanitizedVisitorId,
      session_id: sanitizedSessionId,
      member_hash: sanitizedMemberHash,
      state: mutableState as unknown as PageStatePayload,
      sections: sanitizedSections,
      log_items: sanitizedLogItems,
      ...(sanitizedVitals !== undefined ? { vitals: sanitizedVitals } : {}),
      ...(sanitizedStringSlots !== undefined ? { string_slots: sanitizedStringSlots } : {}),
    };

    const recomputedChk = computeFrameChecksum(sanitizedWithoutChk);
    const sanitizedFrame: TelemetryFrame = {
      ...sanitizedWithoutChk,
      chk: recomputedChk,
    };
    const stateIncomplete = !checksumValid;
    if (stateIncomplete) {
      rej.push('flag:state_incomplete:chk_mismatch');
    }

    return {
      accepted: true,
      partial: fieldFlags.length > 0,
      stateIncomplete,
      sanitizedFrame,
      fieldFlags,
      rej,
      quarantineRecord: null,
      ackHints: {
        seq: frame.seq,
        i_hw: recomputedChk.logHighWater,
        rej,
      },
    };
  };

  return {
    schemaVersion: schema.meta.schemaVersion,
    validateIngestFrame,
  };
}
