/**
 * Incident notification (Slack Webhook 経由)
 *
 * 親 SSOT §7.6 緊急エスカレ (Round 10 Fix 1 反映)
 * Sprint 0 で skeleton、Sprint 1 で本番運用。
 *
 * Slack #incident-prod channel に自動 post (1 分以内通知の自動化部分)。
 */

type IncidentLevel = 'P0' | 'P1' | 'P2' | 'P3'

interface IncidentPayload {
  level: IncidentLevel
  title: string
  description: string
  affected_resource?: string  // e.g., 'API /api/heatmap', 'ClickHouse', 'Stripe webhook'
  tenant_id?: string
  source: 'sentry' | 'health-check' | 'stripe' | 'manual' | 'other'
  detected_at?: Date
  detected_by?: string
}

const SLACK_WEBHOOK_INCIDENT = process.env.SLACK_WEBHOOK_INCIDENT
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ugokimap.com'

const LEVEL_EMOJI: Record<IncidentLevel, string> = {
  P0: '🔴',
  P1: '🟠',
  P2: '🟡',
  P3: '🟢',
}

const LEVEL_COLOR: Record<IncidentLevel, string> = {
  P0: '#dc2626',
  P1: '#ea580c',
  P2: '#ca8a04',
  P3: '#16a34a',
}

/**
 * Slack #incident-prod へ自動 post
 *
 * § 7.6.2 P0 通知タイムライン T+1m 用。
 * 失敗時は Email fallback (Resend)、Email も失敗時は Sentry breadcrumb 残す。
 */
export async function notifyIncident(payload: IncidentPayload): Promise<{ success: boolean; error?: string }> {
  const detectedAt = payload.detected_at ?? new Date()
  const message = formatSlackMessage(payload, detectedAt)

  if (!SLACK_WEBHOOK_INCIDENT) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('[incident] SLACK_WEBHOOK_INCIDENT not set, message:', message)
    }
    return await emailFallback(payload, detectedAt)
  }

  try {
    const res = await fetch(SLACK_WEBHOOK_INCIDENT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    })
    if (!res.ok) {
      // Slack 失敗 → Email fallback
      return await emailFallback(payload, detectedAt)
    }
    return { success: true }
  } catch (err) {
    // ネットワークエラー → Email fallback
    return await emailFallback(payload, detectedAt)
  }
}

function formatSlackMessage(p: IncidentPayload, detectedAt: Date): unknown {
  const emoji = LEVEL_EMOJI[p.level]
  const color = LEVEL_COLOR[p.level]
  return {
    text: `${emoji} ${p.level} — ${p.title}`,
    attachments: [
      {
        color,
        fields: [
          { title: '発生時刻', value: detectedAt.toISOString(), short: true },
          { title: '影響範囲', value: p.affected_resource ?? '調査中', short: true },
          { title: 'ソース', value: p.source, short: true },
          { title: 'tenant_id', value: p.tenant_id ?? 'N/A', short: true },
          { title: '詳細', value: p.description, short: false },
        ],
        footer: 'UGOKI MAP Incident Notifier',
        ts: Math.floor(detectedAt.getTime() / 1000),
      },
    ],
  }
}

async function emailFallback(p: IncidentPayload, detectedAt: Date): Promise<{ success: boolean; error?: string }> {
  // Resend は別 import、循環参照避けるため dynamic import
  try {
    const { getResend } = await import('@/lib/resend')
    const result = await getResend().emails.send({
      from: process.env.EMAIL_FROM ?? 'noreply@ugokimap.com',
      to: process.env.EMAIL_SUPPORT ?? 'support@ugokimap.com',
      subject: `${LEVEL_EMOJI[p.level]} ${p.level} — ${p.title}`,
      html: `
        <h2>${LEVEL_EMOJI[p.level]} ${p.level} Incident</h2>
        <p><strong>発生時刻</strong>: ${detectedAt.toISOString()}</p>
        <p><strong>影響範囲</strong>: ${p.affected_resource ?? '調査中'}</p>
        <p><strong>ソース</strong>: ${p.source}</p>
        <p><strong>tenant_id</strong>: ${p.tenant_id ?? 'N/A'}</p>
        <hr>
        <p><strong>詳細</strong></p>
        <pre>${p.description}</pre>
        <hr>
        <p><a href="${APP_URL}/admin/incidents">管理画面で確認</a></p>
      `,
    })
    return result.error ? { success: false, error: result.error.message } : { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Email fallback failed',
    }
  }
}
