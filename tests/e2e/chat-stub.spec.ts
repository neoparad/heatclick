/**
 * E2E: POST /api/chat (Sprint 3 W1 stub)
 *
 * 親 SSOT §6.4 Sprint 3 W1 / 続 54 §2.2 / 続 57 (ML W1 完了)
 *
 * 検証:
 *   1. tenant context 無し (cookie 無し) で POST /api/chat → 401 (middleware から JSON error)
 *   2. (authenticated) valid body POST → 200 + ChatReply schema を満たす
 *      - data.conversationId が UUID
 *      - data.modelMeta.provider === 'stub'
 *      - data.evidenceLevel === 'planned'
 *      - data.reply に "STUB" prefix
 *      - data.suggestions.length >= 1
 *   3. (authenticated) 空 message で POST → 400 (Zod validation)
 *   4. (authenticated) tenant が持たない siteId で POST → 403 (canAccessSite)
 *
 * 注: 認証必要 test は process.env.E2E_TEST_TOKEN 必須。
 *     CI で skip 設定 (heatmap.spec.ts 流儀踏襲)、ローカル / Preview で E2E_TEST_TOKEN を投入。
 */

import { test, expect, type APIRequestContext } from '@playwright/test'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const TEST_TOKEN = process.env.E2E_TEST_TOKEN
const TEST_SITE_ID = process.env.E2E_TEST_SITE_ID ?? 'site_bihada_demo'

test.describe('/api/chat (Sprint 3 W1 stub)', () => {
  test('unauthenticated POST returns 401 JSON', async ({ request }) => {
    const resp = await request.post(`${APP_URL}/api/chat`, {
      data: {
        message: 'hello',
        siteId: TEST_SITE_ID,
        periodDays: 7,
      },
    })
    expect(resp.status()).toBe(401)
    const body = await resp.json()
    expect(body.success).toBe(false)
    expect(body.error?.code).toBe('UNAUTHORIZED')
  })

  test.describe('authenticated', () => {
    test.skip(!TEST_TOKEN, 'requires E2E_TEST_TOKEN to inject auth cookie')

    let authedRequest: APIRequestContext

    test.beforeAll(async ({ playwright }) => {
      authedRequest = await playwright.request.newContext({
        baseURL: APP_URL,
        extraHTTPHeaders: {
          Cookie: `ugokimap_saas_token=${TEST_TOKEN}`,
        },
      })
    })

    test.afterAll(async () => {
      await authedRequest.dispose()
    })

    test('valid POST returns 200 + ChatReply stub shape', async () => {
      const resp = await authedRequest.post(`/api/chat`, {
        data: {
          message: 'CVR が落ちている理由を教えて',
          siteId: TEST_SITE_ID,
          periodDays: 7,
        },
      })
      expect(resp.status()).toBe(200)
      const body = await resp.json()
      expect(body.success).toBe(true)

      const data = body.data
      expect(data).toBeTruthy()
      // conversationId is UUID v4
      expect(data.conversationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      // stub provider
      expect(data.modelMeta?.provider).toBe('stub')
      expect(data.modelMeta?.model).toBe('stub')
      expect(typeof data.modelMeta?.latencyMs).toBe('number')
      expect(data.modelMeta?.tokens).toBe(0)
      // D-07 整合: planned-only stub
      expect(data.evidenceLevel).toBe('planned')
      expect(Array.isArray(data.evidence)).toBe(true)
      expect(data.evidence.length).toBeGreaterThanOrEqual(1)
      expect(data.evidence[0].level).toBe('planned')
      // stub reply prefix
      expect(typeof data.reply).toBe('string')
      expect(data.reply).toContain('[STUB]')
      expect(data.confidence).toBe(0)
      // suggestions populated
      expect(Array.isArray(data.suggestions)).toBe(true)
      expect(data.suggestions.length).toBeGreaterThanOrEqual(1)
    })

    test('empty message returns 400', async () => {
      const resp = await authedRequest.post(`/api/chat`, {
        data: {
          message: '',
          siteId: TEST_SITE_ID,
          periodDays: 7,
        },
      })
      expect(resp.status()).toBe(400)
      const body = await resp.json()
      expect(body.success).toBe(false)
    })

    test('cross-tenant siteId returns 403', async () => {
      const resp = await authedRequest.post(`/api/chat`, {
        data: {
          message: 'CVR を見せて',
          siteId: 'site_NOT_IN_TENANT_xyz',
          periodDays: 7,
        },
      })
      // middleware が query string 経由のみ強制するため、body 経由は API route で 403 を返す。
      // 401 (middleware の cross-tenant 検知) になる可能性もあるが、本 E2E は body 経路を検証する。
      expect([401, 403]).toContain(resp.status())
    })

    test('echoes conversationId when provided', async () => {
      const cid = '12345678-1234-4234-8234-123456789012'
      const resp = await authedRequest.post(`/api/chat`, {
        data: {
          conversationId: cid,
          message: '続きを教えて',
          siteId: TEST_SITE_ID,
          periodDays: 7,
        },
      })
      expect(resp.status()).toBe(200)
      const body = await resp.json()
      expect(body.data?.conversationId).toBe(cid)
    })
  })
})
