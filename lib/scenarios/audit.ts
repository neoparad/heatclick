/**
 * M-Director Stage 1 (続 M-7/M-8) — audit_events INSERT for scenarios CRUD
 *
 * Reference:
 *   - 続 M-7 §4 #5 (audit emit hook)
 *   - 続 M-7 §2.3 (Main Director 続 91 audit.py パターン JS 移植)
 *   - Main Director worker.ts L538-617 audit emit (続 88 §2)
 *
 * Pattern:
 *   - Fire-and-forget (no `await`), use `void` to keep API route response fast.
 *   - resp.ok 検証経路 (続 26/35 で確定の silent fail 撲滅)
 *   - CLICKHOUSE_URL 未設定なら no-op + log only
 */

import { performance } from 'node:perf_hooks'

export type ScenarioAuditAction =
  | 'scenario.created'
  | 'scenario.updated'
  | 'scenario.deleted'
  | 'scenario.published'
  | 'scenario.archived'

export interface ScenarioAuditEvent {
  action: ScenarioAuditAction
  tenant_id: string
  scenario_id: string
  user_id?: string // 'system' if not authenticated yet (Phase 1)
  metadata?: Record<string, unknown>
}

/**
 * Best-effort emit. Never throws; logs and returns false on failure to keep
 * the API route response fast (caller uses `void emitScenarioAudit(...)`).
 */
export async function emitScenarioAudit(event: ScenarioAuditEvent): Promise<boolean> {
  const url = process.env.CLICKHOUSE_URL
  const db = process.env.CLICKHOUSE_DB ?? 'clickinsight'
  if (!url) {
    // dev / test mode: log only
    // eslint-disable-next-line no-console
    console.info(
      `[audit no-op] action=${event.action} tenant=${event.tenant_id} scenario=${event.scenario_id}`,
    )
    return true
  }

  try {
    const { baseUrl, authHeader } = parseClickHouseUrl(url)
    const row = {
      tenant_id: event.tenant_id,
      user_id: event.user_id ?? 'system',
      action: event.action,
      resource: event.scenario_id,
      ip_anonymized: '',
      user_agent: 'm-director-scenarios-api/0.1.0',
      request_id: '',
      response_status: 200,
      plan_tier: 'Growth',
      metadata: JSON.stringify({
        ...(event.metadata ?? {}),
        emitted_at: new Date().toISOString(),
      }),
    }
    const body = JSON.stringify(row) + '\n'
    const insertUrl =
      `${baseUrl}/?database=${encodeURIComponent(db)}` +
      `&query=${encodeURIComponent('INSERT INTO audit_events FORMAT JSONEachRow')}` +
      `&input_format_skip_unknown_fields=1`

    const t0 = performance.now()
    const resp = await fetch(insertUrl, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    })
    const dt = (performance.now() - t0).toFixed(1)

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.error(
        `[scenario audit non-ok] status=${resp.status} action=${event.action} ` +
          `dur=${dt}ms body_head="${text.slice(0, 256)}"`,
      )
      return false
    }
    return true
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[scenario audit network error] action=${event.action} err=${(e as Error).message}`,
    )
    return false
  }
}

function parseClickHouseUrl(raw: string): { baseUrl: string; authHeader: string } {
  // raw = http://user:pass@host:port (続 91 audit.py と同 contract)
  const u = new URL(raw)
  const user = decodeURIComponent(u.username || 'default')
  const password = decodeURIComponent(u.password || '')
  u.username = ''
  u.password = ''
  const baseUrl = `${u.protocol}//${u.host}`
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  return { baseUrl, authHeader }
}
