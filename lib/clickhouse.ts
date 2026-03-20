// Re-export all from split modules for backward compatibility
// All existing `import { ... } from '@/lib/clickhouse'` continue to work

export {
  getClickHouseClient,
  getClickHouseClientAsync,
  resetClickHouseConnection,
  testClickHouseConnection,
  getConnectionError,
  isClickHouseConnected,
  getClickHouseConfig,
} from './clickhouse/client'

export {
  insertClickEvent,
  getClickEvents,
  getHeatmapData,
  getStatistics,
  getTrafficSources,
} from './clickhouse/queries'

export { initializeDatabase } from './clickhouse/schema'

export type {
  ClickEvent,
  ClickHouseConfig,
  ClickHouseClient,
  CountRow,
  TotalSessionsRow,
  StatisticsRow,
  SessionStatsRow,
  EventBufferItem,
  UserRow,
} from './clickhouse/types'
