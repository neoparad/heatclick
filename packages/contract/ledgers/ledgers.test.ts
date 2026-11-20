import {
  CONSTANTS_LEDGER,
  DECISIONS_LEDGER,
  GATES_LEDGER,
  NotEntitledError,
  UNKNOWABLES_LEDGER,
  assertDecisionEntitled,
  auditCatalogDescriptions,
  auditDescriptionAgainstUnknowables,
  getCapabilitiesSummary,
  getConstant,
  getConstantsByDomain,
  getDecision,
  getGate,
  getGatesByDomain,
  getUnknowable,
  isWithinMutableRange,
  requireDecisionEntitled,
  type GateDomain,
  type GateEvaluationType,
} from './index'

describe('UGOKI LINK v2 Contract Ledgers (Wave 1-B)', () => {
  describe('Global ID uniqueness across all four ledgers', () => {
    it('enforces unique IDs in GATES_LEDGER (and unique legacyAliases)', () => {
      const ids = GATES_LEDGER.map((g) => g.id)
      expect(new Set(ids).size).toBe(ids.length)

      const aliases = GATES_LEDGER.map((g) => g.legacyAlias).filter((a): a is string => Boolean(a))
      expect(new Set(aliases).size).toBe(aliases.length)
      for (const alias of aliases) {
        expect(new Set(ids).has(alias)).toBe(false)
      }
    })

    it('enforces unique IDs in CONSTANTS_LEDGER', () => {
      const ids = CONSTANTS_LEDGER.map((c) => c.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('enforces unique IDs in UNKNOWABLES_LEDGER', () => {
      const ids = UNKNOWABLES_LEDGER.map((u) => u.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('enforces unique IDs in DECISIONS_LEDGER', () => {
      const ids = DECISIONS_LEDGER.map((d) => d.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  describe('Gates Ledger (`gates.ts`)', () => {
    const ALL_DOMAINS: GateDomain[] = ['tel', 'store', 'join', 'act', 'ml', 'ev', 'del', 'surf']
    const VALID_EVAL_TYPES: ReadonlySet<GateEvaluationType> = new Set([
      'fixed_horizon',
      'always_valid',
      'deterministic',
    ])

    it('covers all 8 domains and major numbered gates', () => {
      for (const domain of ALL_DOMAINS) {
        expect(getGatesByDomain(domain).length).toBeGreaterThan(0)
      }

      // tel.G1–tel.G17 (+ G18, G19)
      for (let i = 1; i <= 19; i += 1) {
        expect(getGate(`tel.G${i}`)).toBeDefined()
      }
      // store.G-1–store.G-20
      for (let i = 1; i <= 20; i += 1) {
        expect(getGate(`store.G-${i}`)).toBeDefined()
      }
      // join.G1–join.G20
      for (let i = 1; i <= 20; i += 1) {
        expect(getGate(`join.G${i}`)).toBeDefined()
      }
      // act.G1–act.G34
      for (let i = 1; i <= 34; i += 1) {
        expect(getGate(`act.G${i}`)).toBeDefined()
      }
      // ev.G-0–ev.G-23
      for (let i = 0; i <= 23; i += 1) {
        expect(getGate(`ev.G-${i}`)).toBeDefined()
      }
      // del.D1–del.D17 & del.D19–del.D28 (D18 unified into surf.capacity per X-55)
      for (let i = 1; i <= 28; i += 1) {
        if (i === 18) continue
        expect(getGate(`del.D${i}`)).toBeDefined()
      }
      // surf.G1–surf.G4 and legacy alias resolution (sur.G1 -> surf.G1)
      for (let i = 1; i <= 4; i += 1) {
        expect(getGate(`surf.G${i}`)).toBeDefined()
        expect(getGate(`sur.G${i}`)?.id).toBe(`surf.G${i}`)
      }
      expect(getGate('surf.capacity')).toBeDefined()
      expect(getGate('sur.capacity')?.id).toBe('surf.capacity')
      expect(getGate('ml.H0')).toBeDefined()
      expect(getGate('ml.gen_provenance_clean')).toBeDefined()
    })

    it('declares mandatory statistical evaluationType and valid step on every gate (§12.2)', () => {
      for (const gate of GATES_LEDGER) {
        expect(VALID_EVAL_TYPES.has(gate.evaluationType)).toBe(true)
        expect(gate.id.startsWith(`${gate.domain}.`)).toBe(true)
        expect(gate.step).toMatch(/^Q-(?:[0-9]|[12][0-9]|30)$/)
        expect(gate.requirement.trim().length).toBeGreaterThan(0)
        expect(gate.unlockCondition.trim().length).toBeGreaterThan(0)
        expect(gate.currentProgress.need).toBeGreaterThan(0)
        expect(gate.currentProgress.unit.trim().length).toBeGreaterThan(0)
      }

      // Spot-check statistical vs deterministic classification
      expect(getGate('tel.G16')?.evaluationType).toBe('fixed_horizon')
      expect(getGate('tel.G18')?.evaluationType).toBe('fixed_horizon')
      expect(getGate('ev.G-1')?.evaluationType).toBe('always_valid')
      expect(getGate('store.G-9')?.evaluationType).toBe('always_valid')
      expect(getGate('del.D1')?.evaluationType).toBe('deterministic')
      expect(getGate('tel.G7')?.evaluationType).toBe('deterministic')
    })

    it('ensures every requiredDecisionId references a valid decision in DECISIONS_LEDGER', () => {
      for (const gate of GATES_LEDGER) {
        for (const decisionId of gate.requiredDecisionIds) {
          expect(getDecision(decisionId)).toBeDefined()
        }
      }
    })

    it('builds GET /v1/sites/{id}/capabilities summary with accurate decision-gating', () => {
      const summary = getCapabilitiesSummary({
        siteId: 'site_wakegai',
        now: '2026-11-20T12:00:00Z',
        statusOverrides: {
          'tel.M9': 'open',
          // Even if caller tries to mark tel.G10 open, pending D-01 forces closed + not_entitled
          'tel.G10': 'open',
        },
        progressOverrides: {
          'tel.G16': { have: 12000 },
        },
      })

      expect(summary.siteId).toBe('site_wakegai')
      expect(summary.summary.total).toBe(GATES_LEDGER.length)
      expect(summary.summary.open + summary.summary.closed).toBe(summary.summary.total)

      const telM9 = summary.capabilities.find((c) => c.gateId === 'tel.M9')
      expect(telM9?.status).toBe('open')
      expect(telM9?.apiMeasureStatus).toBe('ok')

      const telG10 = summary.capabilities.find((c) => c.gateId === 'tel.G10')
      expect(telG10?.status).toBe('closed')
      expect(telG10?.apiMeasureStatus).toBe('not_entitled')
      expect(telG10?.unmetDecisions.map((d) => d.decisionId)).toContain('D-01')

      // Partial progress on fixed_horizon gate whose decision (D-02) is pending still stays not_entitled
      const telG16 = summary.capabilities.find((c) => c.gateId === 'tel.G16')
      expect(telG16?.apiMeasureStatus).toBe('not_entitled')
      expect(telG16?.currentProgress.have).toBe(12000)

      // Partial progress on a statistical gate with no pending decisions reports insufficient_data
      const summaryWithProgress = getCapabilitiesSummary({
        progressOverrides: { 'ev.G-1': { have: 10000 } },
      })
      const evG1 = summaryWithProgress.capabilities.find((c) => c.gateId === 'ev.G-1')
      expect(evG1?.apiMeasureStatus).toBe('insufficient_data')
    })
  })

  describe('Constants Ledger (`constants.ts`)', () => {
    it('contains mandatory budgets, thresholds, 10% bandit floor, guardrails, 30d/90d cadences, and k=10 suppression', () => {
      expect(getConstant('tel.bundle_core_max_kb')?.value).toBe(20)
      expect(getConstant('tel.page_total_budget_kb')?.value).toBe(114)
      expect(getConstant('ml.artifact_max_kb')?.value).toBe(50)
      expect(getConstant('store.dedicated_node_ram_gib')?.value).toBe(8)
      expect(getConstant('ev.bandit_min_arm_floor')?.value).toBe(0.1)
      expect(getConstant('ev.bandit_uniform_slice')?.value).toBe(0.1)
      expect(getConstant('ev.planner_inflation_f')?.value).toBe(1.068)
      expect(getConstant('ev.min_experiment_days')?.value).toBe(14)
      expect(getConstant('ops.release_train_days')?.value).toBe(30)
      expect(getConstant('ops.run_in_window_days')?.value).toBe(30)
      expect(getConstant('ops.key_rotation_days')?.value).toBe(90)
      expect(getConstant('surf.export_min_cell_k')?.value).toBe(10)
      expect(getConstant('store.deletion_cert_days')?.value).toBe(14)
      expect(getConstant('del.stop_k1_new_s')?.value).toBe(3)
      expect(getConstant('del.stop_k1_visible_s')?.value).toBe(6)
      expect(getConstant('act.watchdog_remove_p95_s')?.value).toBe(180)
      expect(getConstantsByDomain('ev').length).toBeGreaterThan(5)
    })

    it('provides provenance, owner, mutableRange, reviewCycle, and rationale on every constant', () => {
      for (const c of CONSTANTS_LEDGER) {
        expect(c.owner.trim().length).toBeGreaterThan(0)
        expect(c.unit.trim().length).toBeGreaterThan(0)
        expect(c.mutableRange.description.trim().length).toBeGreaterThan(0)
        expect(c.reviewCycle.trim().length).toBeGreaterThan(0)
        expect(c.rationale.trim().length).toBeGreaterThan(0)
        expect(c.specRef.trim().length).toBeGreaterThan(0)
      }
    })

    it('enforces mutableRange bounds via isWithinMutableRange', () => {
      expect(isWithinMutableRange('ev.bandit_min_arm_floor', 0.1)).toBe(true)
      expect(isWithinMutableRange('ev.bandit_min_arm_floor', 0.15)).toBe(true)
      expect(isWithinMutableRange('ev.bandit_min_arm_floor', 0.05)).toBe(false)
      expect(isWithinMutableRange('surf.export_min_cell_k', 10)).toBe(true)
      expect(isWithinMutableRange('surf.export_min_cell_k', 5)).toBe(false)
      expect(isWithinMutableRange('tel.inp_threshold_ms', 200)).toBe(true)
      expect(isWithinMutableRange('tel.inp_threshold_ms', 250)).toBe(false)
    })
  })

  describe('Unknowables Ledger (`unknowables.ts`) & API/MCP audit linter', () => {
    it('registers all core §4.9 / §16.4 unknowables (TEL U1–U16, ACT U1–U4, EV U1)', () => {
      for (let i = 1; i <= 16; i += 1) {
        expect(getUnknowable(`tel.U${i}`)).toBeDefined()
      }
      for (let i = 1; i <= 4; i += 1) {
        expect(getUnknowable(`act.U${i}`)).toBeDefined()
      }
      expect(getUnknowable('ev.U1')).toBeDefined()

      for (const entry of UNKNOWABLES_LEDGER) {
        expect(entry.topic.trim().length).toBeGreaterThan(0)
        expect(entry.limitation.trim().length).toBeGreaterThan(0)
        expect(entry.specBasis.trim().length).toBeGreaterThan(0)
        expect(entry.strongestProxy.trim().length).toBeGreaterThan(0)
        expect(entry.proxyUpperBound.trim().length).toBeGreaterThan(0)
        expect(entry.unlockRequirement.trim().length).toBeGreaterThan(0)
      }
    })

    it('rejects API/MCP descriptions that omit upper bounds when touching an unknowable topic', () => {
      const badQueryDesc = auditDescriptionAgainstUnknowables(
        'ページの検索クエリ別の到達率とCVRを返します。',
        { operationId: 'behavior_search_query' },
      )
      expect(badQueryDesc.passed).toBe(false)
      expect(badQueryDesc.violations.some((v) => v.limitId === 'tel.U4' && v.kind === 'missing_upper_bound')).toBe(true)

      const badLocalAiDesc = auditDescriptionAgainstUnknowables(
        'ローカルAIによるアクセス一覧を返します。',
        { operationId: 'agents_local' },
      )
      expect(badLocalAiDesc.passed).toBe(false)
      expect(badLocalAiDesc.violations.some((v) => v.limitId === 'act.U3' && v.kind === 'missing_upper_bound')).toBe(true)
    })

    it('rejects hard-banned overclaims even when declaredLimitIds are provided', () => {
      const forbiddenZeroLoss = auditDescriptionAgainstUnknowables(
        '欠損ゼロで全PVを収集します（tel.U2 の上限あり）。',
        { operationId: 'ingest_events', declaredLimitIds: ['tel.U2'] },
      )
      expect(forbiddenZeroLoss.passed).toBe(false)
      expect(forbiddenZeroLoss.violations.some((v) => v.limitId === 'tel.U2' && v.kind === 'forbidden_claim')).toBe(true)

      const forbiddenAiProb = auditDescriptionAgainstUnknowables(
        'このセッションがAIである確率を出力します。',
        { operationId: 'agents_score', declaredLimitIds: ['act.U3'] },
      )
      expect(forbiddenAiProb.passed).toBe(false)
      expect(forbiddenAiProb.violations.some((v) => v.limitId === 'act.U3' && v.kind === 'forbidden_claim')).toBe(true)

      const forbiddenCausal = auditDescriptionAgainstUnknowables(
        '前後比較から原因を断定して改善幅を返します。',
        { operationId: 'fusion_diff', declaredLimitIds: ['ev.U1'] },
      )
      expect(forbiddenCausal.passed).toBe(false)
      expect(forbiddenCausal.violations.some((v) => v.limitId === 'ev.U1' && v.kind === 'forbidden_claim')).toBe(true)
    })

    it('passes descriptions that properly state limitations, proxies, and evidence caps', () => {
      const catalogAudit = auditCatalogDescriptions([
        {
          operationId: 'behavior_search',
          description:
            '自然検索クエリは訪問ごとには取得不可のため、Search Console の着地ページ×日×端末×国の分布 (q_prior) と仮定を置かない上下限 (inferred) を返します。',
          declaredLimitIds: ['tel.U4'],
        },
        {
          operationId: 'agents_local_score',
          description:
            'ローカルAIの身元は確定できないため、点確率ではなく尤度比と人間パネル証明済みの誤検知率上限 (fpr_upper_panel) を返します。',
          declaredLimitIds: ['act.U3'],
        },
        {
          operationId: 'change_effect_ledger',
          description:
            '前後比較による準実験の観測値 (observed) であり原因は断定しません。因果の実証 (proven) には無作為実験が必要です。',
          declaredLimitIds: ['ev.U1'],
        },
      ])

      expect(catalogAudit.passed).toBe(true)
      expect(catalogAudit.failedCount).toBe(0)
      expect(catalogAudit.totalChecked).toBe(3)
    })
  })

  describe('Owner Decisions Ledger (`decisions.ts`) & Decision 31-b Jev lock', () => {
    it('covers all owner decisions 1 through 31 (with 31-a/b/c/d split)', () => {
      for (let num = 1; num <= 30; num += 1) {
        const id = `D-${String(num).padStart(2, '0')}`
        expect(getDecision(id)).toBeDefined()
      }
      expect(getDecision('D-31a')).toBeDefined()
      expect(getDecision('D-31b')).toBeDefined()
      expect(getDecision('D-31c')).toBeDefined()
      expect(getDecision('D-31d')).toBeDefined()
      // Shorthand alias lookup
      expect(getDecision('31-a')?.id).toBe('D-31a')
      expect(getDecision('31-b')?.id).toBe('D-31b')
      expect(getDecision('31-c')?.id).toBe('D-31c')
      expect(getDecision('31-d')?.id).toBe('D-31d')
    })

    it('records 2026-11-20 decided items (31-a, 31-b, 31-c) as decided and undecided items as pending', () => {
      const d31a = getDecision('D-31a')
      const d31b = getDecision('D-31b')
      const d31c = getDecision('D-31c')
      const d31d = getDecision('D-31d')

      expect(d31a?.status).toBe('decided')
      expect(d31a?.outcome).toBe('approved')
      expect(d31a?.decidedAt).toBe('2026-11-20')

      expect(d31b?.status).toBe('decided')
      expect(d31b?.outcome).toBe('prohibited')
      expect(d31b?.decidedAt).toBe('2026-11-20')

      expect(d31c?.status).toBe('decided')
      expect(d31c?.outcome).toBe('approved')
      expect(d31c?.decidedAt).toBe('2026-11-20')

      expect(d31d?.status).toBe('pending')
      expect(d31d?.outcome).toBe('undecided')

      // Decisions 1–30 remain pending until formally recorded
      for (let num = 1; num <= 30; num += 1) {
        const entry = getDecision(`D-${String(num).padStart(2, '0')}`)
        expect(entry?.status).toBe('pending')
      }
    })

    it('permanently locks Decision 31-b (Jev output training ban) as not_entitled / prohibited_by_decision', () => {
      const resCanonical = requireDecisionEntitled('D-31b')
      expect(resCanonical.entitled).toBe(false)
      expect(resCanonical.status).toBe('not_entitled')
      if (!resCanonical.entitled) {
        expect(resCanonical.reason).toBe('prohibited_by_decision')
        expect(resCanonical.decisionId).toBe('D-31b')
      }

      // Shorthand '31-b' also enforces the permanent lock
      const resAlias = requireDecisionEntitled('31-b')
      expect(resAlias.entitled).toBe(false)
      expect(resAlias.status).toBe('not_entitled')

      expect(() => assertDecisionEntitled('D-31b')).toThrow(NotEntitledError)
      try {
        assertDecisionEntitled('31-b')
      } catch (err) {
        expect(err).toBeInstanceOf(NotEntitledError)
        const notEntitled = err as NotEntitledError
        expect(notEntitled.status).toBe('not_entitled')
        expect(notEntitled.reason).toBe('prohibited_by_decision')
      }
    })

    it('returns ok for approved decisions (31-a, 31-c) and not_entitled for pending or unknown decisions', () => {
      expect(requireDecisionEntitled('D-31a')).toEqual({
        entitled: true,
        status: 'ok',
        decisionId: 'D-31a',
        outcome: 'approved',
        decidedAt: '2026-11-20',
      })
      expect(requireDecisionEntitled('D-31c')).toEqual({
        entitled: true,
        status: 'ok',
        decisionId: 'D-31c',
        outcome: 'approved',
        decidedAt: '2026-11-20',
      })

      const pending = requireDecisionEntitled('D-01')
      expect(pending.entitled).toBe(false)
      expect(pending.status).toBe('not_entitled')
      if (!pending.entitled) {
        expect(pending.reason).toBe('decision_pending')
      }

      const pending31d = requireDecisionEntitled('31-d')
      expect(pending31d.entitled).toBe(false)
      expect(pending31d.status).toBe('not_entitled')

      const unknown = requireDecisionEntitled('D-999')
      expect(unknown.entitled).toBe(false)
      expect(unknown.status).toBe('not_entitled')
      if (!unknown.entitled) {
        expect(unknown.reason).toBe('unknown_decision')
      }
    })
  })
})
