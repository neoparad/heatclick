import {
  CANONICAL_SCHEMA,
  CODEC_VERSION,
  CONSENT_MODES,
  ContractInvariantError,
  computeFrameChecksum,
  createIngestValidator,
  createSdkFrameCodec,
  generateAllContractArtifacts,
  generateClickHouseDdl,
  generateDeletionPlan,
  generatePostgresDdl,
  generatePrivacyDisclosure,
  generateTypeScriptApiTypes,
  maskUrlParams,
  validateContractSchema,
  verifyDeletionPlanCoverage,
  type ContractSchema,
  type StringSlotId,
  type TelemetryFrame,
} from './index';

function buildValidFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  const base: Omit<TelemetryFrame, 'chk'> = {
    codec_ver: CODEC_VERSION,
    schema_ver: CANONICAL_SCHEMA.meta.wireVersion,
    sdk_build: 'a1b2c3d4e5f60708',
    pv_id: '0123456789abcdef0123456789abcdef',
    seq: 3,
    cont_of: null,
    frame_class: 'change',
    transport: 'fetch',
    full: false,
    vis_episode: 1,
    t_mono: 12400,
    t_wall: 1795089600000,
    ack_echo_seq: 2,
    pv_token: 'pvt_signed_example_token',
    consent_mode: 'cookieless',
    purposes: ['experiment', 'automation_detection'],
    arm_bits: 0b0010,
    def_ver: 1,
    url_id: '9876543210123456',
    key_ver: 2,
    profile_rev: 14,
    dim_tuple_code: 412,
    live_word: 0x00030401,
    key_degraded: false,
    handoff_token: null,
    visitor_id: null,
    session_id: null,
    member_hash: null,
    lab_run_id: null,
    state: {
      page_url_key: 'wakegai.jp/ranking/facial-wash',
      external_referrer_key: 'www.google.com/',
      campaign_param: 'utm_source=organic',
      nav_type: 'navigate',
      started_hidden: false,
      scroll_max_px: 2400,
      doc_h_first: 5200,
      doc_h_max: 5400,
      doc_h_last: { value: 5400, seq: 3 },
      vis_ms: 11800,
      reversals: 2,
      js_error_n: 0,
      degrade_level: 0,
      dom_state: 'ok',
      skel_fp: '1122334455667788',
      css_fp: '8877665544332211',
      head_fp: 'aabbccddeeff0011',
      variant_key: '000000000000',
      sample_pi: 1.0,
    },
    sections: [
      {
        sec_fp: 'aabbcc112233',
        vis_ms: 6200,
        t_first_ms: 800,
        entries: 1,
        max_frac_permille: 950,
      },
    ],
    blocks: [
      {
        blk_fp: '1122334455',
        vis_ms: 4100,
        copy_n: 0,
      },
    ],
    fields: [
      {
        el_fp: 'ffeeddccbbaa',
        focus_ms: 1200,
        invalid_n: 0,
      },
    ],
    forms: [
      {
        form_fp: '998877665544',
        submit_attempts: 1,
      },
    ],
    media: [
      {
        blk_fp: '5544332211',
        played_ms: 0,
      },
    ],
    vitals: {
      lcp_ms: { value: 1450, seq: 1 },
      inp_ms: { value: 72, seq: 3 },
      cls_x1000: { value: 12, seq: 2 },
      ttfb_ms: { value: 180, seq: 1 },
    },
    log_items: [
      {
        i: 0,
        kind: 'activation',
        t_mono: 9800,
        activation_kind: 'click',
        el_fp: '123456789abc',
        dest_key_click: 'px.a8.net/svt/ejp?a8mat=registered',
      },
    ],
    string_slots: {
      page_url_key: 'wakegai.jp/ranking/facial-wash',
    },
  };

  const merged = {
    ...base,
    ...overrides,
  };
  const chk = overrides.chk ?? computeFrameChecksum(merged);
  return {
    ...merged,
    chk,
  };
}

describe('Bundle 1-A: Single Authoritative Contract Schema & Deterministic Generators', () => {
  describe('Canonical schema validity & determinism (zero-diff regenerate check)', () => {
    it('passes all static contract invariants on CANONICAL_SCHEMA', () => {
      const result = validateContractSchema(CANONICAL_SCHEMA);
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(CANONICAL_SCHEMA.consentModes.map((m) => m.mode)).toEqual([...CONSENT_MODES]);
    });

    it('produces byte-identical artifacts and identical SHA-256 hashes on repeated generation', () => {
      const opts = {
        siteName: 'wakegai.jp',
        legalRecipientName: '株式会社リンクス（UGOKI LINK計測基盤）',
        optOutUrl: 'https://wakegai.jp/privacy#optout',
      };

      const run1 = generateAllContractArtifacts(CANONICAL_SCHEMA, opts);
      const run2 = generateAllContractArtifacts(CANONICAL_SCHEMA, opts);

      expect(run1.manifestSha256).toBe(run2.manifestSha256);
      expect(run1.clickhouseDdl.sql).toBe(run2.clickhouseDdl.sql);
      expect(run1.clickhouseDdl.sha256).toBe(run2.clickhouseDdl.sha256);
      expect(run1.postgresDdl.sql).toBe(run2.postgresDdl.sql);
      expect(run1.postgresDdl.sha256).toBe(run2.postgresDdl.sha256);
      expect(run1.typescriptTypes.source).toBe(run2.typescriptTypes.source);
      expect(run1.typescriptTypes.sha256).toBe(run2.typescriptTypes.sha256);
      expect(run1.privacyDisclosure.htmlJa).toBe(run2.privacyDisclosure.htmlJa);
      expect(run1.privacyDisclosure.markdownJa).toBe(run2.privacyDisclosure.markdownJa);
      expect(run1.privacyDisclosure.contentSha256).toBe(run2.privacyDisclosure.contentSha256);
      expect(run1.deletionPlan.contentSha256).toBe(run2.deletionPlan.contentSha256);
      expect(run1.deletionPlan.tableEntries).toEqual(run2.deletionPlan.tableEntries);
    });
  });

  describe('Generator #1: SDK binary codec, frame validator, checksum, size limits & URL param masking', () => {
    const codec = createSdkFrameCodec(CANONICAL_SCHEMA);

    it('encodes and decodes a valid frame losslessly with deterministic bytes', () => {
      const frame = buildValidFrame();
      const validation = codec.validateFrame(frame);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      const bytes1 = codec.encodeFrame(frame);
      const bytes2 = codec.encodeFrame(frame);
      expect(bytes1).toEqual(bytes2);

      const decoded = codec.decodeFrame(bytes1);
      expect(decoded).toEqual(frame);
      expect(codec.verifyChecksum(decoded)).toBe(true);
    });

    it('detects state checksum (chk) tampering', () => {
      const frame = buildValidFrame();
      const tampered: TelemetryFrame = {
        ...frame,
        chk: { ...frame.chk, sumTimeMs: frame.chk.sumTimeMs + 1 },
      };
      const result = codec.validateFrame(tampered);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'CHECKSUM_MISMATCH')).toBe(true);
    });

    it('enforces 16 KiB limit on hidden/critical/deferred frames and requires full=true for hidden/deferred', () => {
      const hiddenNotFull = buildValidFrame({
        frame_class: 'hidden',
        transport: 'beacon',
        full: false,
      });
      const resNotFull = codec.validateFrame(hiddenNotFull);
      expect(resNotFull.valid).toBe(false);
      expect(resNotFull.errors.some((e) => e.code === 'HIDDEN_FRAME_MUST_BE_FULL')).toBe(true);

      // Build oversized (> 16 KiB) hidden frame using many sections
      const manySections = Array.from({ length: 220 }, (_, i) => ({
        sec_fp: i.toString(16).padStart(12, '0'),
        vis_ms: 1000,
        t_first_ms: 100,
        entries: 1,
        max_frac_permille: 1000,
      }));
      const oversizedHidden = buildValidFrame({
        frame_class: 'hidden',
        transport: 'beacon',
        full: true,
        sections: manySections,
      });
      const resHidden = codec.validateFrame(oversizedHidden);
      expect(resHidden.valid).toBe(false);
      expect(resHidden.rawByteLength).toBeGreaterThan(16384);
      expect(resHidden.maxAllowedBytes).toBe(16384);
      expect(resHidden.errors.some((e) => e.code === 'FRAME_SIZE_LIMIT_EXCEEDED')).toBe(true);
      expect(() => codec.encodeFrame(oversizedHidden)).toThrow(/exceeds size budget/);

      // Same payload fits inside visible (48 KiB) limit
      const visibleFrame = buildValidFrame({
        frame_class: 'change',
        transport: 'fetch',
        full: true,
        sections: manySections,
      });
      const resVisible = codec.validateFrame(visibleFrame);
      expect(resVisible.valid).toBe(true);
      expect(resVisible.maxAllowedBytes).toBe(49152);
    });

    it('enforces 48 KiB limit on visible frames', () => {
      const hugeSections = Array.from({ length: 700 }, (_, i) => ({
        sec_fp: i.toString(16).padStart(12, '0'),
        vis_ms: 1000,
        t_first_ms: 100,
        entries: 1,
        max_frac_permille: 1000,
      }));
      const oversizedVisible = buildValidFrame({
        frame_class: 'change',
        transport: 'fetch',
        full: false,
        sections: hugeSections,
      });
      const res = codec.validateFrame(oversizedVisible);
      expect(res.valid).toBe(false);
      expect(res.rawByteLength).toBeGreaterThan(49152);
      expect(res.errors.some((e) => e.code === 'FRAME_SIZE_LIMIT_EXCEEDED')).toBe(true);
    });

    it('enforces consent mode rules (off forbids frames, cookieless forbids visitor/session IDs, stats_exempt forbids personalise/pool)', () => {
      const offFrame = buildValidFrame({ consent_mode: 'off', purposes: [] });
      expect(
        codec.validateFrame(offFrame).errors.some((e) => e.code === 'CONSENT_OFF_FORBIDS_FRAMES')
      ).toBe(true);

      const cookielessWithVisitor = buildValidFrame({
        consent_mode: 'cookieless',
        visitor_id: 'abcdef0123456789abcdef0123456789',
      });
      expect(
        codec
          .validateFrame(cookielessWithVisitor)
          .errors.some((e) => e.code === 'CONSENT_DISALLOWS_IDENTIFIER')
      ).toBe(true);

      const statsExemptWithPersonalise = buildValidFrame({
        consent_mode: 'stats_exempt',
        purposes: ['personalise'],
      });
      expect(
        codec
          .validateFrame(statsExemptWithPersonalise)
          .errors.some((e) => e.code === 'CONSENT_DISALLOWS_PURPOSE')
      ).toBe(true);
    });

    it('enforces closed string slots and rejects unlisted or forbidden string slots', () => {
      const unlistedSlotFrame = buildValidFrame({
        string_slots: {
          free_typed_comment: 'secret user input',
        },
      });
      const res1 = codec.validateFrame(unlistedSlotFrame);
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.code === 'UNREGISTERED_STRING_SLOT')).toBe(true);

      const forbiddenSlotFrame = buildValidFrame({
        string_slots: {
          element_text: 'Buy Now',
        },
      });
      const res2 = codec.validateFrame(forbiddenSlotFrame);
      expect(res2.valid).toBe(false);
      expect(res2.errors.some((e) => e.code === 'FORBIDDEN_BEHAVIOUR_STRING')).toBe(true);
    });

    it('masks URL parameters per §6.4 / D-6 without leaking unknown parameter shape', () => {
      const masked = maskUrlParams(
        {
          page: '2',
          fbclid: 'IwAR123456789',
          q: '敏感肌 化粧水',
          unclassified_num: '123456',
          unclassified_slug: 'secret-token',
        },
        {
          page: 'content',
          fbclid: 'noise',
          q: 'user_input',
        }
      );

      expect(masked.maskedParams).toEqual({
        page: '2',
        q: '__len_5_16',
        unclassified_num: '__len_5_16',
        unclassified_slug: '__len_5_16',
      });
      // Confirm unknown numeric and slug params produce identical length-bucket tokens (no shape leak!)
      expect(masked.maskedParams.unclassified_num).toBe(masked.maskedParams.unclassified_slug);
      expect(masked.droppedNoiseParams).toEqual(['fbclid']);
      expect(masked.maskedUserInputParams).toEqual(['q']);
      expect(masked.maskedUnknownParams).toEqual(['unclassified_num', 'unclassified_slug']);
      expect(masked.keyDegraded).toBe(true);
    });
  });

  describe('Generator #2: Collector ingest validator (partial acceptance & quarantine)', () => {
    const ingest = createIngestValidator(CANONICAL_SCHEMA);

    it('accepts a clean frame without flags', () => {
      const frame = buildValidFrame();
      const res = ingest.validateIngestFrame(frame, {
        serverNowMs: 1795089620000,
        pvStartServerMs: 1795089600000,
        walAllowanceMs: 5000,
      });
      expect(res.accepted).toBe(true);
      expect(res.partial).toBe(false);
      expect(res.stateIncomplete).toBe(false);
      expect(res.fieldFlags).toEqual([]);
      expect(res.quarantineRecord).toBeNull();
    });

    it('partially accepts a frame by clamping/dropping only invalid fields and flagging rej[]', () => {
      const frameWithBadField = buildValidFrame({
        visitor_id: 'abcdef0123456789abcdef0123456789', // disallowed in cookieless -> drop_flag
        state: {
          ...buildValidFrame().state,
          scroll_max_px: 9999999, // exceeds 1,000,000 -> clamp_flag
          vis_ms: 90000, // exceeds dynamic server elapsed bound -> clamp_flag
        },
        vitals: {
          lcp_ms: { value: 9999999, seq: 1 }, // exceeds 600,000 -> drop_flag
          inp_ms: { value: 85, seq: 3 }, // valid -> preserved
        },
        string_slots: {
          page_url_key: 'wakegai.jp/ok',
          rogue_slot: 'should be dropped',
        },
      });

      const res = ingest.validateIngestFrame(frameWithBadField, {
        serverNowMs: 1795089620000,
        pvStartServerMs: 1795089600000,
        walAllowanceMs: 5000, // max dynamic elapsed = 25,000 ms
      });

      expect(res.accepted).toBe(true);
      expect(res.partial).toBe(true);
      expect(res.sanitizedFrame).not.toBeNull();
      expect(res.sanitizedFrame?.visitor_id).toBeNull();
      expect(res.sanitizedFrame?.state.scroll_max_px).toBe(1000000);
      expect(res.sanitizedFrame?.state.vis_ms).toBe(25000);
      expect(res.sanitizedFrame?.vitals?.lcp_ms).toBeUndefined();
      expect(res.sanitizedFrame?.vitals?.inp_ms).toEqual({ value: 85, seq: 3 });
      expect(res.sanitizedFrame?.string_slots).toEqual({ page_url_key: 'wakegai.jp/ok' });
      expect(res.rej.length).toBeGreaterThanOrEqual(4);
    });

    it('rejects envelope errors and scrubs strings in numeric slots to {type, length} in quarantine', () => {
      const poisonedFrame = {
        ...buildValidFrame(),
        state: {
          ...buildValidFrame().state,
          scroll_max_px: 'SENSITIVE_USER_PASSWORD_12345',
        },
      };

      const res = ingest.validateIngestFrame(poisonedFrame);
      expect(res.accepted).toBe(false);
      expect(res.sanitizedFrame).toBeNull();
      expect(res.quarantineRecord).not.toBeNull();
      const serializedQuarantine = JSON.stringify(res.quarantineRecord);
      expect(serializedQuarantine).not.toContain('SENSITIVE_USER_PASSWORD_12345');
      expect(
        (res.quarantineRecord?.sanitizedFields.state as Record<string, unknown>).scroll_max_px
      ).toEqual({
        type: 'string',
        length: 'SENSITIVE_USER_PASSWORD_12345'.length,
      });
    });
  });

  describe('Generator #3, #4, #5, #6: DDL, TS API Types, JP Privacy Disclosure & 14-Day Deletion Plan', () => {
    it('generates valid ClickHouse & Postgres DDL with tenant isolation and zero MVs/projections', () => {
      const ch = generateClickHouseDdl(CANONICAL_SCHEMA);
      expect(ch.tableCount).toBeGreaterThanOrEqual(15);
      expect(ch.sql).toContain('CREATE TABLE IF NOT EXISTS page_view_state');
      expect(ch.sql).toContain('ORDER BY (tenant_id, site_id, pv_hour, url_id, pv_id)');
      expect(ch.sql).toContain('ttl_only_drop_parts = 1');
      expect(ch.sql).toContain('non_replicated_deduplication_window = 10000');
      expect(ch.sql).toContain('AS PERMISSIVE FOR SELECT');
      expect(ch.sql).toContain('AS RESTRICTIVE FOR SELECT');
      expect(ch.sql).not.toMatch(/MATERIALIZED VIEW/i);
      expect(ch.sql).not.toMatch(/PROJECTION/i);

      const pg = generatePostgresDdl(CANONICAL_SCHEMA);
      expect(pg.tableCount).toBeGreaterThanOrEqual(4);
      expect(pg.sql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(pg.sql).toContain('FORCE ROW LEVEL SECURITY');
      expect(pg.sql).toContain('AS RESTRICTIVE USING');
    });

    it('generates syntactically valid TypeScript API types covering all contract domains', () => {
      const ts = generateTypeScriptApiTypes(CANONICAL_SCHEMA);
      expect(ts.source).toContain('export type ApiConsentMode =');
      expect(ts.source).toContain('export interface ApiTelemetryFrameEnvelope');
      expect(ts.source).toContain('export interface ApiDecisionRecord');
      expect(ts.source).toContain('export interface ApiAccessObservation');
      expect(ts.source).toContain("CONTRACT_CODEC_VERSION = 'ugk-bin/1'");

      // Verify generated TypeScript compiles with zero syntax errors using TypeScript parser
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const typescript = require('typescript') as typeof import('typescript');
      const transpileResult = typescript.transpileModule(ts.source, {
        reportDiagnostics: true,
        compilerOptions: {
          target: typescript.ScriptTarget.ES2022,
          module: typescript.ModuleKind.ESNext,
          strict: true,
        },
      });
      expect(transpileResult.diagnostics ?? []).toEqual([]);
    });

    it('generates Japanese External Transmission Rule disclosure with items, recipients, purposes & hash', () => {
      const disclosure = generatePrivacyDisclosure(CANONICAL_SCHEMA, {
        siteName: 'wakegai.jp',
        legalRecipientName: '株式会社テスト（UGOKI LINK）',
      });
      expect(disclosure.legalFramework).toBe('JP_TELECOMMUNICATIONS_BUSINESS_ACT_ART_27_12');
      expect(disclosure.deletionDeadlineDays).toBe(14);
      expect(disclosure.transmittedItems.length).toBeGreaterThan(15);
      expect(disclosure.markdownJa).toContain('送信先（送り先）');
      expect(disclosure.markdownJa).toContain('送信される利用者に関する情報');
      expect(disclosure.markdownJa).toContain('利用目的');
      expect(disclosure.markdownJa).toContain('cookieless');
      expect(disclosure.htmlJa).toContain(`ugokilink-disclosure-sha256:${disclosure.contentSha256}`);
      expect(disclosure.jurisdictionDefaults.find((j) => j.jurisdiction === 'JP')?.effectiveMode).toBe(
        'cookieless'
      );
    });

    it('generates complete 14-day deletion plan covering every personal-linkable table and external store', () => {
      const plan = generateDeletionPlan(CANONICAL_SCHEMA);
      expect(plan.deadlines.maskedWithinHours).toBe(24);
      expect(plan.deadlines.purgedWithinDays).toBe(5);
      expect(plan.deadlines.certifiedWithinDays).toBe(14);

      const tableNames = plan.tableEntries.map((e) => e.tableName);
      expect(tableNames).toContain('pv_by_visitor');
      expect(tableNames).toContain('pv_index');
      expect(tableNames).toContain('page_view_state');
      expect(tableNames).toContain('frame_payload');
      expect(tableNames).toContain('decision_log');
      expect(tableNames).toContain('exposure_log');
      expect(tableNames).toContain('access_obs');
      expect(tableNames).toContain('handoff');
      expect(tableNames).toContain('trajectories');
      expect(tableNames).toContain('identity_link');
      expect(tableNames).toContain('frame_quarantine');
      expect(tableNames).not.toContain('usage_day');
      expect(tableNames).not.toContain('access_bot_lt');
      expect(tableNames).not.toContain('stat_cell_lt');

      expect(plan.externalStoreEntries.map((s) => s.id)).toContain('r2_frame_segments');
      expect(plan.externalStoreEntries.map((s) => s.id)).toContain('ec_member_summary');
      expect(plan.unreachableClasses.length).toBeGreaterThanOrEqual(4);

      expect(verifyDeletionPlanCoverage(CANONICAL_SCHEMA, plan).valid).toBe(true);
    });
  });

  describe('Negative / Seeded Mutation Tests (mandatory CI failure proofs)', () => {
    it('MUST FAIL when a personal-linkable column sits in a table excluded from deletion', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        tables: CANONICAL_SCHEMA.tables.map((t) =>
          t.name === 'usage_day'
            ? {
                ...t,
                columns: [
                  ...t.columns,
                  {
                    name: 'leaked_visitor_key',
                    clickhouseType: 'String',
                    piiClass: 'visitor_id',
                    deletable: false,
                    comment: 'Seeded mutation: personal column in non-deletable table',
                  },
                ],
              }
            : t
        ),
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(
        check.violations.some((v) => v.code === 'PERSONAL_COLUMN_UNREACHABLE_BY_DELETION')
      ).toBe(true);
      expect(() => generateClickHouseDdl(mutatedSchema)).toThrow(ContractInvariantError);
      expect(() => generateDeletionPlan(mutatedSchema)).toThrow(ContractInvariantError);
    });

    it('MUST FAIL coverage verification when a personal-linkable column is omitted from the deletion plan', () => {
      const validPlan = generateDeletionPlan(CANONICAL_SCHEMA);
      const tamperedPlan = {
        ...validPlan,
        tableEntries: validPlan.tableEntries.filter((e) => e.tableName !== 'pv_by_visitor'),
      };
      const coverage = verifyDeletionPlanCoverage(CANONICAL_SCHEMA, tamperedPlan);
      expect(coverage.valid).toBe(false);
      expect(
        coverage.violations.some(
          (v) =>
            v.code === 'PERSONAL_COLUMN_MISSING_FROM_DELETION_PLAN' &&
            v.path.includes('pv_by_visitor')
        )
      ).toBe(true);
    });

    it('MUST FAIL when a string field is added to a behaviour register domain', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        fields: [
          ...CANONICAL_SCHEMA.fields,
          {
            ...CANONICAL_SCHEMA.fields[0],
            tag: 999,
            name: 'section_heading_raw',
            domain: 'section_register',
            type: 'string_closed',
            stringSlot: 'page_url_key',
          },
        ],
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(
        check.violations.some((v) => v.code === 'STRING_FORBIDDEN_IN_BEHAVIOUR_REGISTER')
      ).toBe(true);
    });

    it('MUST FAIL when a string field uses an unregistered string slot outside the closed list', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        fields: [
          ...CANONICAL_SCHEMA.fields,
          {
            ...CANONICAL_SCHEMA.fields[0],
            tag: 998,
            name: 'arbitrary_text',
            domain: 'log_item',
            type: 'string_closed',
            stringSlot: 'unregistered_free_text' as StringSlotId,
          },
        ],
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(check.violations.some((v) => v.code === 'UNREGISTERED_STRING_SLOT')).toBe(true);
    });

    it('MUST FAIL when a forbidden v2 field name (e.g. element_text) is reintroduced', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        fields: [
          ...CANONICAL_SCHEMA.fields,
          {
            ...CANONICAL_SCHEMA.fields[0],
            tag: 997,
            name: 'element_text',
            domain: 'log_item',
            type: 'string_closed',
            stringSlot: 'page_url_key',
          },
        ],
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(check.violations.some((v) => v.code === 'FORBIDDEN_V2_FIELD_NAME')).toBe(true);
    });

    it('MUST FAIL when a string column is added to the integer-only trajectories table (D-11R)', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        tables: CANONICAL_SCHEMA.tables.map((t) =>
          t.name === 'trajectories'
            ? {
                ...t,
                columns: [
                  ...t.columns,
                  {
                    name: 'dom_html_snapshot',
                    clickhouseType: 'String',
                    piiClass: 'none',
                    deletable: false,
                    comment: 'Seeded mutation: forbidden text in timeline table',
                  },
                ],
              }
            : t
        ),
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(
        check.violations.some((v) => v.code === 'STRING_COLUMN_FORBIDDEN_IN_TIMELINE_TABLE')
      ).toBe(true);
    });

    it('MUST FAIL when a max merge field lacks a monotoneProof', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        fields: CANONICAL_SCHEMA.fields.map((f) =>
          f.name === 'scroll_max_px' ? { ...f, monotoneProof: undefined } : f
        ),
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(check.violations.some((v) => v.code === 'MISSING_MONOTONE_PROOF')).toBe(true);
    });

    it('MUST FAIL when a ClickHouse tenant table omits tenant_id from ORDER BY prefix', () => {
      const mutatedSchema: ContractSchema = {
        ...CANONICAL_SCHEMA,
        tables: CANONICAL_SCHEMA.tables.map((t) =>
          t.name === 'events_v2'
            ? { ...t, orderBy: ['pv_hour', 'url_id', 'pv_id'] }
            : t
        ),
      };

      const check = validateContractSchema(mutatedSchema);
      expect(check.valid).toBe(false);
      expect(
        check.violations.some((v) => v.code === 'TENANT_ISOLATION_ORDER_BY_VIOLATION')
      ).toBe(true);
    });
  });

  describe('Wave 8 Regressions (C-14, H-15, H-18)', () => {
    it('C-14: frame_quarantine uses non-nullable quarantine_id in ORDER BY, CH DDL emits 33 tables + 5 public v_* views + SHA256 row policies, and PG DDL emits both PERMISSIVE and RESTRICTIVE RLS', () => {
      const fq = CANONICAL_SCHEMA.tables.find((t) => t.name === 'frame_quarantine');
      expect(fq).toBeDefined();
      expect(fq!.orderBy).toEqual(['tenant_id', 'site_id', 'received_day', 'quarantine_id', 'seq']);
      const qidCol = fq!.columns.find((c) => c.name === 'quarantine_id');
      expect(qidCol?.clickhouseType).toBe('UUID');

      const ch = generateClickHouseDdl(CANONICAL_SCHEMA);
      expect(ch.tableCount).toBe(33);
      expect(ch.sql).toContain("substring(lower(hex(SHA256(toString(tenant_id)))), 1, 32) = replaceRegexpOne(currentUser(), '^ugk_ro_', '')");
      for (const viewName of [
        'v_site_hourly',
        'v_page_hourly',
        'v_conversion_daily',
        'v_loss_ledger_daily',
        'v_actor_daily',
      ]) {
        expect(ch.sql).toContain(`CREATE VIEW IF NOT EXISTS ${viewName} AS`);
      }

      const pg = generatePostgresDdl(CANONICAL_SCHEMA);
      const permissive = pg.sql.match(/AS PERMISSIVE USING/g) ?? [];
      const restrictive = pg.sql.match(/AS RESTRICTIVE USING/g) ?? [];
      expect(permissive).toHaveLength(pg.tableCount);
      expect(restrictive).toHaveLength(pg.tableCount);
    });

    it('H-15: ingest validator recomputes chk on clamped partial-accept frames while keeping stateIncomplete=true on bad incoming chk, and deletion plan covers all 14 external stores', () => {
      const codec = createSdkFrameCodec(CANONICAL_SCHEMA);
      const validator = createIngestValidator(CANONICAL_SCHEMA);
      const oversized = buildValidFrame({
        state: {
          ...buildValidFrame().state,
          scroll_max_px: 99_999_999, // exceeds 200000 ceiling -> clamped on partial accept
        },
      });
      const res = validator.validateIngestFrame(oversized);
      expect(res.accepted).toBe(true);
      expect(res.partial).toBe(true);
      expect(res.sanitizedFrame).not.toBeNull();
      expect(res.sanitizedFrame!.state.scroll_max_px).toBe(1_000_000);
      expect(codec.verifyChecksum(res.sanitizedFrame!)).toBe(true);
      expect(res.stateIncomplete).toBe(false);

      // Corrupt incoming checksum -> partial accept still produces valid downstream chk while flagging stateIncomplete=true
      const badChkFrame = { ...oversized, chk: (oversized.chk ^ 0xff) >>> 0 };
      const resBadChk = validator.validateIngestFrame(badChkFrame);
      expect(resBadChk.sanitizedFrame).not.toBeNull();
      expect(codec.verifyChecksum(resBadChk.sanitizedFrame!)).toBe(true);
      expect(resBadChk.stateIncomplete).toBe(true);

      const plan = generateDeletionPlan(CANONICAL_SCHEMA);
      expect(plan.externalStoreEntries).toHaveLength(14);
      const extKinds = plan.externalStoreEntries.map((s) => s.storeKind);
      expect(extKinds).toEqual(
        expect.arrayContaining([
          'r2_screen_replay',
          'r2_surge_spill',
          'segment_customer_attributes',
          'ec_order_summary',
          'heatmap_png_cache',
          'ask_query_cache',
        ])
      );
    });

    it('H-18: pv_sequence, access_obs, and access_verdict use daily toYYYYMMDD(...) partitions aligned with TTL', () => {
      for (const [name, expectedPart] of [
        ['pv_sequence', 'toYYYYMMDD(pv_hour)'],
        ['access_obs', 'toYYYYMMDD(day_edge)'],
        ['access_verdict', 'toYYYYMMDD(day_edge)'],
      ] as const) {
        const tbl = CANONICAL_SCHEMA.tables.find((t) => t.name === name);
        expect(tbl?.partitionBy).toBe(expectedPart);
      }
    });
  });
});
