/**
 * UGOKI LINK v2 — Sandboxed Customer Destination Functions & LINK-Controlled Sender
 *
 * Implements Master Spec §11.11 #10:
 * 1. Customer transform functions execute inside a disposable `node:worker_threads` `Worker`
 *    with strict V8 heap `resourceLimits`, empty `env`, hard wall-clock termination, AND an
 *    inner zero-host-object `vm` context (`Object.create(null)`, `codeGeneration: { strings: false, wasm: false }`,
 *    frozen inner intrinsics) (C-12):
 *    - Physically zero host `Object` / `Function` / `JSON` references cross into the VM
 *    - `Object.constructor.constructor('return process')()` is blocked by both inner-realm isolation
 *      and `codeGeneration: { strings: false }`
 *    - `Object.prototype` / `JSON` mutations cannot escape the single invocation or poison host/other tenants
 *    - Heap OOM bombs (`'a'.repeat(1e8)`) hit the Worker's 32 MiB `maxOldGenerationSizeMb` ceiling without
 *      touching the host process heap
 * 2. LINK's dedicated sender performs ALL actual network delivery after checking:
 *    - Destination entitlement (3-category / D-30 / approved exceptions)
 *    - Revocation epoch & consent purposes
 *    - HTTPS-only + registered host allowlist
 *    - Canonical 128-bit IPv4/IPv6 DNS SSRF block (H-17: blocks hex/dotted IPv4-mapped IPv6 `::ffff:7f00:1`,
 *      `::ffff:a9fe:a9fe`, NAT64, 6to4, Teredo, octal/hex/int IPv4, loopback, RFC1918, metadata, CGNAT, ULA)
 *    - `redirect: 'manual'` + strict same-origin redirect enforcement so Vault credentials are NEVER leaked
 *      across origins on HTTP 3xx redirects (H-17)
 */

import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from 'node:worker_threads';
import { isPrivateOrReservedIp } from '../linkage';
import {
  evaluateDestinationEntitlement,
  type DeclarativeDestinationSpec,
  type DestinationEntitlementContext,
} from './destinations-catalog';

export const DEFAULT_SANDBOX_TIMEOUT_MS = 50;
export const MAX_SANDBOX_TIMEOUT_MS = 200;
export const DEFAULT_SANDBOX_MAX_OUTPUT_BYTES = 32 * 1024; // 32 KiB
export const MAX_SANDBOX_ERROR_BYTES = 512;
export const MAX_VERIFIED_REDIRECTS = 2;

const WORKER_MAX_OLD_GEN_MB = 32;
const WORKER_MAX_YOUNG_GEN_MB = 16;
const WORKER_STACK_SIZE_MB = 2;
const WORKER_BOOT_GRACE_MS = 2000;

export interface ProposedOutboundPayload {
  readonly method: 'POST' | 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface SandboxExecutionResult {
  readonly ok: boolean;
  readonly proposed: ProposedOutboundPayload | null;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface DnsResolverPort {
  resolveAll(hostname: string): Promise<readonly string[]>;
}

export interface CredentialVaultPort {
  getBoundAuthHeaders(
    tenantId: string,
    destinationId: string
  ): Promise<Readonly<Record<string, string>> | null>;
}

export interface OutboundHttpResponse {
  readonly status: number;
  readonly locationHeader?: string | null;
}

export interface OutboundHttpTransportPort {
  send(args: {
    readonly method: 'POST' | 'PUT';
    readonly url: string;
    readonly resolvedIp: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyJson: string;
    /** Always `'manual'` so HTTP clients never auto-follow redirects with Vault credentials attached (H-17). */
    readonly redirect?: 'manual';
  }): Promise<OutboundHttpResponse>;
}

export interface DestinationFunctionSendRequest {
  readonly tenantId: string;
  readonly destination: DeclarativeDestinationSpec;
  readonly transformCode: string;
  readonly eventInput: Readonly<Record<string, unknown>>;
  readonly eventRevocationEpoch: number;
  readonly currentRevocationEpoch: number;
  readonly allowedOutboundFields: readonly string[];
  readonly entitlementContext: DestinationEntitlementContext;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface DestinationFunctionSendOutcome {
  readonly delivered: boolean;
  readonly status:
    | 'ok'
    | 'not_entitled'
    | 'aborted_revoked'
    | 'sandbox_rejected'
    | 'ssrf_blocked'
    | 'host_not_allowed'
    | 'redirect_blocked'
    | 'credentials_missing'
    | 'http_error';
  readonly httpStatus?: number;
  readonly finalUrl?: string;
  readonly filteredBody?: Readonly<Record<string, unknown>>;
  readonly strippedFields: readonly string[];
  readonly reason?: string;
}

/**
 * Checks whether an IPv4 or IPv6 literal falls inside any private, loopback,
 * link-local, metadata, CGNAT, mapped/translated IPv6, or non-canonical range (H-17).
 */
export function isForbiddenInternalIp(ipRaw: string): boolean {
  return isPrivateOrReservedIp(ipRaw);
}

/**
 * Self-contained worker bootstrap script.
 * Note: ZERO host-realm objects are ever injected into `vm.createContext(Object.create(null))`.
 * Input crosses solely as a JSON string literal inside the isolated VM script, and inner
 * intrinsics (`JSON.parse`, `JSON.stringify`, prototypes) are captured and frozen before
 * untrusted customer code runs.
 */
const ISOLATED_WORKER_SCRIPT = `
'use strict';
const { workerData } = require('node:worker_threads');
const vm = require('node:vm');

const { i32, port, code, inputJson, timeoutMs, maxOutputBytes, maxErrorBytes } = workerData;
const effectiveMaxOutputBytes =
  typeof maxOutputBytes === 'number' && Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
    ? Math.floor(maxOutputBytes)
    : 32768;
const effectiveMaxErrorBytes =
  typeof maxErrorBytes === 'number' && Number.isFinite(maxErrorBytes) && maxErrorBytes > 0
    ? Math.floor(maxErrorBytes)
    : 512;

function truncateUtf8(str, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const limit = Math.floor(maxBytes);
  const s = String(str || '');
  if (Buffer.byteLength(s, 'utf8') <= limit) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, limit);
  let end = buf.length;
  // Step back over any trailing UTF-8 continuation bytes (0x80..0xBF)
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
    end -= 1;
  }
  // If the byte before continuations is a multi-byte lead byte (>= 0xC0) whose full
  // sequence does not fit within buf.length, drop the lead byte too so toString('utf8')
  // NEVER emits U+FFFD (3 bytes) and NEVER exceeds maxBytes.
  if (end > 0 && buf[end - 1] >= 0xc0) {
    const lead = buf[end - 1];
    const seqLen =
      (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 5;
    if (end - 1 + seqLen > buf.length) {
      end -= 1;
    }
  }
  let out = buf.subarray(0, end).toString('utf8');
  while (Buffer.byteLength(out, 'utf8') > limit && out.length > 0) {
    out = Array.from(out).slice(0, -1).join('');
  }
  return out;
}

if (i32) {
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
}

try {
  const nullGlobal = Object.create(null);
  const ctx = vm.createContext(nullGlobal, {
    codeGeneration: { strings: false, wasm: false },
  });

  const vmSource = [
    '"use strict";',
    '(function() {',
    '  const __jsonParse = JSON.parse;',
    '  const __jsonStringify = JSON.stringify;',
    '  Object.freeze(Object.prototype);',
    '  Object.freeze(Array.prototype);',
    '  Object.freeze(String.prototype);',
    '  Object.freeze(Number.prototype);',
    '  Object.freeze(Boolean.prototype);',
    '  Object.freeze(Function.prototype);',
    '  Object.freeze(JSON);',
    '  const __rawInput = ' + JSON.stringify(String(inputJson)) + ';',
    String(code),
    '  if (typeof transform !== "function") {',
    '    throw new Error("Destination function must declare function transform(event)");',
    '  }',
    '  const __ev = __jsonParse(__rawInput);',
    '  const __res = transform(__ev);',
    '  return __jsonStringify(__res);',
    '})();'
  ].join('\\n');

  const script = new vm.Script(vmSource, { filename: 'customer-destination-fn.js' });
  const rawOut = script.runInContext(ctx, {
    timeout: timeoutMs,
    breakOnSigint: true,
  });

  if (typeof rawOut === 'string') {
    const outBytes = Buffer.byteLength(rawOut, 'utf8');
    if (outBytes > effectiveMaxOutputBytes) {
      port.postMessage({
        ok: false,
        error: 'OUTPUT_SIZE_LIMIT_EXCEEDED',
        outputBytes: outBytes,
      });
    } else {
      port.postMessage({ ok: true, rawOut });
    }
  } else {
    port.postMessage({ ok: true, rawOut: null });
  }
} catch (err) {
  const msg = err && typeof err === 'object' && typeof err.message === 'string'
    ? err.message
    : String(err);
  const safeMsg = truncateUtf8(msg || 'sandbox_execution_error', effectiveMaxErrorBytes);
  port.postMessage({ ok: false, error: safeMsg || 'sandbox_execution_error' });
} finally {
  if (i32) {
    Atomics.store(i32, 1, 1);
    Atomics.notify(i32, 1);
  }
}
`;

const FORBIDDEN_PROTO_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function sanitizePlainRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const val = raw[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      clean[key] = sanitizePlainRecord(val as Record<string, unknown>);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

function truncateUtf8Error(str: string, maxBytes: number = MAX_SANDBOX_ERROR_BYTES): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const limit = Math.floor(maxBytes);
  if (Buffer.byteLength(str, 'utf8') <= limit) return str;
  const buf = Buffer.from(str, 'utf8').subarray(0, limit);
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end > 0 && buf[end - 1]! >= 0xc0) {
    const lead = buf[end - 1]!;
    const seqLen =
      (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 5;
    if (end - 1 + seqLen > buf.length) {
      end -= 1;
    }
  }
  let out = buf.subarray(0, end).toString('utf8');
  while (Buffer.byteLength(out, 'utf8') > limit && out.length > 0) {
    out = Array.from(out).slice(0, -1).join('');
  }
  return out;
}

function parseWorkerRawOutput(
  workerMsg:
    | {
        readonly ok: boolean;
        readonly rawOut?: string | null;
        readonly error?: string;
        readonly outputBytes?: number;
      }
    | undefined,
  maxOutputBytes: number,
  durationMs: number,
  fallbackError: string
): SandboxExecutionResult {
  if (!workerMsg) {
    return {
      ok: false,
      proposed: null,
      outputBytes: 0,
      durationMs,
      error: fallbackError,
    };
  }
  if (!workerMsg.ok) {
    if (workerMsg.error === 'OUTPUT_SIZE_LIMIT_EXCEEDED') {
      const bytes = typeof workerMsg.outputBytes === 'number' ? workerMsg.outputBytes : 0;
      return {
        ok: false,
        proposed: null,
        outputBytes: bytes,
        durationMs,
        error: `OUTPUT_SIZE_LIMIT_EXCEEDED: Transform output (${bytes} B) exceeded maxOutputBytes (${maxOutputBytes} B)`,
      };
    }
    return {
      ok: false,
      proposed: null,
      outputBytes: typeof workerMsg.outputBytes === 'number' ? workerMsg.outputBytes : 0,
      durationMs,
      error: truncateUtf8Error(workerMsg.error ?? fallbackError),
    };
  }
  if (typeof workerMsg.rawOut !== 'string') {
    return {
      ok: false,
      proposed: null,
      outputBytes: 0,
      durationMs,
      error: 'Transform function returned non-JSON-serializable result',
    };
  }

  const outputBytes = Buffer.byteLength(workerMsg.rawOut, 'utf8');
  if (outputBytes > maxOutputBytes) {
    return {
      ok: false,
      proposed: null,
      outputBytes,
      durationMs,
      error: `Transform output (${outputBytes} B) exceeded maxOutputBytes (${maxOutputBytes} B)`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(workerMsg.rawOut);
  } catch {
    return {
      ok: false,
      proposed: null,
      outputBytes,
      durationMs,
      error: 'Transform returned malformed JSON',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      proposed: null,
      outputBytes,
      durationMs,
      error: 'Transform must return a JSON object { method, url, headers, body }',
    };
  }

  const obj = parsed as Record<string, unknown>;
  const method = obj.method === 'PUT' ? 'PUT' : 'POST';
  const url = typeof obj.url === 'string' ? obj.url : '';
  const headers: Record<string, string> = {};
  if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
    const rawHeaders = obj.headers as Record<string, unknown>;
    for (const k of Object.keys(rawHeaders)) {
      if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
      const v = rawHeaders[k];
      if (typeof v === 'string') {
        headers[k.toLowerCase()] = v;
      }
    }
  }
  const body =
    obj.body && typeof obj.body === 'object' && !Array.isArray(obj.body)
      ? sanitizePlainRecord(obj.body as Record<string, unknown>)
      : null;

  if (!url || !body) {
    return {
      ok: false,
      proposed: null,
      outputBytes,
      durationMs,
      error: 'Proposed payload must include non-empty url string and body object',
    };
  }

  return {
    ok: true,
    proposed: { method, url, headers, body },
    outputBytes,
    durationMs,
  };
}

/**
 * Executes a customer-supplied transform function inside a disposable `node:worker_threads`
 * `Worker` (`resourceLimits`, `env: {}`) + zero-host-object `vm` context (C-12).
 */
export function executeDestinationFunctionSandboxed(args: {
  readonly code: string;
  readonly eventInput: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): SandboxExecutionResult {
  const tStart = Date.now();
  const timeoutMs = Math.min(
    MAX_SANDBOX_TIMEOUT_MS,
    Math.max(5, args.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)
  );
  const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_SANDBOX_MAX_OUTPUT_BYTES;
  const inputJson = JSON.stringify(args.eventInput);

  const sab = new SharedArrayBuffer(8);
  const i32 = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();

  let worker: Worker | null = null;
  try {
    worker = new Worker(ISOLATED_WORKER_SCRIPT, {
      eval: true,
      env: {},
      stdin: false,
      stdout: false,
      stderr: false,
      workerData: {
        i32,
        port: port2,
        code: args.code,
        inputJson,
        timeoutMs,
        maxOutputBytes,
        maxErrorBytes: MAX_SANDBOX_ERROR_BYTES,
      },
      transferList: [port2],
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB,
        maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GEN_MB,
        stackSizeMb: WORKER_STACK_SIZE_MB,
      },
    });
    // Suppress unhandled error events on OOM / termination; status is read from port
    worker.on('error', () => {});
    worker.unref();

    // 1. Wait for worker thread bootstrap (independent of user script CPU budget)
    Atomics.wait(i32, 0, 0, WORKER_BOOT_GRACE_MS);

    // 2. Wait strictly up to timeoutMs (+ small IPC cushion) for isolated execution
    const waitStatus = Atomics.wait(i32, 1, 0, timeoutMs + 80);
    const received = receiveMessageOnPort(port1) as
      | { message: { readonly ok: boolean; readonly rawOut?: string | null; readonly error?: string } }
      | undefined;

    const durationMs = Math.max(0, Date.now() - tStart);
    const fallbackErr =
      waitStatus === 'timed-out'
        ? `Script execution timed out after ${timeoutMs}ms or exceeded worker memory limit`
        : 'Sandbox worker terminated (resource limit or fatal error)';

    return parseWorkerRawOutput(received?.message, maxOutputBytes, durationMs, fallbackErr);
  } catch (err) {
    const msg =
      err !== null &&
      typeof err === 'object' &&
      'message' in err &&
      typeof (err as { message: unknown }).message === 'string'
        ? (err as { message: string }).message
        : String(err);
    return {
      ok: false,
      proposed: null,
      outputBytes: 0,
      durationMs: Math.max(0, Date.now() - tStart),
      error: msg || 'sandbox_worker_error',
    };
  } finally {
    port1.close();
    if (worker) {
      void worker.terminate().catch(() => {});
    }
  }
}

/**
 * Async variant used by `LinkControlledDestinationSender` that awaits full worker teardown.
 */
export async function executeDestinationFunctionIsolatedAsync(args: {
  readonly code: string;
  readonly eventInput: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): Promise<SandboxExecutionResult> {
  const tStart = Date.now();
  const timeoutMs = Math.min(
    MAX_SANDBOX_TIMEOUT_MS,
    Math.max(5, args.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS)
  );
  const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_SANDBOX_MAX_OUTPUT_BYTES;
  const inputJson = JSON.stringify(args.eventInput);

  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(ISOLATED_WORKER_SCRIPT, {
    eval: true,
    env: {},
    stdin: false,
    stdout: false,
    stderr: false,
    workerData: {
      i32: null,
      port: port2,
      code: args.code,
      inputJson,
      timeoutMs,
      maxOutputBytes,
      maxErrorBytes: MAX_SANDBOX_ERROR_BYTES,
    },
    transferList: [port2],
    resourceLimits: {
      maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB,
      maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GEN_MB,
      stackSizeMb: WORKER_STACK_SIZE_MB,
    },
  });

  try {
    const workerMsg = await new Promise<
      { readonly ok: boolean; readonly rawOut?: string | null; readonly error?: string } | undefined
    >((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: `Script execution timed out after ${timeoutMs}ms` });
        }
      }, WORKER_BOOT_GRACE_MS + timeoutMs);

      port1.once('message', (msg) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(msg as { readonly ok: boolean; readonly rawOut?: string | null; readonly error?: string });
        }
      });

      worker.once('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: err instanceof Error ? err.message : 'worker_resource_limit_exceeded' });
        }
      });

      worker.once('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(
            code === 0
              ? undefined
              : { ok: false, error: `Sandbox worker exited with code ${code} (memory/CPU limit)` }
          );
        }
      });
    });

    const durationMs = Math.max(0, Date.now() - tStart);
    return parseWorkerRawOutput(workerMsg, maxOutputBytes, durationMs, 'sandbox_worker_terminated');
  } finally {
    port1.close();
    await worker.terminate().catch(() => {});
  }
}

function looksLikeIpOrNonPublicHostLiteral(hostLower: string): boolean {
  if (
    hostLower === 'localhost' ||
    hostLower.endsWith('.localhost') ||
    hostLower.endsWith('.internal') ||
    hostLower.includes(':') ||
    hostLower.startsWith('[')
  ) {
    return true;
  }
  // Pure digits/dots/hex (catches dotted IPv4, octal `0177.0.0.1`, hex `0x7f000001`, integer `2130706433`)
  return /^[0-9xXa-fA-F.]+$/.test(hostLower) && !/[a-z]/i.test(hostLower.replace(/0x/gi, ''));
}

/**
 * LINK-owned outbound sender enforcing every §11.11 #10 security & privacy
 * invariant on top of customer destination function proposals.
 */
export class LinkControlledDestinationSender {
  public constructor(
    private readonly dnsResolver: DnsResolverPort,
    private readonly credentialVault: CredentialVaultPort,
    private readonly httpTransport: OutboundHttpTransportPort
  ) {}

  private async verifyUrlAndResolveSafeIp(
    rawUrl: string,
    allowedHosts: readonly string[]
  ): Promise<
    | { readonly ok: true; readonly url: string; readonly origin: string; readonly resolvedIp: string }
    | { readonly ok: false; readonly status: 'host_not_allowed' | 'ssrf_blocked'; readonly reason: string }
  > {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return {
        ok: false,
        status: 'host_not_allowed',
        reason: `Malformed outbound URL: ${rawUrl}`,
      };
    }

    if (parsed.protocol !== 'https:') {
      return {
        ok: false,
        status: 'host_not_allowed',
        reason: `Only https:// outbound destinations are permitted (got ${parsed.protocol})`,
      };
    }

    if (parsed.username || parsed.password) {
      return {
        ok: false,
        status: 'host_not_allowed',
        reason: 'Userinfo credentials in outbound URL are forbidden',
      };
    }

    const hostLower = parsed.hostname.toLowerCase();
    // Check IP/internal host literal BEFORE allowlist so misconfigured IP allowlists still fail SSRF check
    if (looksLikeIpOrNonPublicHostLiteral(hostLower) && isForbiddenInternalIp(hostLower)) {
      return {
        ok: false,
        status: 'ssrf_blocked',
        reason: `Direct internal/private IP literal blocked: ${hostLower}`,
      };
    }

    const allowedLower = allowedHosts.map((h) => h.toLowerCase());
    if (!allowedLower.includes(hostLower)) {
      return {
        ok: false,
        status: 'host_not_allowed',
        reason: `Target host "${hostLower}" is not in destination allowlist [${allowedLower.join(', ')}]`,
      };
    }

    const ips = await this.dnsResolver.resolveAll(hostLower);
    if (ips.length === 0) {
      return {
        ok: false,
        status: 'ssrf_blocked',
        reason: `DNS resolution returned zero addresses for "${hostLower}"`,
      };
    }

    // Reject if ANY resolved address is private/loopback/metadata/mapped-IPv6 (prevents DNS rebinding/multi-A/AAAA bypass)
    for (const ip of ips) {
      if (isForbiddenInternalIp(ip)) {
        return {
          ok: false,
          status: 'ssrf_blocked',
          reason: `DNS resolved "${hostLower}" to forbidden internal/metadata IP "${ip}"`,
        };
      }
    }

    return {
      ok: true,
      url: parsed.toString(),
      origin: parsed.origin,
      resolvedIp: ips[0]!,
    };
  }

  public async executeAndSend(
    req: DestinationFunctionSendRequest
  ): Promise<DestinationFunctionSendOutcome> {
    // 1. Entitlement check (3 categories / D-30 / approved exceptions / relay propagation)
    const entitlement = evaluateDestinationEntitlement(
      req.destination,
      req.entitlementContext
    );
    if (!entitlement.entitled) {
      return {
        delivered: false,
        status: 'not_entitled',
        strippedFields: [],
        reason: entitlement.reason,
      };
    }

    // 2. Revocation epoch check BEFORE running or sending
    if (req.eventRevocationEpoch < req.currentRevocationEpoch) {
      return {
        delivered: false,
        status: 'aborted_revoked',
        strippedFields: [],
        reason: `Event revocationEpoch (${req.eventRevocationEpoch}) < current (${req.currentRevocationEpoch})`,
      };
    }

    // 3. Run customer transform function in disposable Worker + isolated VM (NO creds, NO net)
    const sandboxRes = await executeDestinationFunctionIsolatedAsync({
      code: req.transformCode,
      eventInput: req.eventInput,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: req.maxOutputBytes,
    });
    if (!sandboxRes.ok || !sandboxRes.proposed) {
      return {
        delivered: false,
        status: 'sandbox_rejected',
        strippedFields: [],
        reason: sandboxRes.error ?? 'sandbox_failed',
      };
    }

    // 4. Filter outbound body strictly to allowed fields
    const allowedFieldSet = new Set(req.allowedOutboundFields);
    const filteredBody: Record<string, unknown> = {};
    const strippedFields: string[] = [];
    for (const [k, v] of Object.entries(sandboxRes.proposed.body)) {
      if (allowedFieldSet.has(k)) {
        filteredBody[k] = v;
      } else {
        strippedFields.push(k);
      }
    }

    // 5. Retrieve tenant × destination bound credentials AFTER sandbox exits
    const boundAuthHeaders = await this.credentialVault.getBoundAuthHeaders(
      req.tenantId,
      req.destination.id
    );
    if (!boundAuthHeaders) {
      return {
        delivered: false,
        status: 'credentials_missing',
        strippedFields,
        reason: `No credentials bound for tenant="${req.tenantId}" destination="${req.destination.id}"`,
      };
    }

    // Strip any auth/host headers customer function tried to forge, then apply bound credentials
    const finalHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(sandboxRes.proposed.headers)) {
      const kl = k.toLowerCase();
      if (
        kl === 'authorization' ||
        kl === 'proxy-authorization' ||
        kl === 'host' ||
        kl === 'cookie' ||
        kl === 'x-api-key'
      ) {
        continue;
      }
      finalHeaders[kl] = v;
    }
    finalHeaders['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(boundAuthHeaders)) {
      finalHeaders[k.toLowerCase()] = v;
    }

    // 6. Verify initial URL + enforce `redirect: 'manual'` & strict same-origin redirect guard (H-17)
    let currentUrl = sandboxRes.proposed.url;
    let initialOrigin: string | null = null;
    const bodyJson = JSON.stringify(filteredBody);

    for (let hop = 0; hop <= MAX_VERIFIED_REDIRECTS; hop += 1) {
      const check = await this.verifyUrlAndResolveSafeIp(
        currentUrl,
        req.destination.allowedHosts
      );
      if (!check.ok) {
        return {
          delivered: false,
          status: hop === 0 ? check.status : 'redirect_blocked',
          strippedFields,
          reason: hop === 0 ? check.reason : `Redirect hop ${hop} blocked: ${check.reason}`,
        };
      }

      if (initialOrigin === null) {
        initialOrigin = check.origin;
      } else if (check.origin !== initialOrigin) {
        // NEVER forward Vault credentials across different origins on 3xx redirect (H-17)!
        return {
          delivered: false,
          status: 'redirect_blocked',
          strippedFields,
          reason: `Cross-origin redirect (${initialOrigin} -> ${check.origin}) blocked to protect Vault credentials`,
        };
      }

      const resp = await this.httpTransport.send({
        method: sandboxRes.proposed.method,
        url: check.url,
        resolvedIp: check.resolvedIp,
        headers: finalHeaders,
        bodyJson,
        redirect: 'manual',
      });

      if (resp.status >= 300 && resp.status < 400 && resp.locationHeader) {
        if (hop === MAX_VERIFIED_REDIRECTS) {
          return {
            delivered: false,
            status: 'redirect_blocked',
            httpStatus: resp.status,
            strippedFields,
            reason: `Exceeded max redirect hops (${MAX_VERIFIED_REDIRECTS})`,
          };
        }
        let nextUrlObj: URL;
        try {
          nextUrlObj = new URL(resp.locationHeader, check.url);
        } catch {
          return {
            delivered: false,
            status: 'redirect_blocked',
            httpStatus: resp.status,
            strippedFields,
            reason: 'Malformed redirect Location header',
          };
        }
        if (nextUrlObj.origin !== initialOrigin) {
          return {
            delivered: false,
            status: 'redirect_blocked',
            httpStatus: resp.status,
            strippedFields,
            reason: `Cross-origin redirect (${initialOrigin} -> ${nextUrlObj.origin}) blocked to protect Vault credentials`,
          };
        }
        currentUrl = nextUrlObj.toString();
        continue;
      }

      if (resp.status >= 200 && resp.status < 300) {
        return {
          delivered: true,
          status: 'ok',
          httpStatus: resp.status,
          finalUrl: check.url,
          filteredBody,
          strippedFields,
        };
      }

      return {
        delivered: false,
        status: 'http_error',
        httpStatus: resp.status,
        finalUrl: check.url,
        strippedFields,
        reason: `Destination returned HTTP ${resp.status}`,
      };
    }

    return {
      delivered: false,
      status: 'redirect_blocked',
      strippedFields,
      reason: 'Redirect loop terminated',
    };
  }
}
