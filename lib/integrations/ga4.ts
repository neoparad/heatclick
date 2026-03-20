// Google Analytics 4 Data API 連携
// デモグラフィック（年代・性別）× 行動データの取得
// BigQuery不要 — GA4 Data API のみで動作
// 認証: サービスアカウントのメアドをGA4プロパティに閲覧者追加するだけ

import { google, analyticsdata_v1beta } from 'googleapis'

export interface GA4Config {
  clientEmail: string
  privateKey: string
  propertyId: string // GA4 プロパティID（数字のみ。例: '123456789'）
}

// GA4のデモグラフィック × 行動セグメントデータ
export interface GA4DemographicSegment {
  ageBracket: string         // "18-24", "25-34", "35-44", "45-54", "55-64", "65+"
  gender: string             // "male", "female", "unknown"
  deviceCategory: string     // "desktop", "mobile", "tablet"
  sessions: number
  conversions: number
  cvr: number
  avgSessionDuration: number // 秒
  engagementRate: number     // 0-1
  screenPageViews: number
  screenPageViewsPerSession: number
}

// GA4のページ別デモグラデータ
export interface GA4PageDemographic {
  pagePath: string
  ageBracket: string
  gender: string
  sessions: number
  avgSessionDuration: number
  engagementRate: number
}

// GA4 Data API クライアントの作成
function createGA4Auth(config: GA4Config) {
  return new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  })
}

// GA4 Data API にレポートリクエストを送信する汎用関数
async function runGA4Report(
  config: GA4Config,
  body: analyticsdata_v1beta.Schema$RunReportRequest
): Promise<analyticsdata_v1beta.Schema$Row[]> {
  const auth = createGA4Auth(config)
  const client = google.analyticsdata({ version: 'v1beta', auth })

  const response = await client.properties.runReport({
    property: `properties/${config.propertyId}`,
    requestBody: body,
  } as any)

  return (response as any).data?.rows || []
}

// レスポンスの行からdimension/metric値を安全に抽出
function getDimValue(row: any, index: number): string {
  return row?.dimensionValues?.[index]?.value || 'unknown'
}

function getMetValue(row: any, index: number): number {
  return Number(row?.metricValues?.[index]?.value) || 0
}

// デモグラフィック × デバイス × 行動指標を取得
export async function fetchGA4DemographicSegments(
  config: GA4Config,
  startDate: string,
  endDate: string
): Promise<GA4DemographicSegment[]> {
  const rows = await runGA4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'userAgeBracket' },
      { name: 'userGender' },
      { name: 'deviceCategory' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'averageSessionDuration' },
      { name: 'engagementRate' },
      { name: 'screenPageViews' },
      { name: 'screenPageViewsPerSession' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: '500' as any,
  })

  return rows.map((row: any) => {
    const sessions = getMetValue(row, 0)
    const conversions = getMetValue(row, 1)
    return {
      ageBracket: getDimValue(row, 0),
      gender: getDimValue(row, 1),
      deviceCategory: getDimValue(row, 2),
      sessions,
      conversions,
      cvr: sessions > 0 ? (conversions / sessions) * 100 : 0,
      avgSessionDuration: getMetValue(row, 2),
      engagementRate: getMetValue(row, 3),
      screenPageViews: getMetValue(row, 4),
      screenPageViewsPerSession: getMetValue(row, 5),
    }
  })
}

// ページ別 × デモグラ別の行動データを取得
export async function fetchGA4PageDemographics(
  config: GA4Config,
  startDate: string,
  endDate: string
): Promise<GA4PageDemographic[]> {
  const rows = await runGA4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'pagePath' },
      { name: 'userAgeBracket' },
      { name: 'userGender' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'averageSessionDuration' },
      { name: 'engagementRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: '5000' as any,
  })

  return rows.map((row: any) => ({
    pagePath: getDimValue(row, 0),
    ageBracket: getDimValue(row, 1),
    gender: getDimValue(row, 2),
    sessions: getMetValue(row, 0),
    avgSessionDuration: getMetValue(row, 1),
    engagementRate: getMetValue(row, 2),
  }))
}

// 年代別 × 流入元別のCVR（広告最適化用）
export async function fetchGA4AgeSourceCV(
  config: GA4Config,
  startDate: string,
  endDate: string
): Promise<Array<{
  ageBracket: string
  source: string
  medium: string
  sessions: number
  conversions: number
  cvr: number
}>> {
  const rows = await runGA4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'userAgeBracket' },
      { name: 'sessionSource' },
      { name: 'sessionMedium' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: '500' as any,
  })

  return rows.map((row: any) => {
    const sessions = getMetValue(row, 0)
    const conversions = getMetValue(row, 1)
    return {
      ageBracket: getDimValue(row, 0),
      source: getDimValue(row, 1) || '(direct)',
      medium: getDimValue(row, 2) || '(none)',
      sessions,
      conversions,
      cvr: sessions > 0 ? (conversions / sessions) * 100 : 0,
    }
  })
}

// 興味関心カテゴリ × 行動
export async function fetchGA4InterestSegments(
  config: GA4Config,
  startDate: string,
  endDate: string
): Promise<Array<{
  interestCategory: string
  sessions: number
  conversions: number
  cvr: number
  avgSessionDuration: number
}>> {
  const rows = await runGA4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'brandingInterest' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'conversions' },
      { name: 'averageSessionDuration' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: '100' as any,
  })

  return rows.map((row: any) => {
    const sessions = getMetValue(row, 0)
    const conversions = getMetValue(row, 1)
    return {
      interestCategory: getDimValue(row, 0),
      sessions,
      conversions,
      cvr: sessions > 0 ? (conversions / sessions) * 100 : 0,
      avgSessionDuration: getMetValue(row, 2),
    }
  })
}

// ペルソナ統合用: デモグラ集計 + 行動統計をまとめて取得
// ClickHouseの行動ペルソナと統計的マッチングするための素材
export async function fetchGA4PersonaData(
  config: GA4Config,
  startDate: string,
  endDate: string
): Promise<{
  demographics: GA4DemographicSegment[]
  pageDemographics: GA4PageDemographic[]
  interestSegments: Awaited<ReturnType<typeof fetchGA4InterestSegments>>
}> {
  const [demographics, pageDemographics, interestSegments] = await Promise.all([
    fetchGA4DemographicSegments(config, startDate, endDate),
    fetchGA4PageDemographics(config, startDate, endDate),
    fetchGA4InterestSegments(config, startDate, endDate),
  ])

  return { demographics, pageDemographics, interestSegments }
}
