// テスト環境のセットアップ
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only'
;(process.env as Record<string, string>).NODE_ENV = 'test'
