/**
 * Invariant I7 (§11.5 / SUR M7 / D-37):
 * Every externally-collected string (URL, referrer, click text, User-Agent,
 * page content, site search term, UTM campaign, customer event strings,
 * heatmap text) MUST travel inside an `UntrustedValue` container so AI agents
 * and downstream consumers never execute attacker-controlled strings as instructions.
 */

import { sha256Hex } from './sha256';

export const UNTRUSTED_SOURCES = [
  'url',
  'referrer',
  'click_text',
  'user_agent',
  'page_content',
  'site_search_term',
  'utm_campaign',
  'customer_event_string',
  'heatmap_text',
  'external_query',
] as const;

export type UntrustedSource = (typeof UNTRUSTED_SOURCES)[number];

export const DEFAULT_UNTRUSTED_MAX_CHARS = 16_384 as const;
export const HARD_CAP_UNTRUSTED_MAX_CHARS = 65_536 as const;

const UNTRUSTED_SOURCE_SET: ReadonlySet<string> = new Set(UNTRUSTED_SOURCES);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MINTED_TO_JSON_FNS = new WeakSet<(...args: unknown[]) => unknown>();

const CANONICAL_FULL_KEYS = [
  '__ugk_untrusted',
  '__untrusted',
  'handle',
  'kind',
  'lang',
  'len',
  'max_chars',
  'raw_text',
  'sha',
  'source',
  'value',
] as const;

const CANONICAL_COMPACT_KEYS = [
  '__ugk_untrusted',
  'max_chars',
  'raw_text',
  'source',
] as const;

export interface UntrustedValue {
  readonly __untrusted: true;
  readonly __ugk_untrusted: true;
  readonly source: UntrustedSource;
  readonly kind: UntrustedSource;
  readonly sha: string;
  readonly len: number;
  readonly lang: string | null;
  readonly handle: string;
  readonly value: string | null;
  readonly raw_text: string | null;
  readonly max_chars: number;
  toJSON?(): {
    readonly __untrusted: true;
    readonly __ugk_untrusted: true;
    readonly source: UntrustedSource;
    readonly kind: UntrustedSource;
    readonly sha: string;
    readonly len: number;
    readonly lang: string | null;
    readonly handle: string;
    readonly value: string | null;
    readonly raw_text: string | null;
    readonly max_chars: number;
  };
}

export interface WrapUntrustedOptions {
  /** When false, emits handle-only representation (`value: null`, `raw_text: null`) per D-37. Defaults to true. */
  readonly includeValue?: boolean;
  /** Optional BCP-47 language tag (e.g. 'ja', 'en'). */
  readonly lang?: string | null;
  /** Maximum character budget for `raw_text`/`value` (defaults to 16,384; max 65,536). */
  readonly maxChars?: number;
}

/**
 * Wraps an externally-collected string in the canonical `UntrustedValue` container.
 * Its `toJSON()` preserves the full `{ __ugk_untrusted: true, source, raw_text, max_chars, ... }`
 * wrapper and NEVER unwraps to a raw string.
 */
export function wrapUntrusted(
  raw: string,
  source: UntrustedSource,
  options?: WrapUntrustedOptions
): UntrustedValue {
  if (typeof raw !== 'string') {
    throw new TypeError(`wrapUntrusted expects a string, got ${typeof raw}`);
  }
  if (!UNTRUSTED_SOURCE_SET.has(source)) {
    throw new TypeError(`Unknown UntrustedSource: "${String(source)}"`);
  }

  const maxChars = options?.maxChars ?? DEFAULT_UNTRUSTED_MAX_CHARS;
  if (
    typeof maxChars !== 'number' ||
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > HARD_CAP_UNTRUSTED_MAX_CHARS
  ) {
    throw new TypeError(`maxChars must be an integer in [1, ${HARD_CAP_UNTRUSTED_MAX_CHARS}]`);
  }

  const bounded = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  const sha = sha256Hex(bounded);
  const includeValue = options?.includeValue ?? true;
  const lang = options?.lang ?? null;
  if (lang !== null && typeof lang !== 'string') {
    throw new TypeError('lang must be a string or null');
  }
  const textPayload = includeValue ? bounded : null;
  const handle = `utr_${sha.slice(0, 16)}`;

  const snapshot = Object.freeze({
    __untrusted: true as const,
    __ugk_untrusted: true as const,
    source,
    kind: source,
    sha,
    len: bounded.length,
    lang,
    handle,
    value: textPayload,
    raw_text: textPayload,
    max_chars: maxChars,
  });

  const container: Record<string, unknown> = {
    __untrusted: true,
    __ugk_untrusted: true,
    source,
    kind: source,
    sha,
    len: bounded.length,
    lang,
    handle,
    value: textPayload,
    raw_text: textPayload,
    max_chars: maxChars,
  };

  const toJsonFn = function toJSON() {
    return snapshot;
  };
  MINTED_TO_JSON_FNS.add(toJsonFn);

  Object.defineProperty(container, 'toJSON', {
    value: toJsonFn,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(container) as unknown as UntrustedValue;
}

function exactStringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Strictly validates that an object is an intact, untampered `UntrustedValue`:
 * - Enforces `Object.getPrototypeOf(candidate) === Object.prototype` (rejects `Object.create(...)`, classes, null-proto)
 * - Enforces exact own data property keys (rejects extra own keys, symbols, getters/setters, or unminted `toJSON`)
 * - Verifies `__ugk_untrusted === true`, `source`, `raw_text`, `max_chars`, and SHA-256 integrity
 */
export function isUntrustedValue(candidate: unknown): candidate is UntrustedValue {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(candidate);
  const enumerableKeys: string[] = [];

  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return false;
    }
    const desc = Object.getOwnPropertyDescriptor(candidate, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      return false;
    }
    if (key === 'toJSON') {
      if (desc.enumerable !== false || typeof desc.value !== 'function' || !MINTED_TO_JSON_FNS.has(desc.value as (...args: unknown[]) => unknown)) {
        return false;
      }
      continue;
    }
    if (!desc.enumerable) {
      return false;
    }
    enumerableKeys.push(key);
  }

  enumerableKeys.sort();
  const rec = candidate as Record<string, unknown>;

  if (exactStringArrayEqual(enumerableKeys, CANONICAL_COMPACT_KEYS)) {
    if (rec.__ugk_untrusted !== true) return false;
    if (typeof rec.source !== 'string' || !UNTRUSTED_SOURCE_SET.has(rec.source)) return false;
    if (
      typeof rec.max_chars !== 'number' ||
      !Number.isInteger(rec.max_chars) ||
      rec.max_chars < 1 ||
      rec.max_chars > HARD_CAP_UNTRUSTED_MAX_CHARS
    ) {
      return false;
    }
    if (rec.raw_text !== null && typeof rec.raw_text !== 'string') return false;
    if (typeof rec.raw_text === 'string' && rec.raw_text.length > rec.max_chars) return false;
    return true;
  }

  if (!exactStringArrayEqual(enumerableKeys, CANONICAL_FULL_KEYS)) {
    return false;
  }

  if (rec.__untrusted !== true || rec.__ugk_untrusted !== true) return false;
  if (typeof rec.source !== 'string' || !UNTRUSTED_SOURCE_SET.has(rec.source)) return false;
  if (rec.kind !== rec.source) return false;
  if (typeof rec.sha !== 'string' || !SHA256_HEX_RE.test(rec.sha)) return false;
  if (
    typeof rec.max_chars !== 'number' ||
    !Number.isInteger(rec.max_chars) ||
    rec.max_chars < 1 ||
    rec.max_chars > HARD_CAP_UNTRUSTED_MAX_CHARS
  ) {
    return false;
  }
  if (
    typeof rec.len !== 'number' ||
    !Number.isInteger(rec.len) ||
    rec.len < 0 ||
    rec.len > rec.max_chars
  ) {
    return false;
  }
  if (rec.lang !== null && typeof rec.lang !== 'string') return false;
  if (typeof rec.handle !== 'string' || rec.handle !== `utr_${rec.sha.slice(0, 16)}`) return false;
  if (rec.value !== null && typeof rec.value !== 'string') return false;
  if (rec.raw_text !== rec.value) return false;

  if (typeof rec.value === 'string') {
    if (rec.value.length !== rec.len) return false;
    if (sha256Hex(rec.value) !== rec.sha) return false;
  }
  return true;
}

export interface UntrustedLeakFinding {
  readonly path: string;
  readonly reason:
    | 'UNWRAPPED_EXTERNAL_KEY'
    | 'UNWRAPPED_URL_STRING'
    | 'UNWRAPPED_USER_AGENT_STRING'
    | 'MALFORMED_UNTRUSTED_CONTAINER'
    | 'INVALID_SYSTEM_URL';
  readonly key?: string;
  readonly message: string;
}

/**
 * Property key names that denote externally-collected strings and MUST always
 * hold an `UntrustedValue` (or `null`/`undefined`) rather than a raw string.
 */
const EXTERNAL_ORIGIN_KEYS: ReadonlySet<string> = new Set([
  'url',
  'page_url',
  'page_url_key',
  'raw_url',
  'final_url',
  'href',
  'dest_url',
  'dest_key_click',
  'referrer',
  'referer',
  'external_referrer',
  'external_referrer_key',
  'click_text',
  'anchor_text',
  'element_text',
  'button_text',
  'user_agent',
  'useragent',
  'raw_ua',
  'ua',
  'page_title',
  'page_content',
  'section_text',
  'excerpt',
  'search_term',
  'site_search_term',
  'query_text',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'campaign_param',
  'heatmap_text',
  'customer_string',
]);

const RAW_HTTP_URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;
const RAW_DANGEROUS_SCHEME_RE = /(?:^|[\s"'<>])(?:javascript|vbscript|data):/i;
const RAW_UA_RE = /\b(?:Mozilla\/5\.0|AppleWebKit\/\d+|Gecko\/\d{8}|Chrome\/\d+|Safari\/\d+|GPTBot|ClaudeBot|PerplexityBot|Googlebot)\b/;

/**
 * Validates a strict HTTP(S) URL with zero whitespace, zero control chars,
 * zero angle brackets/quotes, and zero embedded credentials.
 */
export function isStrictSafeHttpUrl(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2048) {
    return false;
  }
  if (/[\s\x00-\x1f\x7f"'<>\\]/.test(candidate)) {
    return false;
  }
  if (RAW_UA_RE.test(candidate)) {
    return false;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '' || !parsed.hostname) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deeply inspects any envelope/payload object and detects unwrapped external-origin
 * strings, dangerous schemes, non-plain inherited properties, or tampered `UntrustedValue` containers.
 * Note: NO blanket raw-string key exemptions exist — every string in the envelope is scanned recursively.
 */
export function detectUntrustedStringLeaks(
  payload: unknown,
  rootPath = '$'
): readonly UntrustedLeakFinding[] {
  const findings: UntrustedLeakFinding[] = [];
  const visited = new WeakSet<object>();

  const walk = (node: unknown, path: string, currentKey: string | null): void => {
    if (node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      const normalizedKey = currentKey?.toLowerCase() ?? '';

      // Special system block `$.policy.policy_url`: if provided as a raw string at top-level policy block ONLY,
      // it MUST be a strict safe HTTP(S) URL without whitespace/control chars/UA; anywhere else (e.g. `$.data`),
      // `policy_url` has ZERO raw-string exemption!
      if (path === '$.policy.policy_url') {
        if (!isStrictSafeHttpUrl(node)) {
          findings.push({
            path,
            key: currentKey ?? 'policy_url',
            reason: 'INVALID_SYSTEM_URL',
            message: `policy_url at ${path} must be a strict HTTPS/HTTP URL without whitespace/control chars or wrapped in UntrustedValue`,
          });
        }
        return;
      }

      if (normalizedKey === 'policy_url') {
        findings.push({
          path,
          key: currentKey ?? 'policy_url',
          reason: 'UNWRAPPED_EXTERNAL_KEY',
          message: `Property "${currentKey}" outside $.policy must be wrapped in UntrustedValue`,
        });
        return;
      }

      if (currentKey !== null && EXTERNAL_ORIGIN_KEYS.has(normalizedKey)) {
        findings.push({
          path,
          key: currentKey,
          reason: 'UNWRAPPED_EXTERNAL_KEY',
          message: `External-origin property "${currentKey}" contains a raw string instead of UntrustedValue`,
        });
        return;
      }

      if (RAW_DANGEROUS_SCHEME_RE.test(node)) {
        findings.push({
          path,
          key: currentKey ?? undefined,
          reason: 'UNWRAPPED_URL_STRING',
          message: `Dangerous URI scheme detected outside UntrustedValue at ${path}`,
        });
        return;
      }

      if (RAW_HTTP_URL_RE.test(node)) {
        findings.push({
          path,
          key: currentKey ?? undefined,
          reason: 'UNWRAPPED_URL_STRING',
          message: `Raw HTTP(S) URL string detected outside UntrustedValue at ${path}`,
        });
        return;
      }

      if (RAW_UA_RE.test(node)) {
        findings.push({
          path,
          key: currentKey ?? undefined,
          reason: 'UNWRAPPED_USER_AGENT_STRING',
          message: `Raw User-Agent / crawler identifier string detected outside UntrustedValue at ${path}`,
        });
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${path}[${i}]`, currentKey);
      }
      return;
    }

    const rec = node as Record<string, unknown>;

    // If this object claims to be an UntrustedValue (via own or inherited marker), verify strictly
    if ('__untrusted' in rec || '__ugk_untrusted' in rec) {
      if (!isUntrustedValue(rec)) {
        findings.push({
          path,
          key: currentKey ?? undefined,
          reason: 'MALFORMED_UNTRUSTED_CONTAINER',
          message: `Malformed or tampered UntrustedValue container at ${path}`,
        });
      }
      return;
    }

    // Walk ALL own keys (including symbol-named or non-enumerable own keys if someone tried to smuggle)
    for (const key of Reflect.ownKeys(rec)) {
      if (typeof key !== 'string') {
        findings.push({
          path: `${path}[${String(key)}]`,
          reason: 'MALFORMED_UNTRUSTED_CONTAINER',
          message: `Unexpected symbol property ${String(key)} inside envelope object at ${path}`,
        });
        continue;
      }
      walk(rec[key], `${path}.${key}`, key);
    }

    // Also scan any enumerable inherited properties on non-plain prototypes
    const proto = Object.getPrototypeOf(rec);
    if (proto !== null && proto !== Object.prototype) {
      for (const k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) {
          walk(rec[k], `${path}.${k}`, k);
        }
      }
    }
  };

  walk(payload, rootPath, null);
  return findings;
}

export function assertNoUntrustedStringLeaks(payload: unknown, rootPath = '$'): void {
  const leaks = detectUntrustedStringLeaks(payload, rootPath);
  if (leaks.length > 0) {
    const details = leaks.map((l) => `[${l.reason}] ${l.path}: ${l.message}`).join('; ');
    throw new Error(`Untrusted string leak detected: ${details}`);
  }
}
