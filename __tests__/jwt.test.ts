import { signToken, verifyToken, extractToken, authenticateRequest, JWTPayload } from '@/lib/jwt'

describe('JWT', () => {
  const testPayload: JWTPayload = {
    sub: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    plan: 'free',
  }

  describe('signToken', () => {
    it('should generate a valid JWT string', async () => {
      const token = await signToken(testPayload)
      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')
      expect(token.split('.')).toHaveLength(3) // header.payload.signature
    })
  })

  describe('verifyToken', () => {
    it('should verify a valid token and return payload', async () => {
      const token = await signToken(testPayload)
      const payload = await verifyToken(token)

      expect(payload).not.toBeNull()
      expect(payload!.sub).toBe('user-123')
      expect(payload!.email).toBe('test@example.com')
      expect(payload!.name).toBe('Test User')
      expect(payload!.plan).toBe('free')
    })

    it('should return null for an invalid token', async () => {
      const payload = await verifyToken('invalid.token.here')
      expect(payload).toBeNull()
    })

    it('should return null for an empty string', async () => {
      const payload = await verifyToken('')
      expect(payload).toBeNull()
    })

    it('should return null for a tampered token', async () => {
      const token = await signToken(testPayload)
      const tampered = token.slice(0, -5) + 'XXXXX'
      const payload = await verifyToken(tampered)
      expect(payload).toBeNull()
    })
  })

  describe('extractToken', () => {
    it('should extract token from Authorization header', () => {
      const request = new Request('http://localhost', {
        headers: { Authorization: 'Bearer my-token-123' },
      })
      expect(extractToken(request)).toBe('my-token-123')
    })

    it('should extract token from cookie', () => {
      const request = new Request('http://localhost', {
        headers: { cookie: 'ugokimap_token=cookie-token-456; other=value' },
      })
      expect(extractToken(request)).toBe('cookie-token-456')
    })

    it('should prefer Authorization header over cookie', () => {
      const request = new Request('http://localhost', {
        headers: {
          Authorization: 'Bearer header-token',
          cookie: 'ugokimap_token=cookie-token',
        },
      })
      expect(extractToken(request)).toBe('header-token')
    })

    it('should return null when no token present', () => {
      const request = new Request('http://localhost')
      expect(extractToken(request)).toBeNull()
    })

    it('should return null for non-Bearer auth header', () => {
      const request = new Request('http://localhost', {
        headers: { Authorization: 'Basic abc123' },
      })
      expect(extractToken(request)).toBeNull()
    })
  })

  describe('authenticateRequest', () => {
    it('should authenticate a request with valid Bearer token', async () => {
      const token = await signToken(testPayload)
      const request = new Request('http://localhost', {
        headers: { Authorization: `Bearer ${token}` },
      })

      const payload = await authenticateRequest(request)
      expect(payload).not.toBeNull()
      expect(payload!.sub).toBe('user-123')
    })

    it('should return null for request without token', async () => {
      const request = new Request('http://localhost')
      const payload = await authenticateRequest(request)
      expect(payload).toBeNull()
    })
  })
})
