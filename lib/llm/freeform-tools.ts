/**
 * lib/llm/freeform-tools.ts — AI SDK v6 tool wiring for freeform LLM analysis (続 82-ml W2-B)
 *
 * 親 SSOT §2.2.6 LLM 抽象化 / §3.8.1 tenant isolation / CLAUDE.md "Tenant Isolation"
 * 配備根拠: 続 66 §2 Layer 2 (4 Tools) を AI SDK v6 `tool()` でラップし freeform 経路に結線。
 *
 * 設計方針 (続 64 hardening 1:1 継承):
 *   - 各 analytics tool を AI SDK `tool({ description, inputSchema, execute })` でラップ
 *   - `inputSchema` は `analytics-tools.ts` の Zod schema をそのまま再利用 (siteId/tenantId を含めない)
 *   - `execute` は server-controlled な `ctx` + `requestSiteId` を closure 捕捉し
 *     `executeAnalyticsTool()` 経由で IDOR + Zod + parentQueryId 防御を通す
 *   - **siteId / tenantId は server 固定**: LLM が tool input に出してきても executor が破棄
 *   - tool 結果は string 化して LLM へ返す (構造化 output は steps[].toolResults 経由で別途集計)
 */

import { tool, type Tool, type ToolSet } from 'ai'

import {
  ANALYTICS_TOOL_SCHEMAS,
  executeAnalyticsTool,
  type AnalyticsToolName,
  type AnalyticsToolResult,
} from '@/lib/llm/analytics-tools'
import type { TenantContext } from '@/lib/tenant'

/**
 * 1 件の成功した analytics tool 呼び出し結果 (evidence 構築用)。
 * orchestrator が steps から集計し EvidenceRef[] へ写像する。
 */
export interface FreeformToolCall {
  name: AnalyticsToolName
  result: AnalyticsToolResult
}

/**
 * tool execute 中に成功した呼び出しを記録する collector。
 * generateText の `steps` 由来 metadata だけでは構造化結果 (evidenceLevel 等) を
 * 取り出しづらいため、execute closure 内で server-side に蓄積する。
 */
export interface FreeformToolCollector {
  readonly calls: FreeformToolCall[]
}

const ANALYTICS_TOOL_DESCRIPTIONS: Record<AnalyticsToolName, string> = ANALYTICS_TOOL_SCHEMAS.reduce(
  (acc, schema) => {
    acc[schema.name] = schema.description
    return acc
  },
  {} as Record<AnalyticsToolName, string>,
)

/**
 * tool 結果を LLM へ返す JSON-string に整形 (PII を含めない server-controlled 構造)。
 * AI SDK は execute の戻り値を tool-result として model へ流すため、軽量な JSON にする。
 */
function serializeToolResult(result: AnalyticsToolResult): string {
  return JSON.stringify(result)
}

/**
 * 4 つの analytics tool を AI SDK v6 `ToolSet` として構築する。
 *
 * @param ctx           tenant context (server-controlled、LLM 入力から採用しない)
 * @param requestSiteId request body 由来の検証済 siteId (server-controlled)
 * @param collector     成功した tool 呼び出しを蓄積する mutable collector (evidence 構築用)
 */
export function buildFreeformTools(params: {
  ctx: TenantContext
  requestSiteId: string
  collector: FreeformToolCollector
}): ToolSet {
  const { ctx, requestSiteId, collector } = params

  const make = (name: AnalyticsToolName): Tool =>
    tool({
      description: ANALYTICS_TOOL_DESCRIPTIONS[name],
      inputSchema: schemaFor(name),
      execute: async (llmArgs: unknown): Promise<string> => {
        // siteId / tenantId は LLM 入力から採用せず、server-controlled 値で固定。
        // executeAnalyticsTool が authorize → Zod parse → parentQueryId 検証を行う。
        const result = await executeAnalyticsTool(name, llmArgs, {
          ctx,
          requestSiteId,
        })
        collector.calls.push({ name, result })
        return serializeToolResult(result)
      },
    })

  const set: ToolSet = {}
  for (const schema of ANALYTICS_TOOL_SCHEMAS) {
    // 続120 fix: Anthropic/Gateway の tool 名は ^[a-zA-Z0-9_-]+$ (dot 不可)。canonical 名は
    // dotted (analytics.overview) のため generateText が HTTP 400 (freeform が常に stub) だった。
    // LLM へは dot→underscore に変換した alias 名で公開し、executor は元の dotted 名のまま使う。
    set[toLlmToolName(schema.name)] = make(schema.name)
  }
  return set
}

/** Anthropic tool-name 制約 (dot 不可) 対応: dotted 内部名 → underscore の LLM 公開名。 */
function toLlmToolName(name: string): string {
  return name.replace(/\./g, '_')
}

function schemaFor(name: AnalyticsToolName): (typeof ANALYTICS_TOOL_SCHEMAS)[number]['inputSchema'] {
  const found = ANALYTICS_TOOL_SCHEMAS.find((s) => s.name === name)
  if (!found) {
    // ANALYTICS_TOOL_SCHEMAS は name を網羅するため到達不能 (型安全のための防御)
    throw new Error(`unknown analytics tool schema: ${name}`)
  }
  return found.inputSchema
}
