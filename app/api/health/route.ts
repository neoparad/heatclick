import { NextResponse } from 'next/server'
import { testClickHouseConnection, isClickHouseConnected, getConnectionError } from '@/lib/clickhouse'

export async function GET() {
  const clickHouseTest = await testClickHouseConnection()
  const isConnected = await isClickHouseConnected()
  const connectionError = getConnectionError()
  
  // 環境変数の確認（パスワードは表示しない）
  const envCheck = {
    CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST || 'not set (using default: localhost)',
    CLICKHOUSE_PORT: process.env.CLICKHOUSE_PORT || 'not set (using default: 8123)',
    CLICKHOUSE_USER: process.env.CLICKHOUSE_USER || process.env.CLICKHOUSE_USERNAME || 'not set (using default: default)',
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ? '***set***' : 'not set',
    CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE || 'not set (using default: clickinsight)',
    CLICKHOUSE_URL: process.env.CLICKHOUSE_URL || 'not set',
  }
  
  return NextResponse.json({
    status: isConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'ClickInsight Pro API',
    version: '1.0.0',
    clickhouse: {
      connected: clickHouseTest.connected,
      error: clickHouseTest.error,
      errorDetails: clickHouseTest.errorDetails,
      connectionError: connectionError ? {
        message: connectionError.message,
        name: connectionError.name,
      } : null,
      config: clickHouseTest.config ? {
        url: clickHouseTest.config.url,
        database: clickHouseTest.config.database,
        username: clickHouseTest.config.username,
        host: clickHouseTest.config.host,
        port: clickHouseTest.config.port,
      } : undefined,
      environment: envCheck,
    },
    health: {
      clickhouse: isConnected ? 'healthy' : 'unhealthy',
      overall: isConnected ? 'healthy' : 'degraded',
    },
    recommendations: !clickHouseTest.connected ? [
      'Check if ClickHouse server is running',
      'Verify CLICKHOUSE_HOST and CLICKHOUSE_PORT environment variables',
      'Verify CLICKHOUSE_USER and CLICKHOUSE_PASSWORD are correct',
      'Check network connectivity to ClickHouse server',
      'Review ClickHouse server logs for connection errors',
    ] : [],
  })
}
