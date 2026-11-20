import {
  generateEd25519KeyPair,
  sha256Hex,
  sha256Sri,
  signReleaseManifest,
  type LoaderDataPayload,
  type ReleaseManifestPayload,
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
    expect(gen1.emptyFileTagHtml).toContain(`integrity="${EMPTY_FILE_SRI}"`);
    expect(gen1.emptyFileTagHtml).toContain('?p=9a8b7c6d');
    expect(gen1.cspDirectivesHint.trustedTypesPolicy).toBe('ugokilink');

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
});
