import { ClickHouseClient, createClient } from '@clickhouse/client'
import type { ClickHouseConfig } from './types'

// ClickHouseクライアントの設定
export function getClickHouseConfig(): ClickHouseConfig {
  const host = process.env.CLICKHOUSE_HOST || 'localhost'
  const port = process.env.CLICKHOUSE_PORT || '8123'
  const username = process.env.CLICKHOUSE_USER || process.env.CLICKHOUSE_USERNAME || 'default'
  const password = process.env.CLICKHOUSE_PASSWORD || ''
  const database = process.env.CLICKHOUSE_DATABASE || 'clickinsight'
  const url = process.env.CLICKHOUSE_URL || `http://${host}:${port}`

  return {
    url,
    username,
    password,
    database,
    request_timeout: 30000,
    max_open_connections: 10,
  }
}

let clickhouse: ClickHouseClient | null = null
let connectionError: Error | null = null
let lastConnectionTest: Date | null = null
const CONNECTION_TEST_INTERVAL = 60000

function getClickHouseClient(): ClickHouseClient {
  if (!clickhouse) {
    try {
      const config = getClickHouseConfig()
      clickhouse = createClient({
        url: config.url,
        username: config.username,
        password: config.password,
        database: config.database,
        request_timeout: config.request_timeout,
        max_open_connections: config.max_open_connections,
      })
      connectionError = null
      console.log('ClickHouse client initialized:', {
        url: config.url,
        database: config.database,
        username: config.username,
        passwordSet: !!config.password,
      })
    } catch (error) {
      connectionError = error as Error
      console.error('Failed to initialize ClickHouse client:', error)
      throw error
    }
  }
  return clickhouse
}

export function resetClickHouseConnection(): void {
  if (clickhouse) {
    try { clickhouse.close() } catch (error) {
      console.error('Error closing ClickHouse connection:', error)
    }
  }
  clickhouse = null
  connectionError = null
  lastConnectionTest = null
}

export async function testClickHouseConnection(): Promise<{
  connected: boolean
  error?: string
  errorDetails?: { code: string; message: string; stack?: string }
  config?: { url: string; database: string; username: string; host?: string; port?: string }
}> {
  try {
    const config = getClickHouseConfig()
    const testClient = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      request_timeout: 10000,
    })

    await testClient.query({ query: 'SELECT 1 as test', format: 'JSONEachRow' })
    await testClient.close()

    if (clickhouse) resetClickHouseConnection()
    lastConnectionTest = new Date()
    connectionError = null

    return {
      connected: true,
      config: {
        url: config.url,
        database: config.database,
        username: config.username,
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: process.env.CLICKHOUSE_PORT || '8123',
      },
    }
  } catch (error: any) {
    const config = getClickHouseConfig()
    const errorMessage = error?.message || String(error)
    console.error('ClickHouse connection test failed:', { message: errorMessage, code: error?.code, url: config.url })
    connectionError = error as Error
    lastConnectionTest = new Date()

    return {
      connected: false,
      error: errorMessage,
      errorDetails: { code: error?.code || 'UNKNOWN', message: errorMessage, stack: error?.stack },
      config: {
        url: config.url,
        database: config.database,
        username: config.username,
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: process.env.CLICKHOUSE_PORT || '8123',
      },
    }
  }
}

export function getConnectionError(): Error | null {
  return connectionError
}

export async function getClickHouseClientAsync(): Promise<ClickHouseClient> {
  try {
    const client = getClickHouseClient()
    const now = new Date()
    if (!lastConnectionTest || (now.getTime() - lastConnectionTest.getTime()) > CONNECTION_TEST_INTERVAL) {
      try {
        await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
        lastConnectionTest = now
        connectionError = null
      } catch (testError: any) {
        console.warn('ClickHouse connection test failed, resetting client:', testError?.message)
        resetClickHouseConnection()
        return getClickHouseClient()
      }
    }
    return client
  } catch (error) {
    console.error('ClickHouse client not available:', error)
    connectionError = error as Error
    throw error
  }
}

export async function isClickHouseConnected(): Promise<boolean> {
  try {
    const client = await getClickHouseClientAsync()
    await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    return true
  } catch (error: any) {
    console.warn('ClickHouse connection check failed:', error?.message)
    return false
  }
}

export { getClickHouseClient }
