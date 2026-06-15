/**
 * freeform-tools.test.ts — freeform tool 配線の回帰テスト
 *
 * 主目的: 続120 で起きた「dotted tool 名で Anthropic/Gateway が HTTP 400 → freeform 常時 stub」
 *   の再発防止。LLM へ公開する tool 名が必ず Anthropic 制約 ^[a-zA-Z0-9_-]{1,128}$ に従うことを保証する。
 * 副次: ANALYTICS_TOOL_SCHEMAS の全 tool が ToolSet に載り、Phase 1 (2026-06-06) 追加の 6 ツールが
 *   登録されていることを検証する。ネットワーク非依存 (build 時に ClickHouse/auth は呼ばれない)。
 */

import { buildFreeformTools, type FreeformToolCollector } from '@/lib/llm/freeform-tools'
import { ANALYTICS_TOOL_SCHEMAS } from '@/lib/llm/analytics-tools'
import type { TenantContext } from '@/lib/tenant'

// Anthropic / AI Gateway の custom tool 名制約 (dot 不可)。
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

function makeCtx(): TenantContext {
  return {
    tenant_id: 'tnt_test',
    plan: 'growth',
    site_ids: ['CIP_TEST'],
    user_id: 'usr_test',
  }
}

function buildSet() {
  const collector: FreeformToolCollector = { calls: [] }
  return buildFreeformTools({ ctx: makeCtx(), requestSiteId: 'CIP_TEST', collector })
}

describe('buildFreeformTools 名前制約', () => {
  it('LLM 公開名はすべて Anthropic 制約に従い dot を含まない', () => {
    const set = buildSet()
    const names = Object.keys(set)
    expect(names.length).toBe(ANALYTICS_TOOL_SCHEMAS.length)
    for (const name of names) {
      expect(name).toMatch(ANTHROPIC_TOOL_NAME)
      expect(name).not.toContain('.')
    }
  })

  it('dotted canonical 名は underscore alias で公開される', () => {
    const set = buildSet()
    // canonical に dot を含むものは alias 化されていること
    for (const schema of ANALYTICS_TOOL_SCHEMAS) {
      const llmName = schema.name.replace(/\./g, '_')
      expect(set[llmName]).toBeDefined()
    }
  })

  it('各 tool は description と inputSchema を持つ', () => {
    const set = buildSet()
    for (const t of Object.values(set)) {
      expect(typeof (t as { description?: unknown }).description).toBe('string')
      expect((t as { inputSchema?: unknown }).inputSchema).toBeDefined()
    }
  })
})

describe('Phase 1 (2026-06-06) 追加 6 ツール登録', () => {
  const PHASE1_TOOLS = [
    'analytics_data_readiness',
    'analytics_time_to_interaction',
    'analytics_dead_zones',
    'analytics_retention',
    'analytics_media_engagement',
    'analytics_above_fold',
  ] as const

  it('6 ツールが ANALYTICS_TOOL_SCHEMAS に存在する', () => {
    const registered = new Set(ANALYTICS_TOOL_SCHEMAS.map((s) => s.name))
    for (const name of PHASE1_TOOLS) {
      expect(registered.has(name)).toBe(true)
    }
  })

  it('6 ツールが LLM ToolSet に公開される', () => {
    const set = buildSet()
    for (const name of PHASE1_TOOLS) {
      expect(set[name]).toBeDefined()
    }
  })
})

describe('Phase 1b/1c (2026-06-06) クロス/経路/比較/異常検知 ツール登録', () => {
  const NEW_TOOLS = [
    'analytics_crosstab',
    'analytics_journeys',
    'analytics_segment_compare',
    'analytics_anomaly',
    'analytics_action_cohort',
    'analytics_element_breakdown',
    'rank_behavior_validated_fixes',
    'explain_section_friction',
    'deep_research_propose',
    'deep_research_enqueue',
  ] as const

  it('ツールが ANALYTICS_TOOL_SCHEMAS に存在し ToolSet に公開される', () => {
    const registered = new Set(ANALYTICS_TOOL_SCHEMAS.map((s) => s.name))
    const set = buildSet()
    for (const name of NEW_TOOLS) {
      expect(registered.has(name)).toBe(true)
      expect(set[name]).toBeDefined()
    }
  })
})
