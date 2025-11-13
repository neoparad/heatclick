// Google Search Console API連携
// 検索クエリデータの取得とヒートマップ連携

import { google } from 'googleapis'

export interface GSCConfig {
  clientEmail: string
  privateKey: string
  siteUrl: string // 例: 'sc-domain:example.com' または 'https://example.com'
}

export interface GSCQueryData {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  date: string
  device: 'DESKTOP' | 'MOBILE' | 'TABLET'
}

// Google Search Console APIクライアントの作成
function createGSCClient(config: GSCConfig) {
  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  })

  return google.searchconsole({ version: 'v1', auth })
}

// GSCから検索クエリデータを取得
export async function fetchGSCQueryData(
  config: GSCConfig,
  startDate: string,
  endDate: string,
  dimensions: string[] = ['query', 'page', 'device']
): Promise<GSCQueryData[]> {
  try {
    const client = createGSCClient(config)

    const response = await client.searchanalytics.query({
      siteUrl: config.siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions,
        rowLimit: 25000, // 最大25,000行
        startRow: 0,
      },
    })

    const rows = response.data.rows || []
    const results: GSCQueryData[] = []

    for (const row of rows) {
      const keys = row.keys || []
      const query = keys[0] || ''
      const page = keys[1] || ''
      const device = (keys[2] || 'DESKTOP') as 'DESKTOP' | 'MOBILE' | 'TABLET'

      results.push({
        query,
        page,
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        position: row.position || 0,
        date: startDate, // 日次データの場合は個別に取得が必要
        device,
      })
    }

    return results
  } catch (error) {
    console.error('GSC API Error:', error)
    throw error
  }
}

// 日次データを取得（日付ごとに分割）
export async function fetchGSCDailyData(
  config: GSCConfig,
  startDate: string,
  endDate: string
): Promise<GSCQueryData[]> {
  const results: GSCQueryData[] = []
  const start = new Date(startDate)
  const end = new Date(endDate)

  // 日付ごとにループ（GSC APIは最大90日間のデータを取得可能）
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0]
    
    try {
      const dailyData = await fetchGSCQueryData(config, dateStr, dateStr, ['query', 'page', 'device'])
      // 日付を設定
      dailyData.forEach(item => {
        item.date = dateStr
      })
      results.push(...dailyData)
    } catch (error) {
      console.error(`Error fetching GSC data for ${dateStr}:`, error)
    }
  }

  return results
}

// クエリとページの組み合わせでデータを取得
export async function fetchGSCQueryPageData(
  config: GSCConfig,
  startDate: string,
  endDate: string
): Promise<GSCQueryData[]> {
  return fetchGSCQueryData(config, startDate, endDate, ['query', 'page', 'device'])
}

// 特定のクエリのデータを取得
export async function fetchGSCDataByQuery(
  config: GSCConfig,
  query: string,
  startDate: string,
  endDate: string
): Promise<GSCQueryData[]> {
  const allData = await fetchGSCQueryPageData(config, startDate, endDate)
  return allData.filter(item => item.query.toLowerCase().includes(query.toLowerCase()))
}

// 特定のページのデータを取得
export async function fetchGSCDataByPage(
  config: GSCConfig,
  page: string,
  startDate: string,
  endDate: string
): Promise<GSCQueryData[]> {
  const allData = await fetchGSCQueryPageData(config, startDate, endDate)
  return allData.filter(item => item.page === page)
}







