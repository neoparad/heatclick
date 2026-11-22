import vm from 'node:vm';
import {
  generateEd25519KeyPair,
  sha256Hex,
  sha256Sri,
  signReleaseManifest,
  type LoaderDataPayload,
  type ReleaseManifestPayload,
  type SignedReleaseManifest,
} from '../../workers/link-signer';
import {
  EMPTY_FILE_SRI,
  SNIPPET_MAX_BYTES,
  generatePinnedSnippet,
  verifyEmptyFileIntegrity,
  verifySnippetBootSequence,
} from './index';

const BASE_NOW_MS = Date.parse('2026-11-20T00:00:00Z');
const MS_PER_DAY = 86_400_000;

interface MockScriptElement {
  async: boolean;
  crossOrigin: string;
  integrity: string;
  src: unknown;
}

async function runInlineSnippetInSandbox(params: {
  readonly snippetJs: string;
  readonly manifestResponse: SignedReleaseManifest;
  readonly loaderResponse: LoaderDataPayload;
}): Promise<{
  readonly appendedScripts: readonly MockScriptElement[];
  readonly win: Record<string, unknown>;
  readonly createdPolicyName: string | null;
  readonly createScriptURLFn: ((url: string) => unknown) | null;
}> {
  const appendedScripts: MockScriptElement[] = [];
  let createdPolicyName: string | null = null;
  let createScriptURLFn: ((url: string) => unknown) | null = null;

  const mockDoc = {
    createElement(tag: string): MockScriptElement {
      if (tag !== 'script') throw new Error(`Unexpected element ${tag}`);
      return { async: false, crossOrigin: '', integrity: '', src: '' };
    },
    head: {
      appendChild(el: MockScriptElement) {
        appendedScripts.push(el);
      },
    },
  };

  const mockWin: Record<string, unknown> = {
    crypto: globalThis.crypto,
    trustedTypes: {
      createPolicy(name: string, rules: { createScriptURL: (u: string) => unknown }) {
        createdPolicyName = name;
        createScriptURLFn = rules.createScriptURL;
        return {
          createScriptURL(u: string) {
            return rules.createScriptURL(u);
          },
        };
      },
    },
  };

  const mockFetch = async (url: string) => {
    if (url.endsWith('/release/manifest.json')) {
      return { json: async () => params.manifestResponse };
    }
    return { json: async () => params.loaderResponse };
  };

  const sandbox = {
    window: mockWin,
    document: mockDoc,
    fetch: mockFetch,
    atob: globalThis.atob,
    TextEncoder: globalThis.TextEncoder,
    URL: globalThis.URL,
    Uint8Array: globalThis.Uint8Array,
    Set: globalThis.Set,
    Promise: globalThis.Promise,
    Date: globalThis.Date,
    TypeError: globalThis.TypeError,
    JSON: globalThis.JSON,
    Object: globalThis.Object,
    Array: globalThis.Array,
  };

  vm.runInNewContext(params.snippetJs, sandbox);
  // Allow Promise + WebCrypto microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 40));

  return {
    appendedScripts,
    win: mockWin,
    createdPolicyName,
    createScriptURLFn,
  };
}

describe('Bundle 2-D.2: Static Pinned Snippet & Empty-File Integrity Reference', () => {
  it('generates <= 2 KB CSP-clean pinned snippet and SRI-locked empty census file tag', async () => {
    const offlineKp = await generateEd25519KeyPair();

    const gen1 = await generatePinnedSnippet({
      siteRef: 'wakegai_jp',
      offlinePubKeyJwk: offlineKp.publicKeyJwk,
      minManifestSeq: 5,
      cdnOrigin: 'https://cdn.ugokilink.example',
      pagePathKeyHash: '9a8b7c6d',
    });
    const gen2 = await generatePinnedSnippet({
      siteRef: 'wakegai_jp',
      offlinePubKeyJwk: offlineKp.publicKeyJwk,
      minManifestSeq: 5,
      cdnOrigin: 'https://cdn.ugokilink.example',
      pagePathKeyHash: '9a8b7c6d',
    });

    expect(gen1.snippetBytes).toBeLessThanOrEqual(SNIPPET_MAX_BYTES);
    expect(gen1.snippetSri).toBe(gen2.snippetSri);
    expect(gen1.snippetJs).not.toMatch(/\beval\b|innerHTML|document\.write|<style/i);
    expect(gen1.snippetJs).not.toContain('__ugkLoadSri');
    expect(gen1.snippetJs).not.toContain('__ugkVerifyAndBoot');
    expect(gen1.emptyFileTagHtml).toContain(`integrity="${EMPTY_FILE_SRI}"`);
    expect(gen1.emptyFileTagHtml).toContain('?p=9a8b7c6d');
    expect(gen1.cspDirectivesHint.trustedTypesPolicy).toBe('ugokilink-sdk');

    // Empty file SRI accepts 0-byte payload and rejects ANY non-empty tampered bytes
    expect(await verifyEmptyFileIntegrity(new Uint8Array(0))).toBe(true);
    expect(await verifyEmptyFileIntegrity(new TextEncoder().encode(' '))).toBe(false);
    expect(await verifyEmptyFileIntegrity(new TextEncoder().encode('alert(1)'))).toBe(false);
  });

  it('verifies offline signature + SRI hashes before booting, and blocks tampered/downgraded artifacts', async () => {
    const offlineKp = await generateEd25519KeyPair();
    const attackerKp = await generateEd25519KeyPair();

    const measureBytes = new TextEncoder().encode('window.__measure=1;');
    const segBytes = new TextEncoder().encode('window.__seg=1;');
    const deliverBytes = new TextEncoder().encode('window.__deliver=1;');
    const emptyBytes = new Uint8Array(0);

    const manifestPayload: ReleaseManifestPayload = {
      manifest_seq: 12,
      issued_at: new Date(BASE_NOW_MS).toISOString(),
      not_after: new Date(BASE_NOW_MS + 30 * MS_PER_DAY).toISOString(),
      resign_due_at: new Date(BASE_NOW_MS + 14 * MS_PER_DAY).toISOString(),
      abi: 2,
      min_config_seq: 1,
      artifacts: {
        measure_core: {
          url: 'https://cdn.ugokilink.example/m.js',
          sri: await sha256Sri(measureBytes),
          sha256: await sha256Hex(measureBytes),
          bytes_gzip: 1000,
        },
        segmenter: {
          url: 'https://cdn.ugokilink.example/s.js',
          sri: await sha256Sri(segBytes),
          sha256: await sha256Hex(segBytes),
          bytes_gzip: 500,
        },
        deliver_core: {
          url: 'https://cdn.ugokilink.example/d.js',
          sri: await sha256Sri(deliverBytes),
          sha256: await sha256Hex(deliverBytes),
          bytes_gzip: 800,
        },
        census_empty_file: {
          url: 'https://cdn.ugokilink.example/empty.v1.js',
          sri: EMPTY_FILE_SRI,
          sha256: await sha256Hex(emptyBytes),
        },
      },
      online_signing_keys: [],
      approver_passkey_pubkeys: [],
      affiliate_param_allowlist: [],
    };

    const signedManifest = await signReleaseManifest(
      manifestPayload,
      offlineKp.privateKey,
      'offline-k1'
    );

    const loaderData: LoaderDataPayload = {
      site_ref: 'wakegai_jp',
      region_class: 'JP',
      region_consent_cap: 'cookieless',
      kill_bits: 0,
      stop_deliver: false,
      coarsen_factor: 1,
      active_config_seq: 1,
      ctl_digest: 'ctl1',
      server_time_ms: BASE_NOW_MS + 1000,
    };

    // 1. Clean boot -> loads all 3 SRI-verified chunks
    const okBoot = await verifySnippetBootSequence({
      signedManifest,
      offlinePublicKey: offlineKp.publicKey,
      minManifestSeq: 12,
      nowMs: BASE_NOW_MS + 2 * MS_PER_DAY,
      loaderData,
      fetchedArtifacts: {
        measureCoreBytes: measureBytes,
        segmenterBytes: segBytes,
        deliverCoreBytes: deliverBytes,
        emptyFileBytes: emptyBytes,
      },
    });
    expect(okBoot.booted).toBe(true);
    expect(okBoot.mode).toBe('full');
    expect(okBoot.loadedArtifacts).toEqual(['measure_core', 'segmenter', 'deliver_core']);

    // 2. Tampered measure_core script bytes -> BLOCKED
    const tamperedMeasure = await verifySnippetBootSequence({
      signedManifest,
      offlinePublicKey: offlineKp.publicKey,
      minManifestSeq: 12,
      nowMs: BASE_NOW_MS + 2 * MS_PER_DAY,
      loaderData,
      fetchedArtifacts: {
        measureCoreBytes: new TextEncoder().encode('alert(document.cookie)'),
        segmenterBytes: segBytes,
        deliverCoreBytes: deliverBytes,
      },
    });
    expect(tamperedMeasure.booted).toBe(false);
    expect(tamperedMeasure.mode).toBe('blocked');

    // 3. Manifest signed by wrong/online attacker key -> BLOCKED
    const forgedManifest = await signReleaseManifest(
      manifestPayload,
      attackerKp.privateKey,
      'offline-k1'
    );
    const badSig = await verifySnippetBootSequence({
      signedManifest: forgedManifest,
      offlinePublicKey: offlineKp.publicKey,
      minManifestSeq: 12,
      nowMs: BASE_NOW_MS + 2 * MS_PER_DAY,
      loaderData,
      fetchedArtifacts: {
        measureCoreBytes: measureBytes,
        segmenterBytes: segBytes,
        deliverCoreBytes: deliverBytes,
      },
    });
    expect(badSig.booted).toBe(false);
    expect(badSig.mode).toBe('blocked');

    // 4. Expired manifest (>30d): deliver STOPS; cached measure continues stale, uncached drops to minimal_stub
    const expiredCached = await verifySnippetBootSequence({
      signedManifest,
      offlinePublicKey: offlineKp.publicKey,
      minManifestSeq: 12,
      nowMs: BASE_NOW_MS + 35 * MS_PER_DAY,
      loaderData,
      hasLastVerifiedMeasureCache: true,
      fetchedArtifacts: {
        measureCoreBytes: measureBytes,
        segmenterBytes: segBytes,
        deliverCoreBytes: deliverBytes,
      },
    });
    expect(expiredCached.booted).toBe(true);
    expect(expiredCached.mode).toBe('measure_only_stale');
    expect(expiredCached.loadedArtifacts).toEqual(['measure_core', 'segmenter']);

    const expiredUncached = await verifySnippetBootSequence({
      signedManifest,
      offlinePublicKey: offlineKp.publicKey,
      minManifestSeq: 12,
      nowMs: BASE_NOW_MS + 35 * MS_PER_DAY,
      loaderData,
      hasLastVerifiedMeasureCache: false,
      fetchedArtifacts: {
        measureCoreBytes: measureBytes,
        segmenterBytes: segBytes,
        deliverCoreBytes: deliverBytes,
      },
    });
    expect(expiredUncached.booted).toBe(true);
    expect(expiredUncached.mode).toBe('minimal_stub');
    expect(expiredUncached.loadedArtifacts).toEqual([]);
  });

  it('[C-06] executes self-contained WebCrypto Ed25519 verification inline (no __ugkVerifyAndBoot or __ugkLoadSri globals) and enforces strict Trusted Types allowlist', async () => {
    const offlineKp = await generateEd25519KeyPair();
    const attackerKp = await generateEd25519KeyPair();

    const measureSri = await sha256Sri(new TextEncoder().encode('m'));
    const segSri = await sha256Sri(new TextEncoder().encode('s'));
    const deliverSri = await sha256Sri(new TextEncoder().encode('d'));

    const manifestPayload: ReleaseManifestPayload = {
      manifest_seq: 10,
      issued_at: new Date(BASE_NOW_MS).toISOString(),
      not_after: new Date(BASE_NOW_MS + 30 * MS_PER_DAY).toISOString(),
      resign_due_at: new Date(BASE_NOW_MS + 14 * MS_PER_DAY).toISOString(),
      abi: 2,
      min_config_seq: 1,
      artifacts: {
        measure_core: {
          url: 'https://cdn.ugokilink.example/m.v10.js',
          sri: measureSri,
          sha256: 'a'.repeat(64),
          bytes_gzip: 900,
        },
        segmenter: {
          url: 'https://cdn.ugokilink.example/s.v10.js',
          sri: segSri,
          sha256: 'b'.repeat(64),
          bytes_gzip: 500,
        },
        deliver_core: {
          url: 'https://cdn.ugokilink.example/d.v10.js',
          sri: deliverSri,
          sha256: 'c'.repeat(64),
          bytes_gzip: 700,
        },
        census_empty_file: {
          url: 'https://cdn.ugokilink.example/empty.v1.js',
          sri: EMPTY_FILE_SRI,
          sha256: 'e'.repeat(64),
        },
      },
      online_signing_keys: [],
      approver_passkey_pubkeys: [],
      affiliate_param_allowlist: [],
    };

    const validManifest = await signReleaseManifest(manifestPayload, offlineKp.privateKey, 'k1');
    const forgedManifest = await signReleaseManifest(manifestPayload, attackerKp.privateKey, 'k1');

    const loaderData: LoaderDataPayload = {
      site_ref: 'wakegai_jp',
      region_class: 'JP',
      region_consent_cap: 'cookieless',
      kill_bits: 0,
      stop_deliver: false,
      coarsen_factor: 1,
      active_config_seq: 1,
      ctl_digest: 'ctl1',
      server_time_ms: BASE_NOW_MS + 1000,
    };

    const generated = await generatePinnedSnippet({
      siteRef: 'wakegai_jp',
      offlinePubKeyJwk: offlineKp.publicKeyJwk,
      minManifestSeq: 10,
      cdnOrigin: 'https://cdn.ugokilink.example',
    });

    expect(generated.snippetBytes).toBeLessThanOrEqual(SNIPPET_MAX_BYTES);

    // 1. Valid Ed25519 signature boots all 3 verified artifacts with exact SRI + anonymous CORS, zero global gadgets
    const okRun = await runInlineSnippetInSandbox({
      snippetJs: generated.snippetJs,
      manifestResponse: validManifest,
      loaderResponse: loaderData,
    });
    expect(okRun.win.__ugkLoadSri).toBeUndefined();
    expect(okRun.win.__ugkVerifyAndBoot).toBeUndefined();
    expect(okRun.createdPolicyName).toBe('ugokilink-sdk');
    expect(okRun.appendedScripts).toHaveLength(3);
    expect(okRun.appendedScripts.map((s) => s.src)).toEqual([
      'https://cdn.ugokilink.example/m.v10.js',
      'https://cdn.ugokilink.example/s.v10.js',
      'https://cdn.ugokilink.example/d.v10.js',
    ]);
    expect(okRun.appendedScripts.map((s) => s.integrity)).toEqual([measureSri, segSri, deliverSri]);
    expect(okRun.appendedScripts.every((s) => s.crossOrigin === 'anonymous' && s.async === true)).toBe(true);

    // Trusted Types `createScriptURL` allows exact verified manifest URL and throws TypeError on ANY other URL!
    expect(okRun.createScriptURLFn!('https://cdn.ugokilink.example/m.v10.js')).toBe(
      'https://cdn.ugokilink.example/m.v10.js'
    );
    expect(() => okRun.createScriptURLFn!('https://evil.example/m.v10.js')).toThrow();
    expect(() => okRun.createScriptURLFn!('http://cdn.ugokilink.example/m.v10.js')).toThrow();
    expect(() => okRun.createScriptURLFn!('https://cdn.ugokilink.example/unlisted.js')).toThrow();
    expect(() => okRun.createScriptURLFn!('https://cdn.ugokilink.example/m.v10.js?smuggle=1')).toThrow();
    expect(() => okRun.createScriptURLFn!('javascript:alert(1)')).toThrow();

    // 2. Forged Ed25519 signature -> 0 scripts appended AND allowlist stays empty!
    const forgedRun = await runInlineSnippetInSandbox({
      snippetJs: generated.snippetJs,
      manifestResponse: forgedManifest,
      loaderResponse: loaderData,
    });
    expect(forgedRun.appendedScripts).toHaveLength(0);
    expect(() => forgedRun.createScriptURLFn!('https://cdn.ugokilink.example/m.v10.js')).toThrow();

    // 3. Downgraded manifest_seq (< minManifestSeq) -> 0 scripts appended!
    const downgradedSnippet = await generatePinnedSnippet({
      siteRef: 'wakegai_jp',
      offlinePubKeyJwk: offlineKp.publicKeyJwk,
      minManifestSeq: 15, // manifest has seq=10 < 15
      cdnOrigin: 'https://cdn.ugokilink.example',
    });
    const downgradedRun = await runInlineSnippetInSandbox({
      snippetJs: downgradedSnippet.snippetJs,
      manifestResponse: validManifest,
      loaderResponse: loaderData,
    });
    expect(downgradedRun.appendedScripts).toHaveLength(0);
  });
});
