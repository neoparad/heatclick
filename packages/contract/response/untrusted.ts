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

const UNTRUSTED_SOURCE_SET: ReadonlySet<string> = new Set(UNTRUSTED_SOURCES);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface UntrustedValue {
  readonly __untrusted: true;
  readonly source: UntrustedSource;
  readonly kind: UntrustedSource;
  readonly sha: string;
  readonly len: number;
  readonly lang: string | null;
  readonly handle: string;
  readonly value: string | null;
}

export interface WrapUntrustedOptions {
  /** When false, emits handle-only representation (`value: null`) per D-37. Defaults to true. */
  readonly includeValue?: boolean;
  /** Optional BCP-47 language tag (e.g. 'ja', 'en'). */
  readonly lang?: string | null;
}

/**
 * Wraps an externally-collected string in the canonical `UntrustedValue` container.
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

  const sha = sha256Hex(raw);
  const includeValue = options?.includeValue ?? true;

  return Object.freeze({
    __untrusted: true as const,
    source,
    kind: source,
    sha,
    len: raw.length,
    lang: options?.lang ?? null,
    handle: `utr_${sha.slice(0, 16)}`,
    value: includeValue ? raw : null,
  });
}

/**
 * Strictly validates that an object is an intact, untampered `UntrustedValue`.
 */
export function isUntrustedValue(candidate: unknown): candidate is UntrustedValue {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const rec = candidate as Record<string, unknown>;
  if (rec.__untrusted !== true) return false;
  if (typeof rec.source !== 'string' || !UNTRUSTED_SOURCE_SET.has(rec.source)) return false;
  if (rec.kind !== rec.source) return false;
  if (typeof rec.sha !== 'string' || !SHA256_HEX_RE.test(rec.sha)) return false;
  if (typeof rec.len !== 'number' || !Number.isInteger(rec.len) || rec.len < 0) return false;
  if (rec.lang !== null && typeof rec.lang !== 'string') return false;
  if (typeof rec.handle !== 'string' || rec.handle !== `utr_${rec.sha.slice(0, 16)}`) return false;
  if (rec.value !== null && typeof rec.value !== 'string') return false;

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
    | 'MALFORMED_UNTRUSTED_CONTAINER';
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
  'userAgent',
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

/**
 * System-owned URL paths explicitly exempt from raw URL leak detection
 * (e.g., internal approval UI URLs or first-party opt-out/disclosure URLs).
 */
const ALLOWED_SYSTEM_URL_KEYS: ReadonlySet<string> = new Set([
  'approval_url',
  'optout_url',
  'disclosure_url',
  'policy_url',
]);

const RAW_HTTP_URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;
const RAW_UA_RE = /\b(?:Mozilla\/5\.0|AppleWebKit\/\d+|Gecko\/\d{8}|Chrome\/\d+|Safari\/\d+|GPTBot|ClaudeBot|PerplexityBot|Googlebot)\b/;

/**
 * Deeply inspects any envelope/payload object and detects unwrapped external-origin
 * strings or tampered `UntrustedValue` containers.
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

      if (currentKey !== null && ALLOWED_SYSTEM_URL_KEYS.has(normalizedKey)) {
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

    // If this object claims to be an UntrustedValue, verify its integrity and stop descending
    if ('__untrusted' in rec) {
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

    for (const [k, v] of Object.entries(rec)) {
      walk(v, `${path}.${k}`, k);
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
