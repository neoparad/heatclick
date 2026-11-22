/**
 * UGOKI LINK v2 — Wave 7-F Cross-Module E2E Integration & Repository-Wide Invariant Audit
 *
 * 1. End-to-end real-module pipeline integration:
 *    CANONICAL_SCHEMA (1-A)
 *      -> packages/sdk-browser (3-A)
 *      -> workers/link-collector (3-A/B/C)
 *      -> workers/link-wal (2-B)
 *      -> workers/link-loader (2-B)
 *      -> lib/link/surface (4-A)
 *      -> workers/link-decision (5-B)
 *      -> packages/sdk-runtime (5-B)
 *      -> lib/link/evidence (5-C)
 * 2. Repository-wide Wave 7-F exit invariants:
 *    - 0 skipped/focused/todo tests across ALL UGOKI LINK v2 test files
 *    - 0 `.env` filesystem reads in production source files
 *    - 0 runtime references to the superseded working proposal directory
 *    - Permanent Owner Decision D-31b lock + 0 Jev outputs / 0 Jev teachers in `lib/link/ml/finetune`
 *    - Every `app/api/v1/**\/route.ts` passes through canonical auth/response guards with 0 dummy fallbacks
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CANONICAL_SCHEMA,
  generateAllContractArtifacts,
  validateContractSchema,
} from '@/packages/contract/schema';
import { requireDecisionEntitled } from '@/packages/contract/ledgers';
import { validateSerializedEnvelope } from '@/packages/contract/response';
import { UgokiBrowserSdk, type CollectorAckPayload } from '@/packages/sdk-browser';
import {
  LinkCollectorEngine,
  type PersistedCollectorRecord,
  type QueueLike,
  type R2BucketLike as CollectorR2BucketLike,
  type SiteKeyRegistration,
} from '@/workers/link-collector';
import {
  InMemoryR2Bucket,
  WalWriter,
  type WalQueuePayload,
} from '@/workers/link-wal';
import { ShardLoader, replayAllFromWal } from '@/workers/link-loader';
import {
  ALL_SCOPES,
  IdentityKeyRegistry,
  generateEd25519KeyPair,
} from '@/lib/link/auth';
import {
  EmptyUnconnectedRepository,
  SurfacePipeline,
} from '@/lib/link/surface';
import {
  EdgeDecisionWorker,
  type StrongControlStore,
} from '@/workers/link-decision';
import {
  DELIVERY_CORE_MAX_GZIP_BYTES,
  applyClosedGrammarPatch,
  auditRuntimeSourceFile,
  rollbackClosedGrammarPatch,
  type RuntimeDomAdapter,
  type RuntimeDomElement,
} from '@/packages/sdk-runtime';
import {
  buildProvenVerdictEnvelope,
  evaluateProvenVerdict,
  lockPreregistration,
} from '@/lib/link/evidence';
import {
  JevTeacherProhibitedError,
  JevTrainingProhibitedError,
  distillInHouseModelToInt8Classifier,
  verifyTrainingDatasetProvenance,
} from '@/lib/link/ml/finetune';

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkFiles(dirPath: string, out: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return out;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function stripJsTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function getUgokiLinkV2Roots(): string[] {
  const roots: string[] = [
    path.join(REPO_ROOT, 'packages/contract'),
    path.join(REPO_ROOT, 'packages/wp-plugin'),
    path.join(REPO_ROOT, 'lib/link'),
    path.join(REPO_ROOT, 'app/api/v1'),
  ];

  const packagesDir = path.join(REPO_ROOT, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('sdk-')) {
        roots.push(path.join(packagesDir, entry.name));
      }
    }
  }

  const workersDir = path.join(REPO_ROOT, 'workers');
  if (fs.existsSync(workersDir)) {
    for (const entry of fs.readdirSync(workersDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('link-')) {
        roots.push(path.join(workersDir, entry.name));
      }
    }
  }

  return roots;
}

describe('UGOKI LINK v2 — Wave 7-F Cross-Module E2E Pipeline & Repository Invariant Audit', () => {
  test('E2E pipeline: CANONICAL_SCHEMA -> sdk-browser -> link-collector -> link-wal -> link-loader -> surface -> link-decision -> sdk-runtime -> evidence', async () => {
    const baseWallMs = Date.parse('2026-11-20T09:00:00.000Z');
    const nowDate = new Date(baseWallMs);

    // -----------------------------------------------------------------------
    // Stage 1: Single-Schema Contract (1-A)
    // -----------------------------------------------------------------------
    const schemaCheck = validateContractSchema(CANONICAL_SCHEMA);
    expect(schemaCheck.valid).toBe(true);
    expect(schemaCheck.violations).toEqual([]);

    const genA = generateAllContractArtifacts(CANONICAL_SCHEMA);
    const genB = generateAllContractArtifacts(CANONICAL_SCHEMA);
    expect(genA.manifestSha256).toBe(genB.manifestSha256);

    // -----------------------------------------------------------------------
    // Stage 2 & 3: Browser SDK (3-A) -> Collector Worker (3-A/B/C)
    // -----------------------------------------------------------------------
    const enqueuedRecords: PersistedCollectorRecord[] = [];
    const mainQueue: QueueLike<PersistedCollectorRecord> = {
      async send(msg) {
        enqueuedRecords.push(msg);
      },
    };
    const noopCollectorBucket: CollectorR2BucketLike = {
      async put() {
        return;
      },
    };

    const siteReg: SiteKeyRegistration = {
      publishableKey: 'ugk_pub_live_e2e_site1',
      tenantId: 'ten_e2e_1',
      siteId: 'site_e2e_1',
      edgeHandoffMacKey: 'edge_handoff_e2e_secret',
      originAttestKey: 'origin_attest_e2e_secret',
      tenantMemberHashKey: 'member_hash_e2e_secret',
      baseline28dHourVolume: 100,
      surgeMultiplier: 3,
      prefixDailyCap: 500,
    };

    const collector = new LinkCollectorEngine({
      sitesByPublishableKey: new Map([[siteReg.publishableKey, siteReg]]),
      continuityTokenSecret: 'continuity_e2e_secret',
      labMarkerSecret: 'lab_marker_e2e_secret',
      mainQueue,
      r2SpillBucket: noopCollectorBucket,
      r2HoldBucket: noopCollectorBucket,
      r2QuarantineBucket: noopCollectorBucket,
      nowMs: () => baseWallMs,
    });

    let monoMs = 500;
    const ackedSeqs: number[] = [];
    const sdk = new UgokiBrowserSdk({
      siteKey: siteReg.publishableKey,
      collectorEndpoint: 'https://collect.ugokilink.invalid/v1/collect/events',
      sdkBuild: 'v3.0.0',
      defVer: 1,
      profileRev: 1,
      armBits: 0b001,
      dimTupleCode: 10,
      initialUrl: 'https://example.jp/articles/guide?utm_source=organic',
      skelFp: 'aabbccddeeff',
      consent: {
        siteDefaultMode: 'full',
        originRegionClass: 'JP',
        disclosureStatus: 'verified',
      },
      nowMonoMs: () => monoMs,
      nowWallMs: () => baseWallMs + monoMs,
      transport: {
        sendFetch: async (_ep, bytes): Promise<CollectorAckPayload> => {
          const res = await collector.handleTelemetryFrame({
            publishableKey: siteReg.publishableKey,
            body: bytes,
            networkPrefix: '203.0.113.0/24',
          });
          expect(res.status).toBe(200);
          expect(res.ack?.accepted_saved).toBe(true);
          ackedSeqs.push(res.ack!.seq);
          return {
            seq: res.ack!.seq,
            i_hw: res.ack!.i_hw,
            srv_t: res.ack!.srv_t,
            pv_token: res.ack!.pv_token ?? undefined,
          };
        },
        sendBeacon: (_ep, bytes) => {
          void collector.handleTelemetryFrame({
            publishableKey: siteReg.publishableKey,
            body: bytes,
            networkPrefix: '203.0.113.0/24',
          });
          return true;
        },
      },
    });

    await sdk.init();
    monoMs = 2_800;
    sdk.advance({
      scrollY: 720,
      sections: [{ sec_fp: '112233445566', topPx: 100, bottomPx: 1200 }],
      blocks: [{ blk_fp: 'blk_hero_cta', alwaysWatch: true, inViewport: true }],
      isInputTick: true,
    });
    monoMs = 4_200;
    await sdk.flush('change');

    expect(ackedSeqs.length).toBeGreaterThanOrEqual(2);
    expect(enqueuedRecords.length).toBeGreaterThanOrEqual(2);
    const pvId = enqueuedRecords[0].pv_id;
    const urlId = enqueuedRecords[0].url_id;
    expect(enqueuedRecords.every((r) => r.tenant_id === 'ten_e2e_1' && r.site_id === 'site_e2e_1')).toBe(
      true
    );

    // -----------------------------------------------------------------------
    // Stage 4: Write-Ahead Log Worker (2-B) — Direct zero-adapter queue wire [C-05]
    // -----------------------------------------------------------------------
    const walBucket = new InMemoryR2Bucket();
    const walWriter = new WalWriter({ region: 'jp', bucket: walBucket });
    const directShardId = enqueuedRecords[0].shard_id;
    expect(Number.isInteger(directShardId)).toBe(true);
    expect(enqueuedRecords.every((rec) => rec.shard_id === directShardId)).toBe(true);

    // Pass PersistedCollectorRecord[] directly as-is without any manual adapter!
    const walPayloads: WalQueuePayload[] = enqueuedRecords;

    const walRes = await walWriter.consumeBatch(walPayloads, baseWallMs + 5_000);
    expect(walRes.acceptedCount).toBe(enqueuedRecords.length);
    expect(walRes.quarantinedCount).toBe(0);
    expect(walRes.walKeys.length).toBeGreaterThanOrEqual(1);
    const shardPad = String(directShardId).padStart(4, '0');
    expect(walRes.walKeys[0]).toMatch(new RegExp(`^wal\\/jp\\/${shardPad}\\/ten_e2e_1\\/site_e2e_1\\/`));

    // -----------------------------------------------------------------------
    // Stage 5: Single-Writer Shard Loader & R2 WAL Replay Parity (2-B)
    // -----------------------------------------------------------------------
    const loader = new ShardLoader({ region: 'jp', shardId: directShardId, bucket: walBucket });
    const loadRes = await loader.loadPendingWalObjects(baseWallMs + 6_000);
    expect(loadRes.committed).toBe(true);
    expect(loadRes.doublePlacementCount).toBe(0);
    expect(loadRes.newlyPlacedPvs).toBe(1);

    const pvState = loader.getPvState('ten_e2e_1', 'site_e2e_1', pvId);
    expect(pvState).toBeDefined();
    expect(pvState!.scrollMaxPx).toBeGreaterThanOrEqual(720);
    expect(pvState!.placement.urlId).toBe(urlId);

    const replayRes = await replayAllFromWal({
      region: 'jp',
      shardId: directShardId,
      walBucket,
      nowMs: baseWallMs + 7_000,
    });
    expect(replayRes.doublePlacementCount).toBe(0);
    expect(replayRes.controlTotals).toEqual(loader.getControlTotals());

    // -----------------------------------------------------------------------
    // Stage 6: Unified Surface Pipeline (4-A) + Cross-Tenant 404 Isolation
    // -----------------------------------------------------------------------
    const keyRegistry = new IdentityKeyRegistry({
      pepperVersion: 'e2e_v1',
      pepperSecret: 'e2e_test_pepper_secret',
    });
    const nowIso = nowDate.toISOString();
    keyRegistry.registerOrg({
      orgId: 'org_e2e',
      type: 'direct',
      name: 'E2E Org',
      createdAt: nowIso,
    });
    keyRegistry.registerTenant({
      tenantId: 'ten_e2e_1',
      orgId: 'org_e2e',
      name: 'Tenant 1',
      planScopes: [...ALL_SCOPES],
      delegationPolicy: { allowOemAccess: false, allowedOemScopes: [], maxExchangedTokenTtlSec: 0 },
      revocationEpoch: 1,
      createdAt: nowIso,
    });
    keyRegistry.registerTenant({
      tenantId: 'ten_e2e_other',
      orgId: 'org_e2e',
      name: 'Other Tenant',
      planScopes: [...ALL_SCOPES],
      delegationPolicy: { allowOemAccess: false, allowedOemScopes: [], maxExchangedTokenTtlSec: 0 },
      revocationEpoch: 1,
      createdAt: nowIso,
    });
    keyRegistry.registerSite({
      siteId: 'site_e2e_1',
      tenantId: 'ten_e2e_1',
      siteRef: 'ref_e2e_1',
      env: 'live',
      hostnames: ['example.jp'],
      allowedOrigins: ['https://example.jp'],
      createdAt: nowIso,
    });
    keyRegistry.registerSite({
      siteId: 'site_e2e_other',
      tenantId: 'ten_e2e_other',
      siteRef: 'ref_e2e_other',
      env: 'live',
      hostnames: ['other.jp'],
      allowedOrigins: ['https://other.jp'],
      createdAt: nowIso,
    });
    keyRegistry.registerPrincipal({
      principalId: 'svc_e2e_1',
      tenantId: 'ten_e2e_1',
      orgId: 'org_e2e',
      kind: 'service',
      role: 'admin',
      passkeyEnrolled: false,
    });

    const repo = new EmptyUnconnectedRepository();
    repo.registerSiteConfig({
      siteId: 'site_e2e_1',
      tenantId: 'ten_e2e_1',
      siteName: 'Example JP',
      consentMode: 'full',
      storageRegion: 'asia-northeast1',
      processingRegion: 'asia-northeast1',
      monthlyQuotaPvs: 500_000,
    });
    repo.registerSiteConfig({
      siteId: 'site_e2e_other',
      tenantId: 'ten_e2e_other',
      siteName: 'Other JP',
      consentMode: 'full',
      storageRegion: 'asia-northeast1',
      processingRegion: 'asia-northeast1',
      monthlyQuotaPvs: 500_000,
    });

    const issuedKey = keyRegistry.issueSecretKey({
      tenantId: 'ten_e2e_1',
      principalId: 'svc_e2e_1',
      env: 'live',
      scopes: ['analytics:read', 'decisions:read'],
      now: nowDate,
    });

    const pipeline = new SurfacePipeline({ keyRegistry, repository: repo });

    const ownRes = pipeline.execute({
      operationId: 'querySiteMetrics',
      channel: 'rest',
      bearerToken: issuedKey.rawKey,
      siteId: 'site_e2e_1',
      now: nowDate,
    });
    expect(ownRes.httpStatus).toBe(200);
    expect(ownRes.envelope).toBeDefined();
    expect(validateSerializedEnvelope(ownRes.envelope!).valid).toBe(true);

    // Cross-tenant access MUST return 404 (never 403!)
    const foreignRes = pipeline.execute({
      operationId: 'querySiteMetrics',
      channel: 'rest',
      bearerToken: issuedKey.rawKey,
      siteId: 'site_e2e_other',
      now: nowDate,
    });
    expect(foreignRes.httpStatus).toBe(404);

    // -----------------------------------------------------------------------
    // Stage 7: Edge Decision Worker (5-B) -> Closed-Grammar Runtime (5-B)
    // -----------------------------------------------------------------------
    const decisionPair = generateEd25519KeyPair('e2e_dec_k1');
    const strongStore: StrongControlStore = {
      backendName: 'durable_object_e2e_strong',
      consistency: 'durable_object_strong',
      readTenantControl: (tenantId, siteId) => ({
        reachable: true,
        readLatencyMs: 6,
        record: {
          tenantId,
          siteId,
          configVersion: 'cfg_e2e_v1',
          configExpiresAtMs: baseWallMs + 3_600_000,
          minAcceptedConfigVersion: 'cfg_e2e_v1',
          killedCampaignIds: [],
          killStampVersion: 1,
          siteKilled: false,
          allocatorConfig: {
            hmacSecret: 'alloc_e2e_secret',
            holdout: {
              global: 0.05,
              overlay: 0.05,
              patch: 0.05,
              recs: 0.05,
              epochWeeks: 26,
              epochOriginMs: baseWallMs - 86_400_000,
            },
            measurement: {
              stage: 'stage_c_steady',
              fullSplitMode: 'half_verify_half_deliver',
              steadyStubShare: 0.05,
              steadyAuditShare: 0.13,
            },
            layers: [],
          },
        },
      }),
    };

    const decisionWorker = new EdgeDecisionWorker({
      controlStore: strongStore,
      signingPrivateKeyPem: decisionPair.privateKeyPem,
      signingPublicKeyPem: decisionPair.publicKeyPem,
    });

    const decision = decisionWorker.decide({
      tenantId: 'ten_e2e_1',
      siteId: 'site_e2e_1',
      pvId,
      consentMode: 'full',
      purposes: ['experiment'],
      identityQuality: 'A',
      trafficClass: 'public',
      urlId,
      pageId: 'page_guide_1',
      viewportClass: 'mobile',
      pointerType: 'coarse',
      nowMs: baseWallMs,
    });
    expect(decision.status).toBe('ok');
    expect(decision.displayLease).not.toBeNull();
    expect(decision.voucherToken).toMatch(/^vch_/);

    const domElements: RuntimeDomElement[] = [
      {
        matchKey: 'sec_hero_cta',
        textContent: 'Read Guide',
        hidden: false,
        attributes: {},
        styles: {},
      },
    ];
    const domAdapter: RuntimeDomAdapter = {
      findByMatchKey: (k) => domElements.filter((e) => e.matchKey === k),
      getHistoryLength: () => 1,
    };

    const patchRes = applyClosedGrammarPatch(domAdapter, [
      { opId: 'op_e2e_1', kind: 'replace_text', targetMatchKey: 'sec_hero_cta', text: 'Start Free Guide' },
    ]);
    expect(patchRes.applied).toBe(true);
    expect(domElements[0].textContent).toBe('Start Free Guide');
    expect(rollbackClosedGrammarPatch(domAdapter, patchRes.inverseOps)).toBe(1);
    expect(domElements[0].textContent).toBe('Read Guide');

    const runtimeAudit = auditRuntimeSourceFile(
      path.join(REPO_ROOT, 'packages/sdk-runtime/interpreter.ts')
    );
    expect(runtimeAudit.passed).toBe(true);
    expect(runtimeAudit.gzipBytes).toBeLessThanOrEqual(DELIVERY_CORE_MAX_GZIP_BYTES);

    // -----------------------------------------------------------------------
    // Stage 8: Evidence Engine & `proven` Verdict Envelope (5-C)
    // -----------------------------------------------------------------------
    const prereg = lockPreregistration(
      {
        experimentId: 'exp_e2e_hero_cta',
        siteId: 'site_e2e_1',
        tenantId: 'ten_e2e_1',
        registerKind: 'human_approved',
        hypothesis: 'Clearer CTA wording lifts outbound click rate',
        primaryMetric: 'outbound_click_rate',
        secondaryMetrics: ['focal_dwell_ms'],
        guardrailMetrics: ['cls_p95', 'inp_bad_share'],
        plannedNPerArm: 5000,
        alpha: 0.05,
        targetMdeRelative: 0.15,
        cupedTheta: 0.35,
        cupedCovariateName: 'prior_28d_clicks',
        firstAllocationAtIso: null,
      },
      nowDate
    );
    expect(prereg.locked).toBe(true);

    const verdictInput = {
      experimentId: prereg.experimentId,
      interventionRefId: 'intv_e2e_1',
      predicate: 'visitor_randomised' as const,
      collectionGen: 'v3' as const,
      allocatorLoggedBeforeOutcomes: true,
      preregLocked: prereg.locked,
      integrityStatus: 'pass' as const,
      decisionRulePassed: true,
      robustnessPassed: true,
      platformCanaryPassed: true,
      durationDays: 21,
      randomisationAuditP: 0.0004,
      alpha: 0.05,
      rawLogRr: 0.21,
      rawSeLogRr: 0.032,
      targetMdeLogRr: 0.14,
      detectableMdeAtCurrentN: 0.075,
      plannedNReached: true,
      holdbackConfirmed: false,
      guardrailsVerified: true,
      claimAgeDays: 7,
      bodyFingerprintChanged: false,
      expectedMonthlyBaselineUnits: 1200,
      sampleN: 10_500,
      now: nowDate,
    };

    const verdict = evaluateProvenVerdict(verdictInput);
    expect(verdict.evidenceLevel).toBe('proven');
    expect(verdict.verdict).toBe('superior');

    const verdictEnvelope = buildProvenVerdictEnvelope({
      input: verdictInput,
      verdict,
      windowStart: '2026-10-30T00:00:00.000Z',
      windowEnd: nowIso,
      now: nowDate,
    });
    expect(validateSerializedEnvelope(verdictEnvelope).valid).toBe(true);
  });

  test('Wave 7-F Gate: ZERO skipped/focused/todo tests across all UGOKI LINK v2 test suites', () => {
    const roots = getUgokiLinkV2Roots();
    const testFiles = roots
      .flatMap((r) => walkFiles(r))
      .filter((f) => f.endsWith('.test.ts'));

    expect(testFiles.length).toBeGreaterThanOrEqual(10);

    const violations: Array<{ file: string; matches: string[] }> = [];
    const forbiddenTestPattern =
      /\b(?:(?:it|test|describe)\.(?:skip|only|todo)|xit|xtest|xdescribe)\s*\(/g;

    for (const file of testFiles) {
      const code = stripJsTsComments(fs.readFileSync(file, 'utf8'));
      const matches = code.match(forbiddenTestPattern);
      if (matches && matches.length > 0) {
        violations.push({
          file: path.relative(REPO_ROOT, file),
          matches,
        });
      }
    }

    expect(violations).toEqual([]);
  });

  test('Wave 7-F Gate: ZERO `.env` file reads and ZERO runtime references to superseded working proposal dir', () => {
    const roots = getUgokiLinkV2Roots();
    const allFiles = roots
      .flatMap((r) => walkFiles(r))
      .filter((f) => /\.(?:ts|tsx|js|php)$/.test(f));

    const prodFiles = allFiles.filter((f) => !f.endsWith('.test.ts'));
    expect(prodFiles.length).toBeGreaterThanOrEqual(50);

    const envReadViolations: string[] = [];
    const workingDirViolations: string[] = [];

    const envReadRe =
      /(?:readFile|readFileSync|createReadStream|openSync)\s*\([^)\n]*['"`][^'"`\n]*\.env(?:\.[a-z]+)?['"`]/i;
    const forbiddenWorkingRef = 'docs/proposals/2026-11-19-ugokilink-v2-working';

    for (const file of prodFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      const code = stripJsTsComments(raw);
      if (envReadRe.test(code)) {
        envReadViolations.push(path.relative(REPO_ROOT, file));
      }
    }

    for (const file of allFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.includes(forbiddenWorkingRef)) {
        workingDirViolations.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(envReadViolations).toEqual([]);
    expect(workingDirViolations).toEqual([]);
  });

  test('Cross-ledger D-31b permanent lock + `lib/link/ml/finetune` strictly enforces 0 Jev outputs & 0 Jev teachers', () => {
    // 1. Canonical Decisions Ledger permanently prohibits D-31b
    const d31b = requireDecisionEntitled('D-31b');
    expect(d31b.entitled).toBe(false);
    expect(d31b.status).toBe('not_entitled');
    if (!d31b.entitled) {
      expect(d31b.reason).toBe('prohibited_by_decision');
    }

    // 2. Dataset provenance gate throws JevTrainingProhibitedError on ANY Jev example
    expect(() =>
      verifyTrainingDatasetProvenance({
        scope: 'shared_adapter',
        taskKind: 'section_reading',
        examples: [
          {
            example_id: 'ex_jev_forbidden_1',
            tenant_id: 'ten_own',
            owner_group_id: 'owner_own',
            ownership: 'own_site',
            source: 'jev_output',
            lane: 'standard',
            page_lineage_id: 'lin_1',
            public_text: 'Sample public heading and intro paragraph.',
            label: 'hero_intro',
            sample_weight: 1,
          },
        ],
      })
    ).toThrow(JevTrainingProhibitedError);

    // 3. Distillation gate throws JevTeacherProhibitedError if Jev is passed as teacher
    expect(() =>
      distillInHouseModelToInt8Classifier({
        teacher: {
          teacher_id: 'jev_teacher_v1',
          origin: 'jev_external_service',
          derived_from_jev: true,
          base_model_license_id: 'proprietary',
          base_model_notice_text: 'forbidden',
        },
        payload: {
          abi_version: 1,
          model_id: 'clf_bad',
          version: '1.0.0',
          feature_ids: ['f0'],
          base_logit_q8: 0,
          trees: [[{ feature_idx: -1, threshold_int: 0, left_idx: -1, right_idx: -1, leaf_logit_q8: 16 }]],
          license_id: 'Apache-2.0',
          license_notice: 'Apache 2.0 Notice',
        },
        human_eval: {
          human_eval_sample_count: 400,
          human_macro_f1: 0.88,
          min_required_macro_f1: 0.8,
        },
      })
    ).toThrow(JevTeacherProhibitedError);
  });

  test('Static audit: EVERY `app/api/v1/**/route.ts` passes through canonical auth/response guards with ZERO dummy data fallbacks', () => {
    const v1Root = path.join(REPO_ROOT, 'app/api/v1');
    const routeFiles = walkFiles(v1Root).filter((f) => path.basename(f) === 'route.ts');

    expect(routeFiles.length).toBeGreaterThanOrEqual(20);

    const canonicalGuardPattern =
      /\b(?:handleV1RestRoute|handleMcpPostRoute|getSurfaceRuntimeContext|executeRecommendRequest|buildResponseEnvelope|extractBearerToken|AuthorizationGateway|HeatmapRenderService)\b/;
    const forbiddenDummyPattern =
      /\b(?:MOCK_[A-Z0-9_]+|DUMMY_[A-Z0-9_]+|FAKE_[A-Z0-9_]+|fallbackMock|getMockData)\b|Math\.random\s*\(/;
    const forbiddenSpoofHeaderPattern =
      /headers\.get\s*\(\s*['"]x-ugk-(?:principal-id|tenant-id|scopes|audience|allowed-sites|revocation-epoch)['"]\s*\)/i;

    const missingGuard: string[] = [];
    const dummyFallbackHits: string[] = [];
    const spoofHeaderHits: string[] = [];

    for (const file of routeFiles) {
      const code = stripJsTsComments(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(REPO_ROOT, file);
      if (!canonicalGuardPattern.test(code)) {
        missingGuard.push(rel);
      }
      if (forbiddenDummyPattern.test(code)) {
        dummyFallbackHits.push(rel);
      }
      if (forbiddenSpoofHeaderPattern.test(code)) {
        spoofHeaderHits.push(rel);
      }
    }

    expect(missingGuard).toEqual([]);
    expect(dummyFallbackHits).toEqual([]);
    expect(spoofHeaderHits).toEqual([]);
  });
});
