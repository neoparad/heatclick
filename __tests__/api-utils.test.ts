import { NextRequest } from 'next/server'
import { getAuthContext, buildCorsHeaders, buildTrackingCorsHeaders, apiError, unauthorized, forbidden, badRequest, notFound } from '@/lib/api-utils'

// NextRequest ヘルパー
function createRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', { headers })
}

describe('getAuthContext', () => {
  it('should return auth context when x-user-id header present', () => {
    const request = createRequest({
      'x-user-id': 'user-123',
      'x-user-email': 'test@example.com',
      'x-user-plan': 'professional',
    })
    const auth = getAuthContext(request)

    expect(auth).not.toBeNull()
    expect(auth!.userId).toBe('user-123')
    expect(auth!.email).toBe('test@example.com')
    expect(auth!.plan).toBe('professional')
  })

  it('should return null when x-user-id header missing', () => {
    const request = createRequest({ 'x-user-email': 'test@example.com' })
    expect(getAuthContext(request)).toBeNull()
  })

  it('should default plan to free', () => {
    const request = createRequest({ 'x-user-id': 'user-123' })
    const auth = getAuthContext(request)
    expect(auth!.plan).toBe('free')
  })

  it('should default email to empty string', () => {
    const request = createRequest({ 'x-user-id': 'user-123' })
    const auth = getAuthContext(request)
    expect(auth!.email).toBe('')
  })
})

describe('CORS headers', () => {
  it('buildCorsHeaders should restrict origin for management APIs', () => {
    const request = createRequest({ origin: 'https://evil.com' })
    const headers = buildCorsHeaders(request) as Record<string, string>
    // evil.com はホワイトリストにないので空文字
    expect(headers['Access-Control-Allow-Origin']).toBe('')
  })

  it('buildCorsHeaders should allow localhost in dev', () => {
    const request = createRequest({ origin: 'http://localhost:3000' })
    const headers = buildCorsHeaders(request) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  it('buildTrackingCorsHeaders should allow any origin', () => {
    const request = createRequest({ origin: 'https://any-site.com' })
    const headers = buildTrackingCorsHeaders(request) as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('https://any-site.com')
  })
})

describe('Error responses', () => {
  it('unauthorized should return 401', () => {
    const res = unauthorized()
    expect(res.status).toBe(401)
  })

  it('forbidden should return 403', () => {
    const res = forbidden()
    expect(res.status).toBe(403)
  })

  it('badRequest should return 400', () => {
    const res = badRequest('Invalid input')
    expect(res.status).toBe(400)
  })

  it('notFound should return 404', () => {
    const res = notFound()
    expect(res.status).toBe(404)
  })

  it('apiError should include error code', async () => {
    const res = apiError('Something failed', 500)
    const body = await res.json()
    expect(body.error).toBe('Something failed')
    expect(body.code).toBe('INTERNAL_ERROR')
  })
})
