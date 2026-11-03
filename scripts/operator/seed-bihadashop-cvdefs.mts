import { readFileSync } from 'node:fs'

import { getClickHouseClient } from '../../lib/clickhouse'
import { buildCvKeyResolutionPredicate, buildCvPredicate } from '../../lib/conversions/predicate'
import {
  createCvDefinitionRepository,
  type CreateCvDefinitionInput,
} from '../../lib/conversions/repository'
import { computeCvStats } from '../../lib/conversions/stats-query'
import type { CvDefinition, CvTrigger } from '../../lib/conversions/types'

const TENANT_ID = 'linkth_internal'
const SITE_ID = 'CIP_EcwUTHEZdIOAUqum'
const CREATED_BY = 'operator_seed_c1f'
const VERIFY_START = '2025-11-01 00:00:00'
const TUNNEL_URL = process.env.CV_SEED_CLICKHOUSE_URL ?? 'https://ch.bihadashop.jp'

const SEEDS: ReadonlyArray<CreateCvDefinitionInput> = [
  {
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    name: '楽天アフィリ送客',
    cvKey: 'affiliate_rakuten',
    enabled: true,
    trigger: { kind: 'click', conditions: { hrefHosts: ['rakuten.co.jp'] } },
    value: { mode: 'none' },
    created_by: CREATED_BY,
  },
  {
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    name: 'Amazonアフィリ送客',
    cvKey: 'affiliate_amazon',
    enabled: true,
    trigger: { kind: 'click', conditions: { hrefHosts: ['amazon.co.jp', 'amzn.to'] } },
    value: { mode: 'none' },
    created_by: CREATED_BY,
  },
  {
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    name: 'Qoo10アフィリ送客',
    cvKey: 'affiliate_qoo10',
    enabled: true,
    trigger: { kind: 'click', conditions: { hrefHosts: ['qoo10.jp'] } },
    value: { mode: 'none' },
    created_by: CREATED_BY,
  },
  {
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    name: 'その他アフィリ送客 (ASP)',
    cvKey: 'affiliate_other',
    enabled: true,
    trigger: { kind: 'click', conditions: { hrefHosts: ['a8.net', 'felmat.net'] } },
    value: { mode: 'none' },
    created_by: CREATED_BY,
  },
]

function loadEnvFile(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!match || match[1] in process.env) continue
    const raw = match[2]
    process.env[match[1]] =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw
  }
}

function mergeParams(...paramsList: ReadonlyArray<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...paramsList)
}

function predicateInput(seed: CreateCvDefinitionInput): { trigger: CvTrigger; cvKey: string } {
  return { trigger: seed.trigger, cvKey: seed.cvKey }
}

function seedPlan(existing: ReadonlyArray<CvDefinition>): {
  create: ReadonlyArray<CreateCvDefinitionInput>
  skip: ReadonlyArray<string>
} {
  const existingKeys = new Set(existing.map((definition) => definition.cvKey))
  return {
    create: SEEDS.filter((seed) => !existingKeys.has(seed.cvKey)),
    skip: SEEDS.filter((seed) => existingKeys.has(seed.cvKey)).map((seed) => seed.cvKey),
  }
}

async function runChVerification(): Promise<void> {
  process.env.CLICKHOUSE_URL = TUNNEL_URL
  const client = getClickHouseClient('analytics_reader')

  const targets = SEEDS.map((seed, index) => ({
    id: `seed-${index + 1}`,
    cvKey: seed.cvKey,
    trigger: seed.trigger,
  }))
  const recentStats = await computeCvStats(client, targets, { tenantId: TENANT_ID, siteId: SITE_ID, periodDays: 30 })
  console.log('CH computeCvStats (last 30 days):', JSON.stringify(recentStats))

  const monthlyParts = SEEDS.map((seed, index) => {
    const definition = predicateInput(seed)
    const rule = buildCvPredicate(definition, `rule${index}`)
    const union = buildCvKeyResolutionPredicate(definition, `union${index}`)
    return {
      cvKey: seed.cvKey,
      rule,
      union,
      select: `
        uniqExactIf(session_id, (${rule.expr})) AS rule_sessions,
        uniqExactIf(session_id, ifNull(conversion_type, '') = {label${index}:String}) AS label_sessions,
        uniqExactIf(session_id, (${union.expr})) AS union_sessions`,
      params: { ...rule.params, ...union.params, [`label${index}`]: seed.cvKey },
    }
  })
  const monthlyQuery = `
    SELECT toStartOfMonth(timestamp) AS month,
      ${monthlyParts.map((part) => `${part.select} /* ${part.cvKey} */`).join(',\n      ')}
    FROM clickinsight.events
    WHERE tenant_id = {tenant_id:String}
      AND site_id = {site_id:String}
      AND is_agent = 0
      AND timestamp >= toDateTime({start:String})
    GROUP BY month
    ORDER BY month`
  const monthlyResult = await client.query({
    query: monthlyQuery,
    query_params: {
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
      start: VERIFY_START,
      ...mergeParams(...monthlyParts.map((part) => part.params)),
    },
    format: 'JSONEachRow',
  })
  console.log('CH monthly rule/label/union comparison:', JSON.stringify(await monthlyResult.json()))

  const affiliateParts = SEEDS.map((seed, index) => buildCvPredicate(predicateInput(seed), `affiliate${index}`))
  const affiliateExpr = affiliateParts.map((part) => `(${part.expr})`).join(' OR ')
  const affiliateEventTypes = await client.query({
    query: `
      SELECT ifNull(event_type, '') AS event_type, count() AS n
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND is_agent = 0
        AND timestamp >= toDateTime({start:String})
        AND (${affiliateExpr})
      GROUP BY event_type
      ORDER BY n DESC`,
    query_params: {
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
      start: VERIFY_START,
      ...mergeParams(...affiliateParts.map((part) => part.params)),
    },
    format: 'JSONEachRow',
  })
  console.log('CH affiliate event_type distribution:', JSON.stringify(await affiliateEventTypes.json()))

  const negative = buildCvPredicate(
    { trigger: { kind: 'click', conditions: { hrefHosts: ['example-nonexistent.test'] } }, cvKey: 'negative' },
    'negative',
  )
  const negativeResult = await client.query({
    query: `
      SELECT count() AS n
      FROM clickinsight.events
      WHERE tenant_id = {tenant_id:String}
        AND site_id = {site_id:String}
        AND is_agent = 0
        AND (${negative.expr})`,
    query_params: { tenant_id: TENANT_ID, site_id: SITE_ID, ...negative.params },
    format: 'JSONEachRow',
  })
  console.log('CH negative host count:', JSON.stringify(await negativeResult.json()))
}

async function main(): Promise<void> {
  loadEnvFile('.env.local')
  const apply = process.argv.includes('--apply')
  const repository = createCvDefinitionRepository()
  const existing = await repository.listCvDefinitions(TENANT_ID, SITE_ID)
  const plan = seedPlan(existing)

  console.log(`CV seed target: tenant=${TENANT_ID} site=${SITE_ID}`)
  console.log('Existing cvKeys:', JSON.stringify(existing.map((definition) => definition.cvKey)))
  console.log('Plan create:', JSON.stringify(plan.create.map((seed) => seed.cvKey)))
  console.log('Plan skip:', JSON.stringify(plan.skip))
  console.log(`Mode: ${apply ? '--apply (KV write enabled)' : 'dry-run (no KV write)'}`)

  await runChVerification()

  if (!apply) return
  for (const seed of plan.create) {
    const created = await repository.createCvDefinition(seed)
    console.log(`Created cvKey=${created.cvKey} id=${created.id}`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error'
  console.error(`seed-bihadashop-cvdefs failed: ${message}`)
  process.exitCode = 1
})
