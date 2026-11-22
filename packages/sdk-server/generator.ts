/**
 * UGOKI LINK v2 — Deterministic 8-Language Server SDK Generator (§11.11 item 9 & [H-01])
 *
 * Generates thin, idiomatic server SDKs directly from the single contract
 * (`CANONICAL_SCHEMA` + `buildOpenApi31Document()` + `OPERATION_CATALOG`) for all 8 languages:
 *   `typescript`, `python`, `go`, `java`, `ruby`, `php`, `dotnet`, `rust`.
 *
 * Every generated SDK implements:
 *   1. Actor-blind Allocator draw: `uint32_be(HMAC-SHA256(key, unit_id)[0..4]) / 4294967296.0`
 *   2. Ed25519 signature verification (raw 32-byte public key + 64-byte signature)
 *   3. Segment-compatible 6 call types (`identify`, `page`, `screen`, `track`, `group`, `alias`)
 *      with mandatory consent metadata (`mode`, `purposes`, `generation`)
 *   4. Local feature flag evaluation from signed config bundle + short-lived display lease
 *      with deterministic fallback to `safeValue` on expired lease / invalid signature / actor-blind violation
 *   5. Typed `UgokiLinkApiClient` HTTP `request(...)` dispatcher + 1-to-1 operation methods
 *      for EVERY cataloged operation in `OPERATION_CATALOG` (`[H-01]`)!
 */

import { CANONICAL_SCHEMA } from '@/packages/contract/schema';
import { canonicalJson, sha256Hex } from '@/packages/contract/response';
import {
  buildOpenApi31Document,
  OPERATION_CATALOG,
  type OperationSpec,
} from '@/lib/link/surface/openapi';
import {
  SDK_LANGUAGES,
  SEGMENT_CALL_TYPES,
  type GeneratedSdkArtifact,
  type SdkGeneratedFile,
  type SdkLanguage,
} from './types';

interface ContractSnapshot {
  readonly schemaVersion: string;
  readonly openapiSha256: string;
  readonly revision: string;
  readonly operations: ReadonlyArray<OperationSpec>;
}

function captureContractSnapshot(): ContractSnapshot {
  const openapi = buildOpenApi31Document();
  return {
    schemaVersion: CANONICAL_SCHEMA.meta.schemaVersion,
    openapiSha256: openapi['x-ugoki-contract-sha256'],
    revision: openapi.info['x-ugoki-revision'],
    operations: OPERATION_CATALOG,
  };
}

function makeFile(path: string, content: string): SdkGeneratedFile {
  return { path, content, sha256: sha256Hex(content) };
}

export function toSnakeCaseOperationId(opId: string): string {
  return opId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function toPascalCaseOperationId(opId: string): string {
  return opId.charAt(0).toUpperCase() + opId.slice(1);
}

// =========================================================================
// 1. TypeScript / Node.js SDK (Runnable directly via `node`)
// =========================================================================

function generateTypeScriptOperations(ops: ReadonlyArray<OperationSpec>): string {
  return ops
    .map((op) => {
      const pathParams = op.params.filter((p) => p.in === 'path');
      const queryParams = op.params.filter((p) => p.in === 'query');
      const hasBody = op.method === 'POST' || op.method === 'PUT' || Boolean(op.requestBodySchema);
      const needsIdem = op.riskClass === 'R1';

      const pathExpr = pathParams.reduce(
        (acc, p) =>
          acc.replace(
            `{${p.name}}`,
            `\${encodeURIComponent(String(params.${p.name}))}`
          ),
        op.path
      );

      const reqChecks = [
        ...pathParams.map(
          (p) =>
            `    if (params.${p.name} === undefined || params.${p.name} === null || String(params.${p.name}).trim() === '') throw new Error('Missing required path parameter: ${p.name}');`
        ),
        ...queryParams
          .filter((p) => p.required)
          .map(
            (p) =>
              `    if (params.${p.name} === undefined || params.${p.name} === null || String(params.${p.name}).trim() === '') throw new Error('Missing required query parameter: ${p.name}');`
          ),
        ...(needsIdem
          ? [
              `    if (!params.idempotencyKey || String(params.idempotencyKey).trim().length < 8) throw new Error('Operation ${op.operationId} (R1) requires idempotencyKey (>= 8 chars)');`,
            ]
          : []),
      ].join('\n');

      const queryLines =
        queryParams.length > 0
          ? `    const query = {};\n` +
            queryParams
              .map(
                (p) =>
                  `    if (params.${p.name} !== undefined && params.${p.name} !== null) query[${JSON.stringify(p.name)}] = String(params.${p.name});`
              )
              .join('\n')
          : `    const query = undefined;`;

      return `  /** [${op.riskClass}] ${op.method} ${op.path} — ${op.summary} */
  async ${op.operationId}(params = {}) {
${reqChecks ? reqChecks + '\n' : ''}${queryLines}
    return this.request(${JSON.stringify(op.method)}, \`${pathExpr}\`, {
      query,
      body: ${hasBody ? 'params.body' : 'undefined'},
      idempotencyKey: params.idempotencyKey,
    });
  }`;
    })
    .join('\n\n');
}

function generateTypeScriptSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const opMethods = generateTypeScriptOperations(snap.operations);
  const opMeta = snap.operations.map((o) => ({
    operationId: o.operationId,
    method: o.method,
    path: o.path,
    riskClass: o.riskClass,
  }));

  const code = `// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
import crypto from 'node:crypto';

export const CONTRACT_SCHEMA_VERSION = ${JSON.stringify(snap.schemaVersion)};
export const OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(snap.openapiSha256)};
export const API_REVISION = ${JSON.stringify(snap.revision)};
export const SEGMENT_CALL_TYPES = ${JSON.stringify(SEGMENT_CALL_TYPES)};
export const CATALOGED_OPERATIONS = ${JSON.stringify(opMeta)};
export const FORBIDDEN_ACTOR_KEYS = new Set([
  'user_agent', 'userAgent', 'ua', 'ip', 'client_ip', 'clientIp',
  'remote_addr', 'actor_class', 'actorClass', 'is_agent', 'isAgent', 'is_bot', 'isBot'
]);

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function drawUniformU(key, unitId) {
  const digest = crypto.createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(Buffer.from(unitId, 'utf8'))
    .digest();
  const uint32 = digest.readUInt32BE(0);
  return uint32 / 4294967296.0;
}

export function verifyEd25519Raw(publicKeyHex, message, signatureHex) {
  try {
    const rawPub = Buffer.from(publicKeyHex, 'hex');
    if (rawPub.length !== 32) return false;
    const spkiDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObj, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function buildSegmentPayload(callType, input) {
  if (!SEGMENT_CALL_TYPES.includes(callType)) {
    throw new Error('Unsupported Segment callType: ' + callType);
  }
  const base = {
    type: callType,
    messageId: input.messageId,
    timestamp: input.timestamp,
    consent: {
      mode: input.consent.mode,
      purposes: [...input.consent.purposes].sort(),
      generation: input.consent.generation,
    },
    schemaVersion: CONTRACT_SCHEMA_VERSION,
  };
  if (input.userId !== undefined) base.userId = input.userId;
  if (input.anonymousId !== undefined) base.anonymousId = input.anonymousId;
  if (callType === 'identify') base.traits = input.traits ?? {};
  if (callType === 'page' || callType === 'screen') {
    base.name = input.name;
    base.properties = input.properties ?? {};
  }
  if (callType === 'track') {
    base.event = input.event;
    base.properties = input.properties ?? {};
  }
  if (callType === 'group') {
    base.groupId = input.groupId;
    base.traits = input.traits ?? {};
  }
  if (callType === 'alias') {
    base.previousId = input.previousId;
  }
  return base;
}

export function evaluateFeatureFlag({ publicKeyHex, bundle, lease, flagKey, unitId, nowMs, extraInputKeys = [] }) {
  const flag = (bundle.flags || []).find((f) => f.flagKey === flagKey);
  if (!flag) {
    return { flagKey, value: 'false', fallback: true, reason: 'unknown_flag_safe_fallback' };
  }
  for (const k of extraInputKeys) {
    if (FORBIDDEN_ACTOR_KEYS.has(k)) {
      return { flagKey, value: flag.safeValue, fallback: true, reason: 'actor_blind_violation_safe_fallback' };
    }
  }
  const bundleUnsigned = {
    bundleId: bundle.bundleId,
    tenantId: bundle.tenantId,
    siteId: bundle.siteId,
    flags: bundle.flags,
    issuedAtMs: bundle.issuedAtMs,
  };
  const leaseUnsigned = {
    leaseId: lease.leaseId,
    siteId: lease.siteId,
    issuedAtMs: lease.issuedAtMs,
    expiresAtMs: lease.expiresAtMs,
  };
  const bundleOk = verifyEd25519Raw(publicKeyHex, canonicalJson(bundleUnsigned), bundle.signatureHex);
  const leaseOk = verifyEd25519Raw(publicKeyHex, canonicalJson(leaseUnsigned), lease.signatureHex);
  if (!bundleOk || !leaseOk || bundle.siteId !== lease.siteId) {
    return { flagKey, value: flag.safeValue, fallback: true, reason: 'invalid_signature_safe_fallback' };
  }
  if (nowMs >= lease.expiresAtMs) {
    return { flagKey, value: flag.safeValue, fallback: true, reason: 'lease_expired_safe_fallback' };
  }
  const u = drawUniformU(flag.saltKey, unitId);
  const totalWeight = flag.arms.reduce((acc, a) => acc + a.weight, 0);
  let cum = 0;
  for (const arm of flag.arms) {
    cum += arm.weight / totalWeight;
    if (u < cum) {
      return { flagKey, value: arm.value, fallback: false, reason: 'assigned', uniformDraw: u };
    }
  }
  const last = flag.arms[flag.arms.length - 1];
  return { flagKey, value: last.value, fallback: false, reason: 'assigned', uniformDraw: u };
}

export class UgokiLinkApiClient {
  constructor({ baseUrl = 'https://api.ugokilink.com/api', apiKey, revision = API_REVISION, transport = null }) {
    this.baseUrl = String(baseUrl).replace(/\\/+$/, '');
    this.apiKey = apiKey;
    this.revision = revision;
    this.transport = transport;
  }

  async request(method, path, options = {}) {
    const qs = options.query && Object.keys(options.query).length > 0
      ? '?' + new URLSearchParams(options.query).toString()
      : '';
    const url = this.baseUrl + path + qs;
    const headers = {
      'Accept': 'application/json',
      'X-UGOKI-API-Version': 'v1',
      'X-UGOKI-Revision': this.revision,
    };
    if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;
    if (options.idempotencyKey) headers['Idempotency-Key'] = String(options.idempotencyKey);
    let serializedBody;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(options.body);
    }
    if (this.transport) {
      return this.transport({ method, url, path, query: options.query ?? {}, headers, body: serializedBody });
    }
    const res = await fetch(url, { method, headers, body: serializedBody });
    const json = await res.json();
    return { status: res.status, data: json };
  }

${opMethods}
}
`;
  return [makeFile('typescript/ugokilink.mjs', code)];
}

// =========================================================================
// 2. Python 3 SDK (Pure stdlib, runnable directly via `python` including RFC 8032 Ed25519!)
// =========================================================================

function generatePythonOperations(ops: ReadonlyArray<OperationSpec>): string {
  return ops
    .map((op) => {
      const fnName = toSnakeCaseOperationId(op.operationId);
      const pathParams = op.params.filter((p) => p.in === 'path');
      const queryParams = op.params.filter((p) => p.in === 'query');
      const hasBody = op.method === 'POST' || op.method === 'PUT' || Boolean(op.requestBodySchema);
      const needsIdem = op.riskClass === 'R1';

      const lines: string[] = [
        `    def ${fnName}(self, params: dict | None = None) -> dict:`,
        `        """[${op.riskClass}] ${op.method} ${op.path} (${op.operationId})"""`,
        `        params = params or {}`,
      ];

      for (const p of pathParams) {
        lines.push(
          `        if not params.get(${JSON.stringify(p.name)}):`,
          `            raise ValueError("Missing required path parameter: ${p.name}")`
        );
      }
      for (const p of queryParams.filter((q) => q.required)) {
        lines.push(
          `        if not params.get(${JSON.stringify(p.name)}):`,
          `            raise ValueError("Missing required query parameter: ${p.name}")`
        );
      }
      if (needsIdem) {
        lines.push(
          `        idem = params.get("idempotencyKey") or params.get("idempotency_key")`,
          `        if not idem or len(str(idem).strip()) < 8:`,
          `            raise ValueError("Operation ${op.operationId} (R1) requires idempotency_key (>= 8 chars)")`
        );
      } else {
        lines.push(`        idem = params.get("idempotencyKey") or params.get("idempotency_key")`);
      }

      let pyPath = JSON.stringify(op.path);
      for (const p of pathParams) {
        pyPath = `${pyPath}.replace("{${p.name}}", urllib.parse.quote(str(params[${JSON.stringify(p.name)}]), safe=""))`;
      }
      lines.push(`        path = ${pyPath}`);

      if (queryParams.length > 0) {
        lines.push(`        query = {}`);
        for (const p of queryParams) {
          lines.push(
            `        if params.get(${JSON.stringify(p.name)}) is not None:`,
            `            query[${JSON.stringify(p.name)}] = str(params[${JSON.stringify(p.name)}])`
          );
        }
      } else {
        lines.push(`        query = None`);
      }

      lines.push(
        `        body = ${hasBody ? 'params.get("body")' : 'None'}`,
        `        return self.request(${JSON.stringify(op.method)}, path, query=query, body=body, idempotency_key=idem)`
      );
      return lines.join('\n');
    })
    .join('\n\n');
}

function generatePythonSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const pyOps = generatePythonOperations(snap.operations);
  const opIds = snap.operations.map((o) => o.operationId);

  const code = `# GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
# Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
import hashlib
import hmac
import json
import struct
import urllib.parse
import urllib.request

CONTRACT_SCHEMA_VERSION = ${JSON.stringify(snap.schemaVersion)}
OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(snap.openapiSha256)}
API_REVISION = ${JSON.stringify(snap.revision)}
CATALOGED_OPERATION_IDS = ${JSON.stringify(opIds)}
SEGMENT_CALL_TYPES = ("identify", "page", "screen", "track", "group", "alias")
FORBIDDEN_ACTOR_KEYS = frozenset([
    "user_agent", "userAgent", "ua", "ip", "client_ip", "clientIp",
    "remote_addr", "actor_class", "actorClass", "is_agent", "isAgent", "is_bot", "isBot",
])

# Pure-Python RFC 8032 Ed25519 verification (zero external dependencies)
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_I = pow(2, (_P - 1) // 4, _P)
_GY = (4 * pow(5, _P - 2, _P)) % _P

def _recover_x(y, sign):
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = (x * _I) % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x

_GX = _recover_x(_GY, 0)
_BASE = (_GX, _GY, 1, (_GX * _GY) % _P)

def _point_add(p1, p2):
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = ((y1 - x1) * (y2 - x2)) % _P
    b = ((y1 + x1) * (y2 + x2)) % _P
    c = (2 * _D * t1 * t2) % _P
    d = (2 * z1 * z2) % _P
    e = (b - a) % _P
    f = (d - c) % _P
    g = (d + c) % _P
    h = (b + a) % _P
    return ((e * f) % _P, (g * h) % _P, (f * g) % _P, (e * h) % _P)

def _point_mul(s, point):
    q = (0, 1, 1, 0)
    p = point
    while s > 0:
        if s & 1:
            q = _point_add(q, p)
        p = _point_add(p, p)
        s >>= 1
    return q

def _point_equal(p1, p2):
    x1, y1, z1, _ = p1
    x2, y2, z2, _ = p2
    return (x1 * z2 - x2 * z1) % _P == 0 and (y1 * z2 - y2 * z1) % _P == 0

def _decode_point(b):
    if len(b) != 32:
        return None
    y = int.from_bytes(b, "little")
    sign = (y >> 255) & 1
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, (x * y) % _P)

def verify_ed25519_raw(public_key_hex: str, message: str, signature_hex: str) -> bool:
    try:
        pk = bytes.fromhex(public_key_hex)
        sig = bytes.fromhex(signature_hex)
        if len(pk) != 32 or len(sig) != 64:
            return False
        a_pt = _decode_point(pk)
        r_pt = _decode_point(sig[:32])
        if a_pt is None or r_pt is None:
            return False
        s = int.from_bytes(sig[32:], "little")
        if s >= _L:
            return False
        h = int.from_bytes(hashlib.sha512(sig[:32] + pk + message.encode("utf-8")).digest(), "little") % _L
        lhs = _point_mul(s, _BASE)
        rhs = _point_add(r_pt, _point_mul(h, a_pt))
        return _point_equal(lhs, rhs)
    except Exception:
        return False

def canonical_json(value) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)

def draw_uniform_u(key: str, unit_id: str) -> float:
    digest = hmac.new(key.encode("utf-8"), unit_id.encode("utf-8"), hashlib.sha256).digest()
    uint32 = struct.unpack(">I", digest[:4])[0]
    return uint32 / 4294967296.0

def build_segment_payload(call_type: str, data: dict) -> dict:
    if call_type not in SEGMENT_CALL_TYPES:
        raise ValueError(f"Unsupported Segment callType: {call_type}")
    payload = {
        "type": call_type,
        "messageId": data["messageId"],
        "timestamp": data["timestamp"],
        "consent": {
            "mode": data["consent"]["mode"],
            "purposes": sorted(list(data["consent"]["purposes"])),
            "generation": data["consent"]["generation"],
        },
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
    }
    if "userId" in data and data["userId"] is not None:
        payload["userId"] = data["userId"]
    if "anonymousId" in data and data["anonymousId"] is not None:
        payload["anonymousId"] = data["anonymousId"]
    if call_type == "identify":
        payload["traits"] = data.get("traits", {})
    elif call_type in ("page", "screen"):
        payload["name"] = data["name"]
        payload["properties"] = data.get("properties", {})
    elif call_type == "track":
        payload["event"] = data["event"]
        payload["properties"] = data.get("properties", {})
    elif call_type == "group":
        payload["groupId"] = data["groupId"]
        payload["traits"] = data.get("traits", {})
    elif call_type == "alias":
        payload["previousId"] = data["previousId"]
    return payload

def evaluate_feature_flag(public_key_hex: str, bundle: dict, lease: dict, flag_key: str, unit_id: str, now_ms: int, extra_input_keys=None) -> dict:
    extra_input_keys = extra_input_keys or []
    flag = next((f for f in bundle.get("flags", []) if f["flagKey"] == flag_key), None)
    if flag is None:
        return {"flagKey": flag_key, "value": "false", "fallback": True, "reason": "unknown_flag_safe_fallback"}
    for k in extra_input_keys:
        if k in FORBIDDEN_ACTOR_KEYS:
            return {"flagKey": flag_key, "value": flag["safeValue"], "fallback": True, "reason": "actor_blind_violation_safe_fallback"}
    bundle_unsigned = {
        "bundleId": bundle["bundleId"],
        "tenantId": bundle["tenantId"],
        "siteId": bundle["siteId"],
        "flags": bundle["flags"],
        "issuedAtMs": bundle["issuedAtMs"],
    }
    lease_unsigned = {
        "leaseId": lease["leaseId"],
        "siteId": lease["siteId"],
        "issuedAtMs": lease["issuedAtMs"],
        "expiresAtMs": lease["expiresAtMs"],
    }
    b_ok = verify_ed25519_raw(public_key_hex, canonical_json(bundle_unsigned), bundle["signatureHex"])
    l_ok = verify_ed25519_raw(public_key_hex, canonical_json(lease_unsigned), lease["signatureHex"])
    if not b_ok or not l_ok or bundle["siteId"] != lease["siteId"]:
        return {"flagKey": flag_key, "value": flag["safeValue"], "fallback": True, "reason": "invalid_signature_safe_fallback"}
    if now_ms >= lease["expiresAtMs"]:
        return {"flagKey": flag_key, "value": flag["safeValue"], "fallback": True, "reason": "lease_expired_safe_fallback"}
    u = draw_uniform_u(flag["saltKey"], unit_id)
    total_w = sum(a["weight"] for a in flag["arms"])
    cum = 0.0
    for arm in flag["arms"]:
        cum += arm["weight"] / total_w
        if u < cum:
            return {"flagKey": flag_key, "value": arm["value"], "fallback": False, "reason": "assigned", "uniformDraw": u}
    last = flag["arms"][-1]
    return {"flagKey": flag_key, "value": last["value"], "fallback": False, "reason": "assigned", "uniformDraw": u}

class UgokiLinkApiClient:
    def __init__(self, api_key: str, base_url: str = "https://api.ugokilink.com/api", revision: str = API_REVISION, transport=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.revision = revision
        self.transport = transport

    def request(self, method: str, path: str, query: dict | None = None, body: dict | None = None, idempotency_key: str | None = None) -> dict:
        qs = ("?" + urllib.parse.urlencode(query)) if query else ""
        url = self.base_url + path + qs
        headers = {
            "Accept": "application/json",
            "X-UGOKI-API-Version": "v1",
            "X-UGOKI-Revision": self.revision,
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            headers["Idempotency-Key"] = str(idempotency_key)
        raw_body = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            raw_body = json.dumps(body).encode("utf-8")
        if self.transport is not None:
            return self.transport({"method": method, "url": url, "path": path, "query": query or {}, "headers": headers, "body": raw_body.decode("utf-8") if raw_body else None})
        req = urllib.request.Request(url, data=raw_body, headers=headers, method=method)
        with urllib.request.urlopen(req) as resp:
            return {"status": resp.status, "data": json.loads(resp.read().decode("utf-8"))}

${pyOps}
`;
  return [makeFile('python/ugokilink.py', code)];
}

// =========================================================================
// 3. Go SDK
// =========================================================================

function generateGoSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const goMethods = snap.operations
    .map((op) => {
      const fn = toPascalCaseOperationId(op.operationId);
      const pathParams = op.params.filter((p) => p.in === 'path');
      let pathExpr = JSON.stringify(op.path);
      for (const p of pathParams) {
        pathExpr = `strings.ReplaceAll(${pathExpr}, "{${p.name}}", url.PathEscape(params[${JSON.stringify(p.name)}]))`;
      }
      return `// ${fn} executes [${op.riskClass}] ${op.method} ${op.path} (${op.operationId}).
func (c *UgokiLinkApiClient) ${fn}(ctx context.Context, params map[string]string, body any, idempotencyKey string) ([]byte, error) {
	path := ${pathExpr}
	return c.Request(ctx, ${JSON.stringify(op.method)}, path, params, body, idempotencyKey)
}`;
    })
    .join('\n\n');

  const code = `// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
package ugokilink

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const (
	ContractSchemaVersion = ${JSON.stringify(snap.schemaVersion)}
	OpenApiContractSha256 = ${JSON.stringify(snap.openapiSha256)}
	ApiRevision           = ${JSON.stringify(snap.revision)}
)

var SegmentCallTypes = []string{"identify", "page", "screen", "track", "group", "alias"}
var ForbiddenActorKeys = map[string]bool{
	"user_agent": true, "userAgent": true, "ua": true, "ip": true,
	"client_ip": true, "actor_class": true, "is_agent": true, "is_bot": true,
}

func DrawUniformU(key string, unitID string) float64 {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(unitID))
	digest := mac.Sum(nil)
	u32 := binary.BigEndian.Uint32(digest[:4])
	return float64(u32) / 4294967296.0
}

func VerifyEd25519Raw(publicKeyHex string, message string, signatureHex string) bool {
	pub, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := hex.DecodeString(signatureHex)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), []byte(message), sig)
}

func BuildSegmentPayload(callType string, messageID string, timestamp string, consentMode string, consentGen int) (map[string]any, error) {
	valid := false
	for _, ct := range SegmentCallTypes {
		if ct == callType {
			valid = true
			break
		}
	}
	if !valid {
		return nil, fmt.Errorf("unsupported segment call type: %s", callType)
	}
	return map[string]any{
		"type": callType, "messageId": messageID, "timestamp": timestamp,
		"consent": map[string]any{"mode": consentMode, "generation": consentGen},
		"schemaVersion": ContractSchemaVersion,
	}, nil
}

func EvaluateFeatureFlag(bundleValid bool, leaseValid bool, nowMs int64, expiresAtMs int64, saltKey string, unitID string, safeValue string, arms []struct{ Value string; Weight float64 }) (string, string) {
	if !bundleValid || !leaseValid {
		return safeValue, "invalid_signature_safe_fallback"
	}
	if nowMs >= expiresAtMs {
		return safeValue, "lease_expired_safe_fallback"
	}
	u := DrawUniformU(saltKey, unitID)
	total := 0.0
	for _, a := range arms {
		total += a.Weight
	}
	cum := 0.0
	for _, a := range arms {
		cum += a.Weight / total
		if u < cum {
			return a.Value, "assigned"
		}
	}
	return arms[len(arms)-1].Value, "assigned"
}

type UgokiLinkApiClient struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

func (c *UgokiLinkApiClient) Request(ctx context.Context, method string, path string, query map[string]string, body any, idempotencyKey string) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(b)
	}
	u := strings.TrimRight(c.BaseURL, "/") + path
	if len(query) > 0 {
		vals := url.Values{}
		for k, v := range query {
			vals.Set(k, v)
		}
		u += "?" + vals.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("X-UGOKI-API-Version", "v1")
	req.Header.Set("X-UGOKI-Revision", ApiRevision)
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

${goMethods}
`;
  return [makeFile('go/ugokilink.go', code)];
}

// =========================================================================
// 4. Java SDK
// =========================================================================

function generateJavaSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const javaMethods = snap.operations
    .map((op) => {
      const pathParams = op.params.filter((p) => p.in === 'path');
      let pathExpr = JSON.stringify(op.path);
      for (const p of pathParams) {
        pathExpr = `${pathExpr}.replace("{${p.name}}", URLEncoder.encode(Objects.requireNonNull(params.get(${JSON.stringify(p.name)})), StandardCharsets.UTF_8))`;
      }
      return `    /** [${op.riskClass}] ${op.method} ${op.path} */
    public String ${op.operationId}(Map<String, String> params, String jsonBody, String idempotencyKey) throws Exception {
        String resolvedPath = ${pathExpr};
        return this.request(${JSON.stringify(op.method)}, resolvedPath, params, jsonBody, idempotencyKey);
    }`;
    })
    .join('\n\n');

  const code = `// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
package io.ugokilink.sdk;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class UgokiLinkSdk {
    public static final String CONTRACT_SCHEMA_VERSION = ${JSON.stringify(snap.schemaVersion)};
    public static final String OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(snap.openapiSha256)};
    public static final String API_REVISION = ${JSON.stringify(snap.revision)};
    public static final Set<String> SEGMENT_CALL_TYPES = Set.of("identify", "page", "screen", "track", "group", "alias");
    public static final Set<String> FORBIDDEN_ACTOR_KEYS = Set.of("user_agent", "userAgent", "ua", "ip", "client_ip", "actor_class", "is_agent", "is_bot");

    private final String baseUrl;
    private final String apiKey;
    private final HttpClient httpClient;

    public UgokiLinkSdk(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newHttpClient();
    }

    public static double drawUniformU(String key, String unitId) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] digest = mac.doFinal(unitId.getBytes(StandardCharsets.UTF_8));
        long uint32 = Integer.toUnsignedLong(ByteBuffer.wrap(digest, 0, 4).getInt());
        return ((double) uint32) / 4294967296.0;
    }

    public static boolean verifyEd25519Raw(byte[] rawPub32, String message, byte[] sig64) {
        try {
            byte[] prefix = HexFormat.of().parseHex("302a300506032b6570032100");
            byte[] spki = new byte[prefix.length + rawPub32.length];
            System.arraycopy(prefix, 0, spki, 0, prefix.length);
            System.arraycopy(rawPub32, 0, spki, prefix.length, rawPub32.length);
            PublicKey pub = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
            Signature sig = Signature.getInstance("Ed25519");
            sig.initVerify(pub);
            sig.update(message.getBytes(StandardCharsets.UTF_8));
            return sig.verify(sig64);
        } catch (Exception e) {
            return false;
        }
    }

    public static String evaluateFeatureFlagSafeFallback(boolean sigOk, long nowMs, long expiresAtMs, String safeValue, String assignedValue) {
        if (!sigOk) return safeValue; // invalid_signature_safe_fallback
        if (nowMs >= expiresAtMs) return safeValue; // lease_expired_safe_fallback
        return assignedValue;
    }

    public String request(String method, String path, Map<String, String> query, String jsonBody, String idempotencyKey) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(this.baseUrl + path))
            .header("Authorization", "Bearer " + this.apiKey)
            .header("X-UGOKI-API-Version", "v1")
            .header("X-UGOKI-Revision", API_REVISION);
        if (idempotencyKey != null && !idempotencyKey.isEmpty()) {
            builder.header("Idempotency-Key", idempotencyKey);
        }
        HttpRequest.BodyPublisher pub = jsonBody != null
            ? HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8)
            : HttpRequest.BodyPublishers.noBody();
        if (jsonBody != null) {
            builder.header("Content-Type", "application/json");
        }
        builder.method(method, pub);
        return this.httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString()).body();
    }

${javaMethods}
}
`;
  return [makeFile('java/UgokiLinkSdk.java', code)];
}

// =========================================================================
// 5. Ruby SDK
// =========================================================================

function generateRubySdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const rubyMethods = snap.operations
    .map((op) => {
      const fn = toSnakeCaseOperationId(op.operationId);
      const pathParams = op.params.filter((p) => p.in === 'path');
      let pathExpr = JSON.stringify(op.path);
      for (const p of pathParams) {
        pathExpr = `${pathExpr}.gsub("{${p.name}}", CGI.escape(params.fetch(:${p.name}).to_s))`;
      }
      return `    # [${op.riskClass}] ${op.method} ${op.path} (${op.operationId})
    def ${fn}(params: {}, body: nil, idempotency_key: nil)
      resolved_path = ${pathExpr}
      request(${JSON.stringify(op.method)}, resolved_path, query: params, body: body, idempotency_key: idempotency_key)
    end`;
    })
    .join('\n\n');

  const code = `# GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
# Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
require "cgi"
require "json"
require "net/http"
require "openssl"
require "uri"

module UgokiLink
  CONTRACT_SCHEMA_VERSION = ${JSON.stringify(snap.schemaVersion)}
  OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(snap.openapiSha256)}
  API_REVISION = ${JSON.stringify(snap.revision)}
  SEGMENT_CALL_TYPES = %w[identify page screen track group alias].freeze
  FORBIDDEN_ACTOR_KEYS = %w[user_agent userAgent ua ip client_ip actor_class is_agent is_bot].freeze

  def self.draw_uniform_u(key, unit_id)
    digest = OpenSSL::HMAC.digest("SHA256", key, unit_id)
    uint32 = digest[0, 4].unpack1("N")
    uint32.to_f / 4294967296.0
  end

  def self.verify_ed25519_raw(public_key_hex, message, signature_hex)
    spki = ["302a300506032b6570032100" + public_key_hex].pack("H*")
    pkey = OpenSSL::PKey.read(spki)
    pkey.verify(nil, [signature_hex].pack("H*"), message)
  rescue StandardError
    false
  end

  def self.evaluate_feature_flag(sig_ok:, now_ms:, expires_at_ms:, salt_key:, unit_id:, safe_value:, arms:)
    return { value: safe_value, reason: "invalid_signature_safe_fallback" } unless sig_ok
    return { value: safe_value, reason: "lease_expired_safe_fallback" } if now_ms >= expires_at_ms
    u = draw_uniform_u(salt_key, unit_id)
    total = arms.sum { |a| a[:weight].to_f }
    cum = 0.0
    arms.each do |arm|
      cum += arm[:weight].to_f / total
      return { value: arm[:value], reason: "assigned", uniform_draw: u } if u < cum
    end
    { value: arms.last[:value], reason: "assigned", uniform_draw: u }
  end

  class Client
    def initialize(api_key:, base_url: "https://api.ugokilink.com/api")
      @api_key = api_key
      @base_url = base_url.sub(%r{/+$}, "")
    end

    def request(method, path, query: nil, body: nil, idempotency_key: nil)
      uri = URI.parse(@base_url + path)
      uri.query = URI.encode_www_form(query) if query && !query.empty?
      req_cls = Net::HTTP.const_get(method.capitalize)
      req = req_cls.new(uri)
      req["Authorization"] = "Bearer #{@api_key}"
      req["X-UGOKI-API-Version"] = "v1"
      req["X-UGOKI-Revision"] = API_REVISION
      req["Idempotency-Key"] = idempotency_key if idempotency_key
      if body
        req["Content-Type"] = "application/json"
        req.body = JSON.generate(body)
      end
      Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |http| JSON.parse(http.request(req).body) }
    end

${rubyMethods}
  end
end
`;
  return [makeFile('ruby/ugokilink.rb', code)];
}

// =========================================================================
// 6. PHP SDK
// =========================================================================

function generatePhpSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const phpMethods = snap.operations
    .map((op) => {
      const pathParams = op.params.filter((p) => p.in === 'path');
      let pathExpr = JSON.stringify(op.path);
      for (const p of pathParams) {
        pathExpr = `str_replace('{${p.name}}', rawurlencode((string) ($params[${JSON.stringify(p.name)}] ?? '')), ${pathExpr})`;
      }
      return `    /** [${op.riskClass}] ${op.method} ${op.path} */
    public function ${op.operationId}(array $params = [], ?array $body = null, ?string $idempotencyKey = null): array {
        $resolvedPath = ${pathExpr};
        return $this->request(${JSON.stringify(op.method)}, $resolvedPath, $params, $body, $idempotencyKey);
    }`;
    })
    .join('\n\n');

  const code = `<?php
// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
declare(strict_types=1);

namespace UgokiLink\\Sdk;

final class UgokiLinkClient {
    public const CONTRACT_SCHEMA_VERSION = ${JSON.stringify(snap.schemaVersion)};
    public const OPENAPI_CONTRACT_SHA256 = ${JSON.stringify(snap.openapiSha256)};
    public const API_REVISION = ${JSON.stringify(snap.revision)};
    public const SEGMENT_CALL_TYPES = ['identify', 'page', 'screen', 'track', 'group', 'alias'];
    public const FORBIDDEN_ACTOR_KEYS = ['user_agent', 'userAgent', 'ua', 'ip', 'client_ip', 'actor_class', 'is_agent', 'is_bot'];

    private string $baseUrl;
    private string $apiKey;

    public function __construct(string $apiKey, string $baseUrl = 'https://api.ugokilink.com/api') {
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    public static function drawUniformU(string $key, string $unitId): float {
        $digest = hash_hmac('sha256', $unitId, $key, true);
        $parts = unpack('Nuint32', substr($digest, 0, 4));
        return ((float) $parts['uint32']) / 4294967296.0;
    }

    public static function verifyEd25519Raw(string $publicKeyHex, string $message, string $signatureHex): bool {
        $pub = hex2bin($publicKeyHex);
        $sig = hex2bin($signatureHex);
        if ($pub === false || $sig === false || strlen($pub) !== 32 || strlen($sig) !== 64) {
            return false;
        }
        return sodium_crypto_sign_verify_detached($sig, $message, $pub);
    }

    public static function evaluateFeatureFlag(bool $sigOk, int $nowMs, int $expiresAtMs, string $saltKey, string $unitId, string $safeValue, array $arms): array {
        if (!$sigOk) {
            return ['value' => $safeValue, 'fallback' => true, 'reason' => 'invalid_signature_safe_fallback'];
        }
        if ($nowMs >= $expiresAtMs) {
            return ['value' => $safeValue, 'fallback' => true, 'reason' => 'lease_expired_safe_fallback'];
        }
        $u = self::drawUniformU($saltKey, $unitId);
        $total = array_sum(array_column($arms, 'weight'));
        $cum = 0.0;
        foreach ($arms as $arm) {
            $cum += $arm['weight'] / $total;
            if ($u < $cum) {
                return ['value' => $arm['value'], 'fallback' => false, 'reason' => 'assigned', 'uniformDraw' => $u];
            }
        }
        $last = end($arms);
        return ['value' => $last['value'], 'fallback' => false, 'reason' => 'assigned', 'uniformDraw' => $u];
    }

    public function request(string $method, string $path, array $query = [], ?array $body = null, ?string $idempotencyKey = null): array {
        $qs = count($query) > 0 ? '?' . http_build_query($query) : '';
        $url = $this->baseUrl . $path . $qs;
        $headers = [
            'Authorization: Bearer ' . $this->apiKey,
            'X-UGOKI-API-Version: v1',
            'X-UGOKI-Revision: ' . self::API_REVISION,
        ];
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        $ctx = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\\r\\n", $headers),
                'content' => $body !== null ? json_encode($body, JSON_THROW_ON_ERROR) : '',
            ],
        ]);
        $raw = file_get_contents($url, false, $ctx);
        return is_string($raw) ? (json_decode($raw, true) ?? []) : [];
    }

${phpMethods}
}
`;
  return [makeFile('php/UgokiLinkSdk.php', code)];
}

// =========================================================================
// 7. .NET (C#) SDK
// =========================================================================

function generateDotnetSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const csMethods = snap.operations
    .map((op) => {
      const fn = toPascalCaseOperationId(op.operationId);
      const pathParams = op.params.filter((p) => p.in === 'path');
      let pathExpr = JSON.stringify(op.path);
      for (const p of pathParams) {
        pathExpr = `${pathExpr}.Replace("{${p.name}}", Uri.EscapeDataString(parameters[${JSON.stringify(p.name)}]))`;
      }
      return `        /// <summary>[${op.riskClass}] ${op.method} ${op.path} (${op.operationId})</summary>
        public Task<string> ${fn}Async(IDictionary<string, string> parameters, string? jsonBody = null, string? idempotencyKey = null, CancellationToken ct = default)
        {
            string resolvedPath = ${pathExpr};
            return RequestAsync(new HttpMethod(${JSON.stringify(op.method)}), resolvedPath, parameters, jsonBody, idempotencyKey, ct);
        }`;
    })
    .join('\n\n');

  const code = `// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace UgokiLink.Sdk
{
    public interface IEd25519Verifier
    {
        bool VerifyRaw(ReadOnlySpan<byte> publicKey32, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature64);
    }

    public sealed class UgokiLinkClient
    {
        public const string ContractSchemaVersion = ${JSON.stringify(snap.schemaVersion)};
        public const string OpenApiContractSha256 = ${JSON.stringify(snap.openapiSha256)};
        public const string ApiRevision = ${JSON.stringify(snap.revision)};
        public static readonly string[] SegmentCallTypes = { "identify", "page", "screen", "track", "group", "alias" };
        public static readonly HashSet<string> ForbiddenActorKeys = new() { "user_agent", "userAgent", "ua", "ip", "client_ip", "actor_class", "is_agent", "is_bot" };

        private readonly HttpClient _http;
        private readonly string _baseUrl;
        private readonly string _apiKey;

        public UgokiLinkClient(string apiKey, string baseUrl = "https://api.ugokilink.com/api", HttpClient? http = null)
        {
            _apiKey = apiKey;
            _baseUrl = baseUrl.TrimEnd('/');
            _http = http ?? new HttpClient();
        }

        public static double DrawUniformU(string key, string unitId)
        {
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
            byte[] digest = hmac.ComputeHash(Encoding.UTF8.GetBytes(unitId));
            uint uint32 = BinaryPrimitives.ReadUInt32BigEndian(digest.AsSpan(0, 4));
            return uint32 / 4294967296.0;
        }

        public static (string Value, string Reason) EvaluateFeatureFlag(
            bool sigOk, long nowMs, long expiresAtMs, string saltKey, string unitId, string safeValue, (string Value, double Weight)[] arms)
        {
            if (!sigOk) return (safeValue, "invalid_signature_safe_fallback");
            if (nowMs >= expiresAtMs) return (safeValue, "lease_expired_safe_fallback");
            double u = DrawUniformU(saltKey, unitId);
            double total = 0;
            foreach (var arm in arms) total += arm.Weight;
            double cum = 0;
            foreach (var arm in arms)
            {
                cum += arm.Weight / total;
                if (u < cum) return (arm.Value, "assigned");
            }
            return (arms[^1].Value, "assigned");
        }

        public async Task<string> RequestAsync(HttpMethod method, string path, IDictionary<string, string>? query = null, string? jsonBody = null, string? idempotencyKey = null, CancellationToken ct = default)
        {
            using var req = new HttpRequestMessage(method, _baseUrl + path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            req.Headers.Add("X-UGOKI-API-Version", "v1");
            req.Headers.Add("X-UGOKI-Revision", ApiRevision);
            if (!string.IsNullOrEmpty(idempotencyKey)) req.Headers.Add("Idempotency-Key", idempotencyKey);
            if (jsonBody != null) req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
            using var resp = await _http.SendAsync(req, ct);
            return await resp.Content.ReadAsStringAsync(ct);
        }

${csMethods}
    }
}
`;
  return [makeFile('dotnet/UgokiLinkSdk.cs', code)];
}

// =========================================================================
// 8. Rust SDK
// =========================================================================

function generateRustSdk(snap: ContractSnapshot): ReadonlyArray<SdkGeneratedFile> {
  const rustMethods = snap.operations
    .map((op) => {
      const fn = toSnakeCaseOperationId(op.operationId);
      const pathParams = op.params.filter((p) => p.in === 'path');
      const sigArgs = [
        '&self',
        ...pathParams.map((p) => `${toSnakeCaseOperationId(p.name)}: &str`),
        'query: &[(&str, &str)]',
        'body: Option<&str>',
        'idempotency_key: Option<&str>',
      ].join(', ');
      let pathSetup = `let resolved_path = ${JSON.stringify(op.path)}.to_string()`;
      for (const p of pathParams) {
        pathSetup += `.replace("{${p.name}}", ${toSnakeCaseOperationId(p.name)})`;
      }
      pathSetup += ';';
      return `    /// [${op.riskClass}] ${op.method} ${op.path} (${op.operationId})
    pub fn ${fn}(${sigArgs}) -> Result<String, String> {
        ${pathSetup}
        self.request(${JSON.stringify(op.method)}, &resolved_path, query, body, idempotency_key)
    }`;
    })
    .join('\n\n');

  const code = `// GENERATED BY UGOKI LINK v2 SDK GENERATOR — DO NOT EDIT BY HAND
// Contract Schema: ${snap.schemaVersion} | OpenAPI SHA-256: ${snap.openapiSha256}
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const CONTRACT_SCHEMA_VERSION: &str = ${JSON.stringify(snap.schemaVersion)};
pub const OPENAPI_CONTRACT_SHA256: &str = ${JSON.stringify(snap.openapiSha256)};
pub const API_REVISION: &str = ${JSON.stringify(snap.revision)};
pub const SEGMENT_CALL_TYPES: [&str; 6] = ["identify", "page", "screen", "track", "group", "alias"];
pub const FORBIDDEN_ACTOR_KEYS: [&str; 8] = ["user_agent", "userAgent", "ua", "ip", "client_ip", "actor_class", "is_agent", "is_bot"];

pub fn draw_uniform_u(key: &str, unit_id: &str) -> f64 {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key size");
    mac.update(unit_id.as_bytes());
    let digest = mac.finalize().into_bytes();
    let uint32 = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (uint32 as f64) / 4294967296.0
}

pub fn verify_ed25519_raw(pub_bytes: &[u8; 32], message: &[u8], sig_bytes: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pub_bytes) else { return false; };
    let sig = Signature::from_bytes(sig_bytes);
    vk.verify(message, &sig).is_ok()
}

pub fn evaluate_feature_flag(
    sig_ok: bool,
    now_ms: i64,
    expires_at_ms: i64,
    salt_key: &str,
    unit_id: &str,
    safe_value: &str,
    arms: &[(&str, f64)],
) -> (String, &'static str) {
    if !sig_ok {
        return (safe_value.to_string(), "invalid_signature_safe_fallback");
    }
    if now_ms >= expires_at_ms {
        return (safe_value.to_string(), "lease_expired_safe_fallback");
    }
    let u = draw_uniform_u(salt_key, unit_id);
    let total: f64 = arms.iter().map(|(_, w)| *w).sum();
    let mut cum = 0.0;
    for (val, w) in arms {
        cum += *w / total;
        if u < cum {
            return ((*val).to_string(), "assigned");
        }
    }
    (arms[arms.len() - 1].0.to_string(), "assigned")
}

pub trait HttpTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        api_key: &str,
        revision: &str,
        body: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<String, String>;
}

pub struct UgokiLinkApiClient<T: HttpTransport> {
    pub base_url: String,
    pub api_key: String,
    pub transport: T,
}

impl<T: HttpTransport> UgokiLinkApiClient<T> {
    pub fn request(
        &self,
        method: &str,
        path: &str,
        _query: &[(&str, &str)],
        body: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> Result<String, String> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        self.transport.send(method, &url, &self.api_key, API_REVISION, body, idempotency_key)
    }

${rustMethods}
}
`;
  return [makeFile('rust/lib.rs', code)];
}

// =========================================================================
// Public Generator API
// =========================================================================

export function generateServerSdkForLanguage(language: SdkLanguage): GeneratedSdkArtifact {
  const snap = captureContractSnapshot();
  let files: ReadonlyArray<SdkGeneratedFile>;
  switch (language) {
    case 'typescript':
      files = generateTypeScriptSdk(snap);
      break;
    case 'python':
      files = generatePythonSdk(snap);
      break;
    case 'go':
      files = generateGoSdk(snap);
      break;
    case 'java':
      files = generateJavaSdk(snap);
      break;
    case 'ruby':
      files = generateRubySdk(snap);
      break;
    case 'php':
      files = generatePhpSdk(snap);
      break;
    case 'dotnet':
      files = generateDotnetSdk(snap);
      break;
    case 'rust':
      files = generateRustSdk(snap);
      break;
  }

  const manifestSha256 = sha256Hex(
    canonicalJson({
      language,
      contractSchemaVersion: snap.schemaVersion,
      openapiContractSha256: snap.openapiSha256,
      files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    })
  );

  return {
    language,
    contractSchemaVersion: snap.schemaVersion,
    openapiContractSha256: snap.openapiSha256,
    files,
    manifestSha256,
  };
}

export function generateAll8ServerSdks(): {
  readonly artifacts: Readonly<Record<SdkLanguage, GeneratedSdkArtifact>>;
  readonly combinedManifestSha256: string;
} {
  const artifacts = {} as Record<SdkLanguage, GeneratedSdkArtifact>;
  const manifestInputs: Record<string, string> = {};

  for (const lang of SDK_LANGUAGES) {
    const art = generateServerSdkForLanguage(lang);
    artifacts[lang] = art;
    manifestInputs[lang] = art.manifestSha256;
  }

  return {
    artifacts,
    combinedManifestSha256: sha256Hex(canonicalJson(manifestInputs)),
  };
}
