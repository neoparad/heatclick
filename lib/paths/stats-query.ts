import type { ClickHouseClient } from '@clickhouse/client'

import { ALLOWED_EVENT_TYPES } from '@/lib/llm/hybrid-query'
import {
  PATHS_UNANALYZED_VALUE,
  edgeBandForDropRate,
  formatPathCount,
  formatPathPercent,
  rollupBranchSeverity,
} from './stats-format'
import type { PathBranch, PathNode, PathSet } from './types'
import { canonicalizeHeatmapUrl, canonicalUrlSql } from '@/lib/heatmap/canonical-url'

const DEFAULT_WINDOW_SECONDS = 1_800

export interface PathStatsStepResult {
  reached: ReadonlyArray<number | null>
  warnings: string[]
}

interface PathStepCondition {
  expression: string
  params: Record<string, string>
  warning?: string
}

interface PathStatsQueryArgs {
  tenantId: string
  siteId: string
  periodDays: number
}

export interface ComputeBranchFunnelArgs extends PathStatsQueryArgs {
  steps: ReadonlyArray<string>
  windowSeconds?: number
}

export interface FetchTriggerSessionsArgs extends PathStatsQueryArgs {
  triggerUrl: string
}

export interface ComputePathSetStatsOptions {
  windowSeconds?: number
}

interface BranchProjection {
  branch: PathBranch
  cvRate: number | null
}

function stepParamKey(index: number, suffix: 'url' | 'prefix' | 'evt' | 'cv'): string {
  return `s${index}_${suffix}`
}

function buildPathStepCondition(step: string, index: number): PathStepCondition {
  const value = step.trim()
  if (value.startsWith('event:')) return buildEventCondition(value, index)
  if (value.startsWith('conversion:')) return buildConversionCondition(value, index)
  return buildPageCondition(value, index)
}

function buildEventCondition(step: string, index: number): PathStepCondition {
  const eventType = step.slice('event:'.length).trim()
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return { expression: '', params: {}, warning: `Unsupported event step '${step}'` }
  }

  const key = stepParamKey(index, 'evt')
  return {
    expression: `event_type = {${key}:String}`,
    params: { [key]: eventType },
  }
}

function buildConversionCondition(step: string, index: number): PathStepCondition {
  const conversionType = step.slice('conversion:'.length).trim()
  if (!conversionType) {
    return { expression: '', params: {}, warning: `Unsupported conversion step '${step}'` }
  }

  const key = stepParamKey(index, 'cv')
  return {
    expression: `event_type = 'conversion' AND conversion_type = {${key}:String}`,
    params: { [key]: conversionType },
  }
}

function buildPageCondition(step: string, index: number): PathStepCondition {
  const canonicalUrl = canonicalizeHeatmapUrl(step)
  if (!canonicalUrl.startsWith('/') || (canonicalUrl.includes('*') && !canonicalUrl.endsWith('/*'))) {
    return { expression: '', params: {}, warning: `Unsupported page step '${step}'` }
  }

  if (canonicalUrl.endsWith('/*')) {
    const key = stepParamKey(index, 'prefix')
    return {
      expression: `event_type = 'pageview' AND startsWith(${canonicalUrlSql('url')}, {${key}:String})`,
      params: { [key]: canonicalUrl.slice(0, -1) },
    }
  }

  const key = stepParamKey(index, 'url')
  return {
    expression: `event_type = 'pageview' AND ${canonicalUrlSql('url')} = {${key}:String}`,
    params: { [key]: canonicalUrl },
  }
}

function baseEventQuery(args: PathStatsQueryArgs): { where: string; params: Record<string, string | number> } {
  validateQueryArgs(args)
  return {
    where: `
      tenant_id = {tenant_id:String}
      AND site_id = {site_id:String}
      AND is_agent = 0
      AND timestamp >= now() - toIntervalDay({period_days:UInt16})`.trim(),
    params: {
      tenant_id: args.tenantId,
      site_id: args.siteId,
      period_days: args.periodDays,
    },
  }
}

function validateQueryArgs(args: PathStatsQueryArgs): void {
  if (!args.tenantId || !args.siteId) throw new Error('Path stats require tenant and site scope')
  if (!Number.isInteger(args.periodDays) || args.periodDays < 1 || args.periodDays > 365) {
    throw new Error('Path stats periodDays must be an integer from 1 through 365')
  }
}

function toNonNegativeCount(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0
}

function projectReachedCounts(
  steps: ReadonlyArray<string>,
  supportedIndexes: ReadonlyArray<number>,
  row: Record<string, unknown>,
): ReadonlyArray<number | null> {
  return steps.map((_, originalIndex) => {
    const supportedIndex = supportedIndexes.indexOf(originalIndex)
    return supportedIndex === -1 ? null : toNonNegativeCount(row[`s${supportedIndex + 1}`])
  })
}

export async function computeBranchFunnel(
  client: ClickHouseClient,
  args: ComputeBranchFunnelArgs,
): Promise<PathStatsStepResult> {
  const { where, params } = baseEventQuery(args)
  const conditions = args.steps.map((step, index) => ({ index, ...buildPathStepCondition(step, index) }))
  const supported = conditions.filter((condition) => !condition.warning)
  const warnings = conditions.flatMap((condition) => (condition.warning ? [condition.warning] : []))

  if (supported.length === 0) return { reached: args.steps.map(() => null), warnings }

  const windowSeconds = args.windowSeconds ?? DEFAULT_WINDOW_SECONDS
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error('Path stats windowSeconds must be a positive integer')
  }

  const queryParams: Record<string, string | number> = {
    ...params,
    window_seconds: windowSeconds,
    ...Object.assign({}, ...supported.map((condition) => condition.params)),
  }
  const countExpressions = supported
    .map((_, index) => `countIf(reached >= ${index + 1}) AS s${index + 1}`)
    .join(',\n      ')
  const funnelConditions = supported.map((condition) => condition.expression).join(',\n        ')
  const query = `
    SELECT ${countExpressions}
    FROM (
      SELECT
        session_id,
        windowFunnel({window_seconds:UInt32})(
          toDateTime(timestamp),
          ${funnelConditions}
        ) AS reached
      FROM clickinsight.events
      WHERE ${where}
      GROUP BY session_id
    )
  `.trim()

  const result = await client.query({ query, query_params: queryParams, format: 'JSONEachRow' })
  const rows = await result.json<Record<string, unknown>>()
  return {
    reached: projectReachedCounts(args.steps, supported.map((condition) => condition.index), rows[0] ?? {}),
    warnings,
  }
}

export async function fetchTriggerSessions(
  client: ClickHouseClient,
  args: FetchTriggerSessionsArgs,
): Promise<{ sessions: number; warnings: string[] }> {
  const condition = buildPathStepCondition(args.triggerUrl, 0)
  if (condition.warning) return { sessions: 0, warnings: [condition.warning] }

  const { where, params } = baseEventQuery(args)
  const query = `
    SELECT uniqExact(session_id) AS sessions
    FROM clickinsight.events
    WHERE ${where}
      AND ${condition.expression}
  `.trim()
  const result = await client.query({
    query,
    query_params: { ...params, ...condition.params },
    format: 'JSONEachRow',
  })
  const rows = await result.json<Record<string, unknown>>()
  return { sessions: toNonNegativeCount(rows[0]?.sessions), warnings: [] }
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null
  return numerator / denominator
}

function dropRate(previous: number | null, current: number | null): number | null {
  const advanceRate = ratio(current, previous)
  return advanceRate === null ? null : 1 - advanceRate
}

function projectNodeStats(
  node: PathNode,
  index: number,
  lastIndex: number,
  reached: number | null,
  previous: number | null,
  triggerSessions: number,
): PathNode {
  if (reached === null) return { ...node, stats: [] }

  const stats: PathNode['stats'] = [
    { k: index === lastIndex ? '到達' : '通過', v: formatPathCount(reached) },
  ]
  if (index === lastIndex) {
    stats.push({ k: 'CV率', v: formatPathPercent(ratio(reached, triggerSessions), 1), tone: 'pos' })
  } else {
    stats.push({ k: '離脱', v: formatPathPercent(dropRate(previous, reached)), tone: 'neg' })
  }
  return { ...node, stats }
}

function projectBranch(branch: PathBranch, funnel: PathStatsStepResult, triggerSessions: number): BranchProjection {
  const nodeReached = funnel.reached.slice(1)
  const nodes = branch.nodes.map((node, index) =>
    projectNodeStats(
      node,
      index,
      branch.nodes.length - 1,
      nodeReached[index] ?? null,
      index === 0 ? funnel.reached[0] ?? null : nodeReached[index - 1] ?? null,
      triggerSessions,
    ),
  )
  const transitionDrops = nodeReached.map((reached, index) =>
    dropRate(index === 0 ? funnel.reached[0] ?? null : nodeReached[index - 1] ?? null, reached),
  )
  const edges = branch.nodes.slice(1).map((_, index) => {
    const previous = nodeReached[index] ?? null
    const current = nodeReached[index + 1] ?? null
    const advanceRate = ratio(current, previous)
    const drop = dropRate(previous, current)
    if (advanceRate === null || drop === null) return { label: '' }
    const band = edgeBandForDropRate(drop)
    return { label: `通過 ${formatPathPercent(advanceRate)}`, ...(band ? { band } : {}) }
  })
  const hasUnsupportedNode = nodeReached.some((reached) => reached === null)
  const cvRate = hasUnsupportedNode ? null : ratio(nodeReached.at(-1) ?? null, triggerSessions)

  return {
    cvRate,
    branch: {
      ...branch,
      nodes,
      edges,
      severity: rollupBranchSeverity(transitionDrops.filter((rate): rate is number => rate !== null)),
      summary: {
        ...branch.summary,
        cvRate: formatPathPercent(cvRate, 1),
        delta: '',
        deltaTone: 'pos',
      },
    },
  }
}

function withUnanalysedStats(pathSet: PathSet, reason: string, warnings: ReadonlyArray<string>): PathSet {
  return {
    ...pathSet,
    isDummy: false,
    evidence_level: 'planned',
    trigger: { ...pathSet.trigger, sessions: PATHS_UNANALYZED_VALUE },
    branches: pathSet.branches.map((branch) => ({
      ...branch,
      severity: 'ok',
      nodes: branch.nodes.map((node) => ({ ...node, stats: [] })),
      edges: branch.nodes.slice(1).map(() => ({ label: '' })),
      summary: { ...branch.summary, cvRate: PATHS_UNANALYZED_VALUE, delta: '', deltaTone: 'pos' },
    })),
    averageCvRate: PATHS_UNANALYZED_VALUE,
    evidence_data: {
      ...pathSet.evidence_data,
      pathStats: { statsComputed: false, reason, warnings: [...warnings] },
    },
  }
}

export async function computePathSetStats(
  client: ClickHouseClient,
  pathSet: PathSet,
  options: ComputePathSetStatsOptions = {},
): Promise<PathSet> {
  try {
    const trigger = await fetchTriggerSessions(client, {
      tenantId: pathSet.tenant_id,
      siteId: pathSet.site_id,
      periodDays: pathSet.trigger.periodDays,
      triggerUrl: pathSet.trigger.url,
    })
    if (trigger.sessions === 0 || trigger.warnings.length > 0) {
      return withUnanalysedStats(
        pathSet,
        trigger.warnings.length > 0 ? 'unsupported_trigger' : 'no_trigger_sessions',
        trigger.warnings,
      )
    }

    const funnels = await Promise.all(
      pathSet.branches.map((branch) =>
        computeBranchFunnel(client, {
          tenantId: pathSet.tenant_id,
          siteId: pathSet.site_id,
          periodDays: pathSet.trigger.periodDays,
          steps: [pathSet.trigger.url, ...branch.nodes.map((node) => node.url)],
          windowSeconds: options.windowSeconds,
        }),
      ),
    )
    const projections = pathSet.branches.map((branch, index) =>
      projectBranch(branch, funnels[index], trigger.sessions),
    )
    const cvRates = projections.flatMap((projection) =>
      projection.cvRate === null ? [] : [projection.cvRate],
    )
    const warnings = funnels.flatMap((funnel) => funnel.warnings)

    return {
      ...pathSet,
      isDummy: false,
      evidence_level: 'observed_approx',
      trigger: { ...pathSet.trigger, sessions: formatPathCount(trigger.sessions) },
      branches: projections.map((projection) => projection.branch),
      averageCvRate:
        cvRates.length > 0
          ? formatPathPercent(cvRates.reduce((sum, value) => sum + value, 0) / cvRates.length, 1)
          : PATHS_UNANALYZED_VALUE,
      evidence_data: {
        ...pathSet.evidence_data,
        pathStats: { statsComputed: true, warnings },
      },
    }
  } catch {
    return withUnanalysedStats(pathSet, 'clickhouse_error', ['ClickHouse query failed'])
  }
}
