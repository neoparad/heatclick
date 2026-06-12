/**
 * Heatmap element-level API client (続123: 本物のホットスポット / シグナル)
 *
 * `/api/heatmap/elements` から「要素単位のクリック集計」と「行動シグナル (rage/dead)」を取得する。
 * 座標系: x は 1280 正規化 (tile API の click と同一)、y は document 絶対 CSS px。
 * view-model 側で coordinateContext により capture CSS px 空間へスケールする。
 */

export interface HeatmapElementStat {
  /** DOM selector (tracking.js が記録した element_selector) */
  selector: string
  /** 要素の表示テキスト (空のことあり) */
  text: string
  /** tag name (a / button / label / img 等、空のことあり) */
  tag: string
  /** リンク要素の href (空のことあり) */
  href: string
  clicks: number
  sessions: number
  /** 平均クリック位置 x (1280 正規化) */
  x: number
  /** 平均クリック位置 y (document 絶対 CSS px) */
  y: number
}

export type HeatmapSignalType = 'rage' | 'dead'

export interface HeatmapSignalStat {
  type: HeatmapSignalType
  /** ページ全体の発生回数 */
  count: number
  /** ページ全体の発生セッション数 */
  sessions: number
  /** selector 別の上位発生箇所 (マーカー描画 + whereLabel 用) */
  top: Array<{
    selector: string
    text: string
    count: number
    x: number
    y: number
  }>
}

/**
 * 続126 ⑤: 画像視認率 (image_visibility 専用テーブル由来)。
 * y/w/h は median (混在 viewport の外れ値に強い)、document CSS px。
 */
export interface HeatmapImageStat {
  src: string
  alt: string
  /** この画像を視認したセッション数 */
  sessions: number
  views: number
  /** 平均最大視認率 [0,1] (どこまで画面内に入ったか) */
  avg_ratio: number
  /** 視認時間の中央値 (ms) */
  median_ms: number
  y: number
  w: number
  h: number
}

/** 続126 ★: UGOKI Crawl が取り込んだページ構造/品質 issue。 */
export interface HeatmapPageIssue {
  category: string
  type: string
  severity: string
  count: number
  recommendation: string
}

export interface HeatmapElementsData {
  /** クリック率の分母: フィルタ適用後のページ全セッション数 */
  page_sessions: number
  elements: HeatmapElementStat[]
  signals: HeatmapSignalStat[]
  /** 画像視認率 (データ無しページは []) */
  images: HeatmapImageStat[]
  /** クロール由来の構造 issue (クロール未取込ページは []) */
  issues: HeatmapPageIssue[]
}

export interface HeatmapElementsQuery {
  site_id: string
  page_url: string
  start_date?: string
  end_date?: string
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  /** 続125: 行動セグメント (lib/api/heatmap.ts HeatmapSegment と同一) */
  segment?: 'all' | 'deep_read' | 'bounce' | 'ad'
}

interface ElementsSuccess {
  success: true
  data: HeatmapElementsData
}
interface ElementsError {
  success: false
  error: { code: string; message: string }
}
export type HeatmapElementsResponse = ElementsSuccess | ElementsError

/**
 * 要素集計を取得する。失敗時は null を返す (本データは「強化」であり、
 * 無くても heatmap 本体は cluster ベースの fallback card で描画継続できるため非致命)。
 */
export async function fetchHeatmapElements(
  query: HeatmapElementsQuery,
  signal?: AbortSignal,
): Promise<HeatmapElementsData | null> {
  const params = new URLSearchParams()
  params.set('site_id', query.site_id)
  params.set('page_url', query.page_url)
  if (query.start_date) params.set('start_date', query.start_date)
  if (query.end_date) params.set('end_date', query.end_date)
  if (query.device_type) params.set('device_type', query.device_type)
  if (query.segment && query.segment !== 'all') params.set('segment', query.segment)

  try {
    const res = await fetch(`/api/heatmap/elements?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as HeatmapElementsResponse
    return body.success ? body.data : null
  } catch {
    return null
  }
}
