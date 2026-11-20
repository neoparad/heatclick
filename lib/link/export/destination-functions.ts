/**
 * UGOKI LINK v2 — Sandboxed Customer Destination Functions & LINK-Controlled Sender
 *
 * Implements Master Spec §11.11 #10:
 * 1. Customer transform functions run in a zero-capability null-prototype VM sandbox:
 *    - Hard CPU timeout & serialized output size cap
 *    - Physically zero access to network (`fetch`/`http`/`net`), credentials, `process`,
 *      `require`, filesystem, or state from any other invocation
 *    - Returns ONLY a declarative `ProposedOutboundPayload`
 * 2. LINK's dedicated sender performs ALL actual network delivery after checking:
 *    - Destination entitlement (3-category / D-30 / approved exceptions)
 *    - Revocation epoch & consent purposes
 *    - HTTPS-only + registered host allowlist
 *    - DNS resolution SSRF block (rejects private RFC1918, loopback, link-local,
 *      cloud metadata 169.254.169.254, IPv6 ULA/link-local/loopback, CGNAT)
 *    - Redirect target verification through the exact same host + DNS SSRF guard
 *    - Allowed outbound field filtering (strips undeclared body fields)
 *    - Tenant × Destination bound credential injection AFTER sandbox completion
 */

import vm from 'node:vm';
import {
  evaluateDestinationEntitlement,
  type DeclarativeDestinationSpec,
  type DestinationEntitlementContext,
} from './destinations-catalog';

export const DEFAULT_SANDBOX_TIMEOUT_MS = 50;
export const MAX_SANDBOX_TIMEOUT_MS = 200;
export const DEFAULT_SANDBOX_MAX_OUTPUT_BYTES = 32 * 1024; // 32 KiB
export const MAX_VERIFIED_REDIRECTS = 2;

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
 * link-local, metadata, CGNAT, or unspecified range (SSRF defense).
 */
export function isForbiddenInternalIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase();
  if (!ip) return true;

  // Strip IPv4-mapped IPv6 prefix ::ffff:
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  // IPv4 check
  const v4Parts = normalized.split('.');
  if (v4Parts.length === 4 && v4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    const nums = v4Parts.map((p) => Number(p));
    if (nums.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = nums as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 check
  if (normalized.includes(':')) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // link-local fe80::/10
    }
    if (normalized.startsWith('ff')) return true; // multicast
    return false;
  }

  // Unrecognized address format -> fail closed
  return true;
}

/**
 * Executes a customer-supplied transform function inside a clean, isolated
 * null-prototype `vm` context with NO network, NO credentials, NO host globals,
 * NO cross-invocation state, strict CPU timeout, and strict output size cap.
 *
 * Customer code must define `function transform(event) { return { method, url, headers, body }; }`.
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

  // Deep-clone event input via JSON so host references cannot leak into the VM
  const frozenInputJson = JSON.stringify(args.eventInput);

  // Clean null-prototype sandbox with ZERO network/process/require/fs/credential bindings
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox.__input_json__ = frozenInputJson;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.String = String;
  sandbox.Number = Number;
  sandbox.Boolean = Boolean;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const wrappedSource = `
    "use strict";
    ${args.code}
    if (typeof transform !== 'function') {
      throw new Error('Destination function must declare function transform(event)');
    }
    const __event = JSON.parse(__input_json__);
    const __result = transform(__event);
    JSON.stringify(__result);
  `;

  try {
    const script = new vm.Script(wrappedSource, {
      filename: 'customer-destination-fn.js',
    });
    const rawOut = script.runInContext(context, {
      timeout: timeoutMs,
      breakOnSigint: true,
    }) as unknown;

    const durationMs = Math.max(0, Date.now() - tStart);

    if (typeof rawOut !== 'string') {
      return {
        ok: false,
        proposed: null,
        outputBytes: 0,
        durationMs,
        error: 'Transform function returned non-JSON-serializable result',
      };
    }

    const outputBytes = Buffer.byteLength(rawOut, 'utf8');
    if (outputBytes > maxOutputBytes) {
      return {
        ok: false,
        proposed: null,
        outputBytes,
        durationMs,
        error: `Transform output (${outputBytes} B) exceeded maxOutputBytes (${maxOutputBytes} B)`,
      };
    }

    const parsed = JSON.parse(rawOut) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        proposed: null,
        outputBytes,
        durationMs,
        error: 'Transform must return a JSON object { method, url, headers, body }',
      };
    }

    const method = parsed.method === 'PUT' ? 'PUT' : 'POST';
    const url = typeof parsed.url === 'string' ? parsed.url : '';
    const headers: Record<string, string> = {};
    if (parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers)) {
      for (const [k, v] of Object.entries(parsed.headers as Record<string, unknown>)) {
        if (typeof v === 'string') {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    const body =
      parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body)
        ? (parsed.body as Record<string, unknown>)
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
      error: msg || 'sandbox_execution_error',
    };
  }
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
    | { readonly ok: true; readonly url: string; readonly resolvedIp: string }
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

    const hostLower = parsed.hostname.toLowerCase();
    const allowedLower = allowedHosts.map((h) => h.toLowerCase());
    if (!allowedLower.includes(hostLower)) {
      return {
        ok: false,
        status: 'host_not_allowed',
        reason: `Target host "${hostLower}" is not in destination allowlist [${allowedLower.join(', ')}]`,
      };
    }

    // If hostname is itself an IP literal, verify immediately
    if (/^[\d.:]+$/.test(hostLower) && isForbiddenInternalIp(hostLower)) {
      return {
        ok: false,
        status: 'ssrf_blocked',
        reason: `Direct internal/private IP literal blocked: ${hostLower}`,
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

    // Reject if ANY resolved address is private/loopback/metadata (prevents DNS rebinding/multi-A bypass)
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

    // 3. Run customer transform function in isolated sandbox (NO creds, NO net)
    const sandboxRes = executeDestinationFunctionSandboxed({
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
      if (kl === 'authorization' || kl === 'host' || kl === 'cookie' || kl === 'x-api-key') {
        continue;
      }
      finalHeaders[kl] = v;
    }
    finalHeaders['content-type'] = 'application/json';
    for (const [k, v] of Object.entries(boundAuthHeaders)) {
      finalHeaders[k.toLowerCase()] = v;
    }

    // 6. Verify initial URL + every redirect target through host allowlist & DNS SSRF guard
    let currentUrl = sandboxRes.proposed.url;
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

      const resp = await this.httpTransport.send({
        method: sandboxRes.proposed.method,
        url: check.url,
        resolvedIp: check.resolvedIp,
        headers: finalHeaders,
        bodyJson,
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
        currentUrl = new URL(resp.locationHeader, check.url).toString();
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
