/**
 * M-Director security (REQ-SEC-006) — scenario delivery kill-switch.
 *
 * STRIDE threat model finding: the runtime payload (incl. executable inline HTML) was served
 * with `Cache-Control: public, s-maxage=300, stale-while-revalidate=600`, so a poisoned or
 * compromised scenario would fan out via CDN for 5-15 minutes and an emergency edit could not
 * take effect until the cache expired.
 *
 * Fix (paired with `no-store` on the runtime route, see app/api/scenarios/runtime/route.ts):
 * an env-driven kill-switch the serve path consults on every request, INDEPENDENT of any
 * cache layer. Granularity:
 *   - global:        `SCENARIO_DELIVERY_DISABLED=1`           → disable all scenario delivery
 *   - per-tenant:    `SCENARIO_DELIVERY_DISABLED_TENANTS=a,b` → disable for listed tenant_ids
 *   - per-scenario:  `SCENARIO_DELIVERY_DISABLED_IDS=uuid,…`  → drop individual scenarios
 *
 * Because the runtime route is `no-store`, flipping any of these env vars takes effect on the
 * next request (no CDN TTL wait). Env is the chosen mechanism (no new KV/Redis dependency,
 * editable from the Vercel dashboard like the existing `AUDIT_DISABLED` kill-switch).
 */

function parseCsvEnv(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

/** Global kill-switch: when set, NO scenario is served to any tenant. */
export function isScenarioDeliveryGloballyDisabled(): boolean {
  return process.env.SCENARIO_DELIVERY_DISABLED === '1'
}

/** Per-tenant kill-switch: tenant_id present in `SCENARIO_DELIVERY_DISABLED_TENANTS`. */
export function isTenantDeliveryDisabled(tenantId: string): boolean {
  return parseCsvEnv(process.env.SCENARIO_DELIVERY_DISABLED_TENANTS).has(tenantId)
}

/** Per-scenario kill-switch: scenario id present in `SCENARIO_DELIVERY_DISABLED_IDS`. */
export function isScenarioDisabled(scenarioId: string): boolean {
  return parseCsvEnv(process.env.SCENARIO_DELIVERY_DISABLED_IDS).has(scenarioId)
}

/**
 * Convenience predicate for the serve path. Returns true if delivery for this
 * (tenant, scenario) is killed at ANY level (global / tenant / scenario).
 */
export function isDeliveryKilled(tenantId: string, scenarioId: string): boolean {
  return (
    isScenarioDeliveryGloballyDisabled() ||
    isTenantDeliveryDisabled(tenantId) ||
    isScenarioDisabled(scenarioId)
  )
}
