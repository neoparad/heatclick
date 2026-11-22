/**
 * UGOKI LINK v2 — Static Pinned Snippet & Empty-File Integrity Reference Generator/Verifier
 *
 * Implements §4.2, §10.1, §10.5, D-23, DEL M1 / App. H:
 * - Static snippet <= 2 KB (`del.snippet_max_kb`) holding ONLY the offline Ed25519
 *   release public key and anti-downgrade `minManifestSeq` floor.
 * - Verifies the offline-signed Release Manifest BEFORE loading measurement core,
 *   segmenter (shared chunk), and delivery core strictly by SRI content hash.
 * - Emits a separate empty-file `<script integrity="sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=">`
 *   reference so non-executing crawlers that fetch script assets become observable
 *   without introducing an online script execution path (§4.2).
 * - Zero `eval`, zero `innerHTML`, zero `<style>`, Trusted Types compatible (`ugokilink`).
 */

import {
  canonicalJson,
  sha256Sri,
  verifyReleaseManifest,
  type LoaderDataPayload,
  type ManifestVerificationResult,
  type PublicKeyJwkLike,
  type SignedReleaseManifest,
} from '../../workers/link-signer';

/** Exact SRI SHA-256 of an empty 0-byte file (`""`). */
export const EMPTY_FILE_SHA256_HEX =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as const;
export const EMPTY_FILE_SRI =
  'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' as const;

export const SNIPPET_MAX_BYTES = 2048 as const;

export interface PinnedSnippetConfig {
  readonly siteRef: string;
  readonly offlinePubKeyJwk: PublicKeyJwkLike;
  readonly minManifestSeq: number;
  readonly cdnOrigin: string;
  readonly manifestPath?: string;
  readonly loaderDataPath?: string;
  readonly emptyFilePath?: string;
  /** Optional server-injected path_key hash (`?p=...`) for page-level non-executing crawler census (§4.2). */
  readonly pagePathKeyHash?: string;
  readonly trustedTypesPolicyName?: string;
}

export interface GeneratedPinnedSnippet {
  readonly trustMode: 'pinned';
  readonly snippetJs: string;
  readonly snippetBytes: number;
  readonly snippetSri: string;
  readonly snippetTagHtml: string;
  readonly emptyFileTagHtml: string;
  readonly combinedHtml: string;
  readonly cspDirectivesHint: {
    readonly scriptSrcHash: string;
    readonly connectSrcOrigin: string;
    readonly trustedTypesPolicy: string;
  };
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function assertValidHttpsOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Pinned snippet cdnOrigin must use https:, got "${parsed.protocol}"`);
  }
}

/**
 * Deterministically generates the <= 2 KB static pinned snippet and the
 * SRI-locked empty-file reference for non-executing crawler observation.
 */
export async function generatePinnedSnippet(
  config: PinnedSnippetConfig
): Promise<GeneratedPinnedSnippet> {
  if (!config.siteRef || !/^[A-Za-z0-9_-]{3,64}$/.test(config.siteRef)) {
    throw new Error(`Invalid siteRef "${config.siteRef}"`);
  }
  if (!Number.isInteger(config.minManifestSeq) || config.minManifestSeq < 1) {
    throw new Error('minManifestSeq must be a positive integer');
  }
  assertValidHttpsOrigin(config.cdnOrigin);

  const origin = config.cdnOrigin.replace(/\/+$/, '');
  const manifestRelPath = config.manifestPath ?? '/release/manifest.json';
  const loaderRelPath = config.loaderDataPath ?? `/l/${config.siteRef}.json`;
  const emptyBase = `${origin}${config.emptyFilePath ?? '/static/empty.v1.js'}`;
  const emptyUrl = config.pagePathKeyHash
    ? `${emptyBase}?p=${encodeURIComponent(config.pagePathKeyHash)}`
    : emptyBase;
  const ttPolicy = config.trustedTypesPolicyName ?? 'ugokilink-sdk';

  // Compact, zero-eval, self-contained WebCrypto Ed25519 + strict Trusted Types bootstrap (<= 2 KB)
  const bootstrapConfig = canonicalJson({
    k: config.offlinePubKeyJwk.x ?? '',
    l: loaderRelPath,
    m: config.minManifestSeq,
    o: origin,
    s: config.siteRef,
    t: ttPolicy,
    u: manifestRelPath,
  });

  const snippetJs =
    `!function(w,d,c){` +
    `if(w.__ugkBoot)return;w.__ugkBoot=1;` +
    `var q=w.__ugkQ=[];w.ugk=w.ugk||function(){q.push(arguments)};` +
    `var al=new Set,` +
    `uOk=u=>{if(typeof u=="string"){var x=new URL(u);if(x.protocol=="https:"&&x.origin==c.o&&al.has(u))return u}throw new TypeError("ugk:url")},` +
    `p=w.trustedTypes?.createPolicy?w.trustedTypes.createPolicy(c.t,{createScriptURL:uOk}):null,` +
    `ld=(u,i)=>{var v=p?p.createScriptURL(u):uOk(u),s=d.createElement("script");s.async=!0;s.crossOrigin="anonymous";s.integrity=i;s.src=v;d.head.appendChild(s)},` +
    `b64=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),x=>x.charCodeAt(0)),` +
    `cj=v=>v===null||typeof v!="object"?JSON.stringify(v):Array.isArray(v)?"["+v.map(cj)+"]":"{"+Object.keys(v).filter(x=>v[x]!==void 0).sort().map(x=>JSON.stringify(x)+":"+cj(v[x]))+"}",` +
    `cs=w.crypto?.subtle;if(!cs)return;` +
    `var pk=b64(c.k);if(pk.length!=32)return;` +
    `var jf=u=>fetch(c.o+u,{credentials:"omit",cache:"no-cache"}).then(r=>r.json());` +
    `Promise.all([jf(c.u),jf(c.l),cs.importKey("raw",pk,{name:"Ed25519"},!1,["verify"])])` +
    `.then(([m,l,ky])=>{var mp=m?.payload,sg=m?.signature;if(!mp||sg?.alg!="Ed25519"||typeof sg.sig_b64!="string"||mp.manifest_seq<c.m)return;` +
    `var sb=b64(sg.sig_b64);if(sb.length!=64)return;` +
    `return cs.verify({name:"Ed25519"},ky,sb,(new TextEncoder).encode(cj(mp))).then(ok=>{if(!ok||(l?.server_time_ms||Date.now())>Date.parse(mp.not_after))return;` +
    `var ar=mp.artifacts||{},ks=[ar.measure_core,ar.segmenter];` +
    `if(!(l?.stop_deliver||l?.kill_bits&1)&&ar.deliver_core)ks.push(ar.deliver_core);` +
    `ks.forEach(it=>{if(typeof it?.url=="string"&&/^sha256-[A-Za-z0-9+/=]{43,44}$/.test(it.sri)){var x=new URL(it.url);if(x.protocol=="https:"&&x.origin==c.o){al.add(it.url);ld(it.url,it.sri)}}})})}).catch(()=>{})` +
    `}(window,document,${bootstrapConfig});`;

  const snippetBytes = new TextEncoder().encode(snippetJs).byteLength;
  if (snippetBytes > SNIPPET_MAX_BYTES) {
    throw new Error(
      `Generated pinned snippet exceeds ${SNIPPET_MAX_BYTES} byte budget (${snippetBytes} bytes)`
    );
  }

  const snippetSri = await sha256Sri(snippetJs);
  const snippetTagHtml = `<script>${snippetJs}</script>`;
  const emptyFileTagHtml =
    `<script src="${escapeHtmlAttr(emptyUrl)}" integrity="${EMPTY_FILE_SRI}" crossorigin="anonymous" async></script>`;

  return {
    trustMode: 'pinned',
    snippetJs,
    snippetBytes,
    snippetSri,
    snippetTagHtml,
    emptyFileTagHtml,
    combinedHtml: `${emptyFileTagHtml}\n${snippetTagHtml}`,
    cspDirectivesHint: {
      scriptSrcHash: `'${snippetSri}'`,
      connectSrcOrigin: origin,
      trustedTypesPolicy: ttPolicy,
    },
  };
}

/**
 * Verifies that the served empty census file matches EMPTY_FILE_SRI byte-for-byte.
 * Guarantees online actors cannot smuggle code into the non-executing crawler beacon file.
 */
export async function verifyEmptyFileIntegrity(bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength !== 0) {
    return false;
  }
  const actualSri = await sha256Sri(bytes);
  return actualSri === EMPTY_FILE_SRI;
}

export interface SnippetArtifactBytes {
  readonly measureCoreBytes: Uint8Array;
  readonly segmenterBytes: Uint8Array;
  readonly deliverCoreBytes?: Uint8Array;
  readonly emptyFileBytes?: Uint8Array;
}

export interface SnippetBootResult {
  readonly booted: boolean;
  readonly mode: 'full' | 'measure_only_stale' | 'minimal_stub' | 'blocked';
  readonly loadedArtifacts: readonly ('measure_core' | 'segmenter' | 'deliver_core')[];
  readonly manifestVerification: ManifestVerificationResult;
  readonly errors: readonly string[];
}

/**
 * Executable specification of the pinned snippet's boot-time verification chain:
 * 1. Verifies offline Ed25519 signature & anti-downgrade floor on `SignedReleaseManifest`.
 * 2. Verifies `loaderData` kill switches (`stop_deliver`).
 * 3. Computes SHA-256 SRI on EVERY fetched artifact and refuses execution on any mismatch!
 * 4. On expired manifest: blocks `deliver_core`, allows last-verified `measure_core`+`segmenter`
 *    if cached (flagged stale), otherwise drops to `minimal_stub`.
 */
export async function verifySnippetBootSequence(params: {
  readonly signedManifest: SignedReleaseManifest;
  readonly offlinePublicKey: CryptoKey;
  readonly minManifestSeq: number;
  readonly nowMs: number;
  readonly loaderData: LoaderDataPayload;
  readonly fetchedArtifacts: SnippetArtifactBytes;
  readonly hasLastVerifiedMeasureCache?: boolean;
}): Promise<SnippetBootResult> {
  const errors: string[] = [];

  const manifestVerification = await verifyReleaseManifest(
    params.signedManifest,
    params.offlinePublicKey,
    {
      nowMs: params.nowMs,
      minRememberedSeq: params.minManifestSeq,
      hasLastVerifiedMeasureCache: params.hasLastVerifiedMeasureCache,
    }
  );

  // Hard cryptographic or anti-downgrade failure -> block ALL script loading
  if (!manifestVerification.signatureValid || manifestVerification.downgraded) {
    return {
      booted: false,
      mode: 'blocked',
      loadedArtifacts: [],
      manifestVerification,
      errors: [...manifestVerification.errors],
    };
  }

  // Verify empty census file if provided
  if (params.fetchedArtifacts.emptyFileBytes !== undefined) {
    const emptyOk = await verifyEmptyFileIntegrity(params.fetchedArtifacts.emptyFileBytes);
    if (!emptyOk) {
      errors.push('Empty census file SRI mismatch (online tampering rejected)');
      return {
        booted: false,
        mode: 'blocked',
        loadedArtifacts: [],
        manifestVerification,
        errors,
      };
    }
  }

  // Verify SRI hashes of measure_core and segmenter against offline-signed manifest
  const { artifacts } = params.signedManifest.payload;
  const measureSri = await sha256Sri(params.fetchedArtifacts.measureCoreBytes);
  const segSri = await sha256Sri(params.fetchedArtifacts.segmenterBytes);

  if (measureSri !== artifacts.measure_core.sri) {
    errors.push(
      `measure_core SRI mismatch: expected ${artifacts.measure_core.sri}, got ${measureSri}`
    );
  }
  if (segSri !== artifacts.segmenter.sri) {
    errors.push(`segmenter SRI mismatch: expected ${artifacts.segmenter.sri}, got ${segSri}`);
  }

  if (errors.length > 0) {
    return {
      booted: false,
      mode: 'blocked',
      loadedArtifacts: [],
      manifestVerification,
      errors,
    };
  }

  // Manifest expired -> deliver ALWAYS stopped; measure continues only if cached, else minimal_stub (§4.2)
  if (manifestVerification.expired) {
    if (manifestVerification.measureAllowed) {
      return {
        booted: true,
        mode: 'measure_only_stale',
        loadedArtifacts: ['measure_core', 'segmenter'],
        manifestVerification,
        errors: manifestVerification.errors,
      };
    }
    return {
      booted: true,
      mode: 'minimal_stub',
      loadedArtifacts: [],
      manifestVerification,
      errors: manifestVerification.errors,
    };
  }

  // Online loaderData kill switch stops deliver cleanly without touching measurement
  if (params.loaderData.stop_deliver || (params.loaderData.kill_bits & 0x1) !== 0) {
    return {
      booted: true,
      mode: 'measure_only_stale',
      loadedArtifacts: ['measure_core', 'segmenter'],
      manifestVerification,
      errors: [],
    };
  }

  // Verify deliver_core SRI before loading delivery runtime
  const loaded: ('measure_core' | 'segmenter' | 'deliver_core')[] = ['measure_core', 'segmenter'];
  if (params.fetchedArtifacts.deliverCoreBytes) {
    const deliverSri = await sha256Sri(params.fetchedArtifacts.deliverCoreBytes);
    if (deliverSri !== artifacts.deliver_core.sri) {
      errors.push(
        `deliver_core SRI mismatch: expected ${artifacts.deliver_core.sri}, got ${deliverSri}`
      );
      return {
        booted: true,
        mode: 'measure_only_stale',
        loadedArtifacts: loaded,
        manifestVerification,
        errors,
      };
    }
    loaded.push('deliver_core');
  }

  return {
    booted: true,
    mode: 'full',
    loadedArtifacts: loaded,
    manifestVerification,
    errors: [],
  };
}
