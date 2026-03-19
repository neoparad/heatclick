'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import DashboardLayout from '../../components/layout/DashboardLayout'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import {
  MousePointer,
  Eye,
  ScrollText,
  Download,
  Globe,
  BarChart3,
  Loader2,
  AlertCircle,
  Maximize2,
  Minimize2,
  X,
  Clock,
  LogOut,
  ArrowDownToLine,
  Image as ImageIcon,
  Monitor,
  Tablet,
  Smartphone,
  ArrowUpDown,
} from 'lucide-react'

// Dynamically import heatmap.js to avoid SSR issues
let h337: any = null
let heatmapLoadError: Error | null = null

if (typeof window !== 'undefined') {
  try {
    h337 = require('heatmap.js')
    heatmapLoadError = null
  } catch (error) {
    console.error('Failed to load heatmap.js:', error)
    heatmapLoadError = error as Error
  }
}

const VIEWPORT_WIDTH = 1280
const MAX_CANVAS_HEIGHT = 16000  // ブラウザcanvas描画上限
const MAX_IFRAME_HEIGHT = 30000  // iframe/ページ表示上限

interface Site {
  id: string
  name: string
  url: string
  domain?: string
  tracking_id: string
  created_at: string
}

interface PageData {
  url: string
  count: number
}

interface HeatmapPoint {
  click_x?: number
  click_y?: number
  scroll_y?: number
  read_y?: number
  element_tag_name?: string
  element_id?: string
  element_class_name?: string
  count?: number
  click_count?: number
  reach_rate?: number
  intensity?: number
  total_duration?: number
  avg_duration?: number
}

interface ImageVisibilityData {
  image_src: string
  image_alt: string
  element_path: string
  image_y: number
  image_width: number
  image_height: number
  avg_duration_ms: number
  max_duration_ms: number
  total_duration_ms: number
  avg_max_ratio: number
  unique_sessions: number
  view_count: number
  view_rate: number
  visibility_score: number
}

type HeatmapType = 'click' | 'scroll' | 'read' | 'image'

// --- Helper functions ---
const scoreColor = (score: number) => {
  if (score >= 80) return { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-300', ring: '#22c55e' }
  if (score >= 50) return { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-300', ring: '#eab308' }
  if (score >= 20) return { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-300', ring: '#f97316' }
  return { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-300', ring: '#ef4444' }
}

const scoreLabel = (score: number) => {
  if (score >= 80) return 'よく見られている'
  if (score >= 50) return 'まずまず'
  if (score >= 20) return '見られにくい'
  return 'ほぼスルー'
}

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const getImageName = (src: string) => {
  try {
    const url = new URL(src)
    return url.pathname.split('/').pop() || src
  } catch {
    return src.split('/').pop() || src
  }
}

const overlayBorderColor = (score: number) => {
  if (score >= 80) return 'rgba(34,197,94,0.7)'
  if (score >= 50) return 'rgba(234,179,8,0.7)'
  if (score >= 20) return 'rgba(249,115,22,0.7)'
  return 'rgba(239,68,68,0.7)'
}

const overlayBgColor = (score: number) => {
  if (score >= 80) return 'rgba(34,197,94,0.06)'
  if (score >= 50) return 'rgba(234,179,8,0.06)'
  if (score >= 20) return 'rgba(249,115,22,0.06)'
  return 'rgba(239,68,68,0.06)'
}

const badgeBgColor = (score: number) => {
  if (score >= 80) return 'rgba(220,252,231,0.95)'
  if (score >= 50) return 'rgba(254,249,195,0.95)'
  if (score >= 20) return 'rgba(254,215,170,0.95)'
  return 'rgba(254,202,202,0.95)'
}

export default function HeatmapPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>('')
  const [heatmapData, setHeatmapData] = useState<HeatmapPoint[]>([])
  const [imageData, setImageData] = useState<ImageVisibilityData[]>([])
  const [imageTotalSessions, setImageTotalSessions] = useState(0)
  const [loading, setLoading] = useState(true)
  const [heatmapLoading, setHeatmapLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<'all' | '7days' | '30days' | '90days'>('30days')
  const [heatmapType, setHeatmapType] = useState<HeatmapType>('click')
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [iframeError, setIframeError] = useState(false)
  const [scale, setScale] = useState(1)
  const [pageHeight, setPageHeight] = useState(3000)
  const iframeHeightRef = useRef(0) // iframeから取得した実際の高さを保持
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pageStats, setPageStats] = useState<{
    page_views: number; unique_sessions: number; avg_time_on_page: number;
    bounce_rate: number; avg_scroll_depth: number; avg_image_visibility: number; image_count: number;
  } | null>(null)
  const [selectedImage, setSelectedImage] = useState<ImageVisibilityData | null>(null)
  const [imageSortKey, setImageSortKey] = useState<'visibility_score' | 'avg_duration_ms' | 'view_rate' | 'avg_max_ratio' | 'image_y'>('visibility_score')
  const [imageSortAsc, setImageSortAsc] = useState(false)

  const heatmapContainerRef = useRef<HTMLDivElement>(null)
  const heatmapInstanceRef = useRef<any>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ビューポートに合わせてスケールを計算
  const calculateScale = useCallback(() => {
    if (!wrapperRef.current) return
    const wrapperWidth = wrapperRef.current.clientWidth
    if (wrapperWidth > 0) {
      const newScale = Math.min(wrapperWidth / VIEWPORT_WIDTH, 1)
      setScale(newScale)
    }
  }, [])

  // ResizeObserverでwrapperサイズ変更を確実に検出
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const observer = new ResizeObserver(() => calculateScale())
    observer.observe(el)
    calculateScale()
    return () => observer.disconnect()
  })

  useEffect(() => {
    window.addEventListener('resize', calculateScale)
    return () => window.removeEventListener('resize', calculateScale)
  }, [calculateScale])

  useEffect(() => {
    setTimeout(calculateScale, 50)
  }, [isFullscreen, calculateScale])

  // ESCキーで全画面解除 & モーダル閉じる
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedImage) setSelectedImage(null)
        else if (isFullscreen) setIsFullscreen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, selectedImage])

  // サイトリストを取得
  useEffect(() => {
    const fetchSites = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch('/api/sites')
        if (!response.ok) throw new Error('Failed to fetch sites')
        const data = await response.json()
        const sitesList = data.sites || []
        setSites(sitesList)
        if (sitesList.length > 0) setSelectedSite(sitesList[0])
      } catch (err) {
        console.error('Error fetching sites:', err)
        setError('サイト情報の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }
    fetchSites()
  }, [])

  // ページリストを取得
  useEffect(() => {
    if (!selectedSite) { setPages([]); setSelectedPageUrl(''); return }
    const fetchPages = async () => {
      try {
        const response = await fetch(`/api/pages?site_id=${selectedSite.tracking_id}`)
        if (!response.ok) throw new Error('Failed to fetch pages')
        const data = await response.json()
        const pageList = data.data || []
        setPages(pageList)
        setSelectedPageUrl(pageList.length > 0 ? pageList[0].url : '')
      } catch (err) {
        console.error('Error fetching pages:', err)
        setPages([]); setSelectedPageUrl('')
      }
    }
    fetchPages()
  }, [selectedSite])

  // ヒートマップデータを取得（click/scroll/read）
  useEffect(() => {
    if (!selectedSite || !selectedPageUrl || heatmapType === 'image') { setHeatmapData([]); return }
    const fetchHeatmap = async () => {
      setHeatmapLoading(true); setError(null)
      try {
        let startDate: string | undefined, endDate: string | undefined
        if (dateRange !== 'all') {
          const end = new Date(), start = new Date()
          start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        const params = new URLSearchParams({ site_id: selectedSite.tracking_id, page_url: selectedPageUrl, heatmap_type: heatmapType })
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)
        const response = await fetch(`/api/heatmap?${params.toString()}`)
        if (!response.ok) throw new Error('Failed to fetch heatmap data')
        const data = await response.json()
        const points = data.data || []
        setHeatmapData(points)
        if (points.length > 0) {
          let maxY = 0
          for (const p of points) { const y = p.click_y || p.scroll_y || p.read_y || 0; if (y > maxY) maxY = y }
          const dataHeight = Math.min(maxY + 500, MAX_IFRAME_HEIGHT)
          // iframeの高さが取得済みならそちらを優先、未取得ならデータの高さを使用
          if (iframeHeightRef.current > 0) {
            setPageHeight(Math.max(iframeHeightRef.current, dataHeight))
          } else {
            setPageHeight(Math.max(dataHeight, 3000))
          }
        }
      } catch (err) {
        console.error('Error fetching heatmap:', err)
        setHeatmapData([]); setError('ヒートマップデータの取得に失敗しました')
      } finally { setHeatmapLoading(false) }
    }
    fetchHeatmap()
  }, [selectedSite, selectedPageUrl, dateRange, heatmapType])

  // ページ統計を取得
  useEffect(() => {
    if (!selectedSite || !selectedPageUrl) { setPageStats(null); return }
    const fetchPageStats = async () => {
      try {
        let startDate: string | undefined, endDate: string | undefined
        if (dateRange !== 'all') {
          const end = new Date(), start = new Date()
          start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        const params = new URLSearchParams({ site_id: selectedSite.tracking_id, page_url: selectedPageUrl })
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)
        const res = await fetch(`/api/page-stats?${params.toString()}`)
        if (res.ok) {
          const json = await res.json()
          if (json.success) setPageStats(json.data)
        }
      } catch { /* silent */ }
    }
    fetchPageStats()
  }, [selectedSite, selectedPageUrl, dateRange])

  // 画像視認データを取得
  useEffect(() => {
    if (!selectedSite || !selectedPageUrl || heatmapType !== 'image') { setImageData([]); return }
    const fetchImageData = async () => {
      setHeatmapLoading(true); setError(null)
      try {
        let startDate: string | undefined, endDate: string | undefined
        if (dateRange !== 'all') {
          const end = new Date(), start = new Date()
          start.setDate(start.getDate() - (dateRange === '7days' ? 7 : dateRange === '30days' ? 30 : 90))
          startDate = start.toISOString().split('T')[0]
          endDate = end.toISOString().split('T')[0]
        }
        const params = new URLSearchParams({ site_id: selectedSite.tracking_id, page_url: selectedPageUrl })
        if (startDate) params.append('start_date', startDate)
        if (endDate) params.append('end_date', endDate)
        const response = await fetch(`/api/image-visibility?${params.toString()}`)
        if (!response.ok) throw new Error('Failed to fetch image visibility data')
        const data = await response.json()
        setImageData(data.data || [])
        setImageTotalSessions(data.total_sessions || 0)
        // ページ高さを画像のY座標から更新
        const imgs = data.data || []
        if (imgs.length > 0) {
          const maxY = Math.max(...imgs.map((d: ImageVisibilityData) => d.image_y + d.image_height))
          const dataHeight = Math.min(maxY + 500, MAX_IFRAME_HEIGHT)
          if (iframeHeightRef.current > 0) {
            setPageHeight(Math.max(iframeHeightRef.current, dataHeight))
          } else {
            setPageHeight(Math.max(dataHeight, 3000))
          }
        }
      } catch (err) {
        console.error('Error fetching image data:', err)
        setImageData([]); setError('画像視認データの取得に失敗しました')
      } finally { setHeatmapLoading(false) }
    }
    fetchImageData()
  }, [selectedSite, selectedPageUrl, dateRange, heatmapType])

  // iframe読み込み — 高さを複数回取得（CSS/画像の遅延読み込み対策）
  const measureIframeHeight = useCallback(() => {
    try {
      const iframe = iframeRef.current
      if (!iframe) return
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document
      if (iframeDoc) {
        const h = Math.min(
          Math.max(iframeDoc.body.scrollHeight, iframeDoc.documentElement.scrollHeight, 3000),
          MAX_IFRAME_HEIGHT
        )
        if (h > iframeHeightRef.current) {
          iframeHeightRef.current = h
          setPageHeight(h)
        }
      }
    } catch { /* CORS */ }
  }, [])

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true); setIframeError(false)
    // 即座 + 遅延で複数回計測（CSS/画像の読み込みタイミング対策）
    measureIframeHeight()
    setTimeout(measureIframeHeight, 500)
    setTimeout(measureIframeHeight, 1500)
    setTimeout(measureIframeHeight, 3000)
  }, [measureIframeHeight])

  const clampedHeight = Math.min(pageHeight, MAX_CANVAS_HEIGHT)

  // スクロール/熟読用のオーバーレイ
  const [bandOverlayStyle, setBandOverlayStyle] = useState<React.CSSProperties>({})
  const [scrollLabels, setScrollLabels] = useState<Array<{ y: number; pct: number }>>([])
  const [scrollSvg, setScrollSvg] = useState<string>('')
  const [scrollSvgHeight, setScrollSvgHeight] = useState(0)

  useEffect(() => {
    if (heatmapType === 'image' || heatmapType === 'click') {
      setBandOverlayStyle({}); setScrollLabels([]); setScrollSvg('')
      return
    }
    if (heatmapData.length > 0) {
      let sorted: Array<{ y: number; value: number }> = []
      let rawScrollData: Array<{ y: number; reachRate: number }> = []

      if (heatmapType === 'scroll') {
        rawScrollData = heatmapData
          .filter(p => typeof p.scroll_y === 'number')
          .map(p => ({ y: p.scroll_y || 0, reachRate: p.reach_rate || 0 }))
          .sort((a, b) => a.y - b.y)
        const topReach = rawScrollData.length > 0 ? rawScrollData[0].reachRate : 100
        const scaleFactor = topReach > 0 ? (100 / topReach) : 1
        rawScrollData = rawScrollData.map(p => ({ y: p.y, reachRate: Math.min(100, p.reachRate * scaleFactor) }))
        if (rawScrollData.length > 0 && rawScrollData[0].y > 0) {
          rawScrollData.unshift({ y: 0, reachRate: 100 })
        }
        sorted = rawScrollData.map(p => ({ y: p.y, value: p.reachRate / 100 }))

        const thresholds = [75, 50, 25, 10]
        const labels: Array<{ y: number; pct: number }> = []
        for (const threshold of thresholds) {
          const point = rawScrollData.find(p => p.reachRate <= threshold)
          if (point) labels.push({ y: point.y, pct: Math.round(point.reachRate) })
        }
        setScrollLabels(labels)

        const w = VIEWPORT_WIDTH
        const maxReach = 100
        const maxY = rawScrollData[rawScrollData.length - 1]?.y || pageHeight
        setScrollSvgHeight(maxY)

        const valToCol = (v: number) => {
          const c = Math.max(0, Math.min(1, v))
          if (c > 0.7) return '#ff0000'
          if (c > 0.5) return '#ff6600'
          if (c > 0.35) return '#ffcc00'
          if (c > 0.2) return '#88cc00'
          if (c > 0.1) return '#00cc66'
          return '#0088ff'
        }

        let svgContent = `<defs>`
        for (let i = 0; i < rawScrollData.length - 1; i++) {
          const cur = rawScrollData[i]
          const next = rawScrollData[i + 1]
          const color = valToCol(cur.reachRate / maxReach)
          svgContent += `<linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="${valToCol(next.reachRate / maxReach)}" stop-opacity="0.55"/>
          </linearGradient>`
        }
        svgContent += `</defs>`
        for (let i = 0; i < rawScrollData.length - 1; i++) {
          const cur = rawScrollData[i]
          const next = rawScrollData[i + 1]
          const curWidth = (cur.reachRate / maxReach) * w
          const nextWidth = (next.reachRate / maxReach) * w
          const curLeft = (w - curWidth) / 2
          const nextLeft = (w - nextWidth) / 2
          svgContent += `<polygon points="${curLeft},${cur.y} ${curLeft + curWidth},${cur.y} ${nextLeft + nextWidth},${next.y} ${nextLeft},${next.y}" fill="url(#g${i})"/>`
        }
        setScrollSvg(svgContent)
        setBandOverlayStyle({})
        return
      } else {
        sorted = heatmapData
          .filter(p => typeof p.read_y === 'number')
          .map(p => ({ y: p.read_y || 0, value: p.intensity || 0 }))
          .sort((a, b) => a.y - b.y)
        setScrollLabels([])
      }

      if (sorted.length === 0) { setBandOverlayStyle({}); setScrollLabels([]); return }

      const valueToColor = (v: number) => {
        const clamped = Math.max(0, Math.min(1, v))
        if (clamped < 0.01) return 'rgba(0,0,0,0)'
        const alpha = 0.4 + clamped * 0.35
        if (clamped < 0.25) { const t = clamped / 0.25; return `rgba(0,${Math.round(100 + 155 * t)},${Math.round(255 * (1 - t))},${alpha})` }
        if (clamped < 0.5) { const t = (clamped - 0.25) / 0.25; return `rgba(${Math.round(255 * t)},255,0,${alpha})` }
        if (clamped < 0.75) { const t = (clamped - 0.5) / 0.25; return `rgba(255,${Math.round(255 * (1 - t))},0,${alpha})` }
        const t = (clamped - 0.75) / 0.25; return `rgba(${Math.round(255 - 55 * t)},0,0,${alpha})`
      }

      const stops: string[] = []
      const maxY = sorted[sorted.length - 1].y || pageHeight
      for (const point of sorted) { stops.push(`${valueToColor(point.value)} ${((point.y / maxY) * 100).toFixed(2)}%`) }
      stops.push('rgba(0,0,0,0) 100%')
      setBandOverlayStyle({ background: `linear-gradient(to bottom, ${stops.join(', ')})`, position: 'absolute', top: 0, left: 0, width: '100%', height: `${pageHeight}px`, zIndex: 2, pointerEvents: 'none' as const })
    } else {
      setBandOverlayStyle({}); setScrollLabels([])
    }
  }, [heatmapData, heatmapType, pageHeight])

  // クリックヒートマップ描画
  useEffect(() => {
    if (heatmapType !== 'click') {
      if (heatmapContainerRef.current) { const c = heatmapContainerRef.current.querySelector('canvas'); if (c) c.remove() }
      heatmapInstanceRef.current = null
      return
    }
    if (!h337 || !heatmapContainerRef.current || heatmapData.length === 0) {
      if (heatmapContainerRef.current) { const c = heatmapContainerRef.current.querySelector('canvas'); if (c) c.remove() }
      return
    }
    if (heatmapInstanceRef.current) {
      const c = heatmapContainerRef.current.querySelector('canvas'); if (c) c.remove()
      heatmapInstanceRef.current = null
    }
    const timer = setTimeout(() => {
      if (!heatmapContainerRef.current) return
      try {
        const inst = h337.create({ container: heatmapContainerRef.current, radius: 30, maxOpacity: 0.7, minOpacity: 0, blur: 0.8 })
        const points = heatmapData
          .filter(p => typeof p.click_x === 'number' && typeof p.click_y === 'number' && p.click_x >= 0 && p.click_y >= 0 && (p.click_y || 0) < MAX_CANVAS_HEIGHT)
          .sort((a, b) => (b.count || b.click_count || 0) - (a.count || a.click_count || 0)).slice(0, 500)
          .map(p => ({ x: Math.round(p.click_x || 0), y: Math.round(p.click_y || 0), value: p.count || p.click_count || 1 }))
        if (points.length === 0) return
        inst.setData({ max: Math.max(...points.map(p => p.value), 1), data: points })
        heatmapInstanceRef.current = inst
      } catch (error) { console.error('Error rendering heatmap:', error) }
    }, 200)
    return () => { clearTimeout(timer); if (heatmapContainerRef.current) { const c = heatmapContainerRef.current.querySelector('canvas'); if (c) c.remove() }; heatmapInstanceRef.current = null }
  }, [heatmapData, heatmapType, clampedHeight, isFullscreen])

  const proxyUrl = selectedPageUrl ? `/api/proxy-page?url=${encodeURIComponent(selectedPageUrl)}&_t=${Date.now()}` : ''

  const stats = {
    totalClicks: heatmapData.reduce((sum, p) => sum + (p.count || p.click_count || 0), 0),
    pointCount: heatmapData.length,
    avgReachRate: heatmapData.length > 0 ? (heatmapData.reduce((sum, p) => sum + (p.reach_rate || 0), 0) / heatmapData.length) : 0,
    avgDuration: heatmapData.length > 0 ? (heatmapData.reduce((sum, p) => sum + (p.avg_duration || 0), 0) / heatmapData.length) : 0,
  }

  const imageAvgScore = imageData.length > 0 ? Math.round(imageData.reduce((s, d) => s + d.visibility_score, 0) / imageData.length) : 0

  // 画像ソート
  const sortedImageData = [...imageData].sort((a, b) => {
    const diff = (a[imageSortKey] || 0) - (b[imageSortKey] || 0)
    return imageSortAsc ? diff : -diff
  })

  const handleImageSort = (key: typeof imageSortKey) => {
    if (imageSortKey === key) setImageSortAsc(!imageSortAsc)
    else { setImageSortKey(key); setImageSortAsc(false) }
  }

  // --- コントロールバー ---
  const controlBar = (
    <div className={`flex items-center justify-between flex-wrap gap-2 ${isFullscreen ? 'px-4 py-2 bg-white border-b border-gray-200' : ''}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['click', 'scroll', 'read', 'image'] as const).map(type => (
            <button key={type} onClick={() => setHeatmapType(type)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${heatmapType === type ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
              {type === 'click' && <><MousePointer className="w-3.5 h-3.5" />クリック</>}
              {type === 'scroll' && <><ScrollText className="w-3.5 h-3.5" />スクロール</>}
              {type === 'read' && <><Eye className="w-3.5 h-3.5" />熟読</>}
              {type === 'image' && <><ImageIcon className="w-3.5 h-3.5" />画像</>}
            </button>
          ))}
        </div>

        <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white">
          <option value="7days">7日間</option><option value="30days">30日間</option>
          <option value="90days">90日間</option><option value="all">全期間</option>
        </select>

        {pages.length > 0 && (
          <select value={selectedPageUrl}
            onChange={(e) => { setSelectedPageUrl(e.target.value); setIframeLoaded(false); setIframeError(false); iframeHeightRef.current = 0; setPageHeight(3000) }}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white max-w-[300px]">
            {pages.map(p => (
              <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex items-center gap-3">
        {heatmapType !== 'image' && heatmapData.length > 0 && (
          <span className="text-xs text-gray-500">
            {heatmapType === 'click' && `${stats.totalClicks.toLocaleString()} クリック`}
            {heatmapType === 'scroll' && `到達率 ${stats.avgReachRate.toFixed(1)}%`}
            {heatmapType === 'read' && `平均 ${stats.avgDuration.toFixed(0)}ms`}
          </span>
        )}
        {heatmapType === 'image' && imageData.length > 0 && (
          <span className="text-xs text-gray-500">{imageData.length} 画像 / 平均スコア {imageAvgScore}</span>
        )}

        <button onClick={() => setIsFullscreen(!isFullscreen)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
          title={isFullscreen ? '全画面解除 (ESC)' : '全画面表示'}>
          {isFullscreen ? <><Minimize2 className="w-4 h-4" />閉じる</> : <><Maximize2 className="w-4 h-4" />全画面</>}
        </button>
      </div>
    </div>
  )

  // --- ヒートマップビューアー ---
  const heatmapViewer = (
    <div ref={wrapperRef} className={`relative bg-gray-100 ${isFullscreen ? 'flex-1 overflow-auto' : 'border border-gray-200 rounded-lg overflow-auto'}`}>
      <div className="relative mx-auto bg-white shadow-inner"
        style={{ width: `${VIEWPORT_WIDTH}px`, height: `${pageHeight}px`, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {!iframeLoaded && !iframeError && (
          <div className="absolute inset-0 bg-gray-50 flex items-center justify-center z-0">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto mb-3" />
              <p className="text-sm text-gray-500">ページを読み込み中...</p>
            </div>
          </div>
        )}
        {iframeError && (
          <div className="absolute inset-0 bg-gray-50 flex items-center justify-center z-0">
            <div className="text-center max-w-md px-8">
              <AlertCircle className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700 mb-1">ページの読み込みに失敗しました</p>
              <p className="text-xs text-gray-500">データは座標ベースで表示されます。</p>
            </div>
          </div>
        )}
        <iframe ref={iframeRef} src={proxyUrl} className="absolute inset-0 w-full border-0"
          style={{ height: `${pageHeight}px`, pointerEvents: 'none' }}
          title="Page Preview" sandbox="allow-same-origin" loading="lazy"
          onLoad={handleIframeLoad} onError={() => setIframeError(true)} />

        {/* クリックヒートマップ用canvas */}
        {heatmapType === 'click' && (
          <div ref={heatmapContainerRef} className="absolute top-0 left-0"
            style={{ width: `${VIEWPORT_WIDTH}px`, height: `${clampedHeight}px`, zIndex: 2, pointerEvents: 'none' }} />
        )}
        {/* スクロール用SVGファネルオーバーレイ */}
        {heatmapType === 'scroll' && scrollSvg && (
          <>
            <svg style={{ position: 'absolute', top: 0, left: 0, width: `${VIEWPORT_WIDTH}px`, height: `${scrollSvgHeight}px`, zIndex: 2, pointerEvents: 'none' }}
              viewBox={`0 0 ${VIEWPORT_WIDTH} ${scrollSvgHeight}`} preserveAspectRatio="none"
              dangerouslySetInnerHTML={{ __html: scrollSvg }} />
            {scrollLabels.map((label, i) => (
              <div key={i} style={{ position: 'absolute', top: `${label.y}px`, left: 0, width: '100%', zIndex: 3, pointerEvents: 'none', display: 'flex', alignItems: 'center' }}>
                <div style={{ borderTop: '1px dashed rgba(0,0,0,0.3)', flex: 1 }} />
                <div style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '11px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '3px', marginLeft: '4px', marginRight: '8px', whiteSpace: 'nowrap' }}>{label.pct}%</div>
              </div>
            ))}
          </>
        )}
        {/* 熟読用グラデーションオーバーレイ */}
        {heatmapType === 'read' && bandOverlayStyle.background && <div style={bandOverlayStyle} />}

        {/* 画像スコアオーバーレイ */}
        {heatmapType === 'image' && imageData.map((img, i) => (
          <div key={i}
            onClick={() => setSelectedImage(img)}
            style={{
              position: 'absolute',
              left: `${Math.max(0, (VIEWPORT_WIDTH - img.image_width) / 2 - 100)}px`,
              top: `${img.image_y}px`,
              width: `${Math.min(img.image_width + 200, VIEWPORT_WIDTH)}px`,
              height: `${img.image_height}px`,
              border: `3px solid ${overlayBorderColor(img.visibility_score)}`,
              background: overlayBgColor(img.visibility_score),
              borderRadius: '4px',
              zIndex: 5,
              cursor: 'pointer',
              transition: 'box-shadow 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.3)' }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}
          >
            {/* スコアバッジ */}
            <div style={{
              position: 'absolute', top: '-12px', right: '-12px',
              background: badgeBgColor(img.visibility_score),
              border: `2px solid ${overlayBorderColor(img.visibility_score)}`,
              borderRadius: '6px', padding: '2px 8px',
              fontSize: '13px', fontWeight: 700,
              color: scoreColor(img.visibility_score).text.replace('text-', '').includes('green') ? '#166534' :
                scoreColor(img.visibility_score).text.replace('text-', '').includes('yellow') ? '#854d0e' :
                  scoreColor(img.visibility_score).text.replace('text-', '').includes('orange') ? '#9a3412' : '#991b1b',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              pointerEvents: 'none',
            }}>
              {img.visibility_score}
            </div>
            {/* 情報ラベル */}
            <div style={{
              position: 'absolute', bottom: '4px', left: '4px',
              background: 'rgba(0,0,0,0.6)', color: '#fff',
              fontSize: '11px', padding: '2px 8px', borderRadius: '3px',
              backdropFilter: 'blur(2px)', pointerEvents: 'none',
            }}>
              avg {formatDuration(img.avg_duration_ms)} / 閲覧率 {img.view_rate}%
            </div>
          </div>
        ))}

        {heatmapLoading && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-10">
            <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-full shadow-md">
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              <span className="text-sm text-gray-600">データ取得中...</span>
            </div>
          </div>
        )}
      </div>
      <div style={{ height: `${pageHeight * scale}px` }} />
      {/* 凡例 */}
      <div className="absolute bottom-4 right-4 z-10 bg-white/95 backdrop-blur-sm rounded-lg shadow-md px-3 py-2">
        {heatmapType !== 'image' ? (
          <>
            <div className="text-xs text-gray-500 mb-1 font-medium">
              {heatmapType === 'click' ? 'クリック密度' : heatmapType === 'scroll' ? 'スクロール到達率' : '滞在時間'}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-400">低</span>
              <div className="w-24 h-2 rounded-full" style={{ background: 'linear-gradient(to right, #0000ff, #00ff00, #ffff00, #ff0000)' }} />
              <span className="text-xs text-gray-400">高</span>
            </div>
          </>
        ) : (
          <>
            <div className="text-xs text-gray-500 mb-2 font-medium">画像閲覧スコア</div>
            <div className="space-y-1">
              {[{ range: '80-100', label: 'よく見られている', color: '#22c55e' },
                { range: '50-79', label: 'まずまず', color: '#eab308' },
                { range: '20-49', label: '見られにくい', color: '#f97316' },
                { range: '0-19', label: 'ほぼスルー', color: '#ef4444' }].map(item => (
                <div key={item.range} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded" style={{ background: item.color, opacity: 0.7 }} />
                  <span className="text-xs text-gray-500">{item.range} {item.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )

  // --- 画像詳細モーダル ---
  const imageModal = selectedImage && (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) setSelectedImage(null) }}>
      <div className="bg-white rounded-2xl w-[720px] max-w-[90vw] max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-gray-500" />
            {getImageName(selectedImage.image_src)}
          </h3>
          <button onClick={() => setSelectedImage(null)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {/* Top: Image + Score */}
          <div className="flex gap-6 mb-6">
            <div className="flex-shrink-0">
              <div className="rounded-lg border border-gray-200 overflow-hidden bg-gray-50" style={{ width: '200px', height: '140px' }}>
                <img src={selectedImage.image_src} alt={selectedImage.image_alt} className="w-full h-full object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
              <div className="mt-2 text-xs text-gray-400">
                {getImageName(selectedImage.image_src)} &middot; {selectedImage.image_width}x{selectedImage.image_height} &middot; Y: {selectedImage.image_y}px
              </div>
              {selectedImage.image_alt && <div className="mt-1 text-xs text-gray-300 truncate max-w-[200px]">{selectedImage.image_alt}</div>}
            </div>

            <div className="flex-1">
              <div className="flex items-start gap-6">
                {/* Score ring */}
                <div className="relative w-24 h-24 flex-shrink-0">
                  <svg width="96" height="96" viewBox="0 0 96 96" style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx="48" cy="48" r="42" fill="none" stroke="#e5e7eb" strokeWidth="8" />
                    <circle cx="48" cy="48" r="42" fill="none" strokeWidth="8" strokeLinecap="round"
                      stroke={scoreColor(selectedImage.visibility_score).ring}
                      strokeDasharray="264"
                      strokeDashoffset={264 - (264 * selectedImage.visibility_score / 100)} />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold">{selectedImage.visibility_score}</span>
                    <span className="text-xs text-gray-400">スコア</span>
                  </div>
                </div>

                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-0.5">平均視認時間</div>
                    <div className="text-lg font-bold">{formatDuration(selectedImage.avg_duration_ms)}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-0.5">最大視認時間</div>
                    <div className="text-lg font-bold">{formatDuration(selectedImage.max_duration_ms)}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-0.5">閲覧率</div>
                    <div className="text-lg font-bold">{selectedImage.view_rate}%</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-0.5">最大表示率</div>
                    <div className="text-lg font-bold">{Math.round(selectedImage.avg_max_ratio * 100)}%</div>
                  </div>
                </div>
              </div>

              {/* Evaluation */}
              <div className={`mt-4 p-3 rounded-lg border ${scoreColor(selectedImage.visibility_score).bg} ${scoreColor(selectedImage.visibility_score).border}`}>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${scoreColor(selectedImage.visibility_score).bg} ${scoreColor(selectedImage.visibility_score).text}`}>
                  {scoreLabel(selectedImage.visibility_score)}
                </span>
              </div>
            </div>
          </div>

          {/* Session stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-400">閲覧セッション</div>
              <div className="text-xl font-bold">{selectedImage.unique_sessions.toLocaleString()}</div>
              <div className="text-xs text-gray-400">/ {imageTotalSessions.toLocaleString()} PV</div>
            </div>
            <div className="text-center bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-400">合計視認時間</div>
              <div className="text-xl font-bold">{formatDuration(selectedImage.total_duration_ms)}</div>
            </div>
            <div className="text-center bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-400">表示回数</div>
              <div className="text-xl font-bold">{selectedImage.view_count.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  // --- 全画面モード ---
  if (isFullscreen && selectedPageUrl) {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          {controlBar}
          {heatmapViewer}
        </div>
        {imageModal}
      </>
    )
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400 mr-2" />
          <span className="text-gray-500">読み込み中...</span>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">ヒートマップ分析</h1>
            <p className="text-sm text-gray-500 mt-1">実際のページ上にクリック・スクロール・熟読・画像閲覧データをオーバーレイ表示</p>
          </div>
          <Button variant="outline" size="sm" disabled>
            <Download className="w-4 h-4 mr-2" />エクスポート
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
          </div>
        )}

        {sites.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Globe className="w-12 h-12 text-gray-300 mb-4" />
              <p className="text-gray-500 mb-4">登録されているサイトがありません</p>
              <a href="/sites" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">サイトを登録する</a>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">サイト</label>
                    <select value={selectedSite?.id || ''}
                      onChange={(e) => { const s = sites.find(s => s.id === e.target.value); if (s) { setSelectedSite(s); setIframeLoaded(false); setIframeError(false); iframeHeightRef.current = 0; setPageHeight(3000) } }}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      {sites.map(s => <option key={s.id} value={s.id}>{s.name} ({s.url || s.domain})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">期間</label>
                    <select value={dateRange} onChange={(e) => setDateRange(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                      <option value="7days">過去7日間</option><option value="30days">過去30日間</option>
                      <option value="90days">過去90日間</option><option value="all">全期間</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">ページ</label>
                    {pages.length > 0 ? (
                      <select value={selectedPageUrl}
                        onChange={(e) => { setSelectedPageUrl(e.target.value); setIframeLoaded(false); setIframeError(false); iframeHeightRef.current = 0; setPageHeight(3000) }}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        {pages.map(p => <option key={p.url} value={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '')} ({p.count.toLocaleString()})</option>)}
                      </select>
                    ) : <div className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-400">データなし</div>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {controlBar}

            {/* ページ統計 */}
            {pageStats && selectedPageUrl && (
              <div className="flex flex-wrap items-center gap-4 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                <div className="flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-gray-500">PV</span>
                  <span className="font-semibold">{pageStats.page_views.toLocaleString()}</span>
                  <span className="text-xs text-gray-400">({pageStats.unique_sessions}セッション)</span>
                </div>
                <div className="h-4 w-px bg-gray-200" />
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-gray-500">滞在</span>
                  <span className="font-semibold">
                    {pageStats.avg_time_on_page >= 60
                      ? `${Math.floor(pageStats.avg_time_on_page / 60)}分${pageStats.avg_time_on_page % 60}秒`
                      : `${pageStats.avg_time_on_page}秒`}
                  </span>
                </div>
                <div className="h-4 w-px bg-gray-200" />
                <div className="flex items-center gap-1.5">
                  <LogOut className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-gray-500">離脱率</span>
                  <span className="font-semibold">{pageStats.bounce_rate}%</span>
                </div>
                <div className="h-4 w-px bg-gray-200" />
                <div className="flex items-center gap-1.5">
                  <ArrowDownToLine className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-gray-500">スクロール</span>
                  <span className="font-semibold">{pageStats.avg_scroll_depth}%</span>
                </div>
                <div className="h-4 w-px bg-gray-200" />
                <div className="flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-gray-500">画像可視率</span>
                  <span className="font-semibold">{pageStats.avg_image_visibility}%</span>
                  <span className="text-xs text-gray-400">({pageStats.image_count}画像)</span>
                </div>
              </div>
            )}

            {!selectedPageUrl ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <BarChart3 className="w-12 h-12 text-gray-300 mb-4" />
                  <p className="text-gray-500">ページを選択してヒートマップを表示</p>
                </CardContent>
              </Card>
            ) : heatmapViewer}

            {/* トップクリック要素 */}
            {heatmapType === 'click' && heatmapData.length > 0 && (
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">トップクリック要素</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-3 text-gray-500 font-medium">#</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium">要素</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium">座標</th>
                          <th className="text-right py-2 px-3 text-gray-500 font-medium">クリック数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {heatmapData.sort((a, b) => (b.count || b.click_count || 0) - (a.count || a.click_count || 0)).slice(0, 10).map((point, i) => {
                          const cc = point.count || point.click_count || 0
                          return (
                            <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                              <td className="py-2 px-3 text-gray-400">{i + 1}</td>
                              <td className="py-2 px-3"><code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{point.element_tag_name || '—'}{point.element_id ? `#${point.element_id}` : ''}{point.element_class_name ? `.${point.element_class_name.split(' ')[0]}` : ''}</code></td>
                              <td className="py-2 px-3 text-gray-500 text-xs">({point.click_x}, {point.click_y})</td>
                              <td className="py-2 px-3 text-right font-semibold text-blue-600">{cc.toLocaleString()}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 画像別閲覧ランキング */}
            {heatmapType === 'image' && imageData.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ImageIcon className="w-5 h-5" />画像別閲覧ランキング
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-3 text-gray-500 font-medium w-8">#</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium">画像</th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleImageSort('visibility_score')}>
                            <span className="flex items-center gap-1">スコア <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleImageSort('avg_duration_ms')}>
                            <span className="flex items-center gap-1">平均視認時間 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleImageSort('avg_max_ratio')}>
                            <span className="flex items-center gap-1">最大表示率 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleImageSort('view_rate')}>
                            <span className="flex items-center gap-1">閲覧率 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                          <th className="text-left py-2 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleImageSort('image_y')}>
                            <span className="flex items-center gap-1">Y座標 <ArrowUpDown className="w-3 h-3" /></span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedImageData.map((item, i) => {
                          const sc = scoreColor(item.visibility_score)
                          return (
                            <tr key={item.image_src} className="border-b border-gray-50 hover:bg-blue-50/50 cursor-pointer" onClick={() => setSelectedImage(item)}>
                              <td className="py-3 px-3 text-gray-400">{i + 1}</td>
                              <td className="py-3 px-3">
                                <div className="flex items-center gap-3">
                                  <div className="w-12 h-12 rounded border border-gray-200 overflow-hidden flex-shrink-0 bg-gray-50">
                                    <img src={item.image_src} alt={item.image_alt} className="w-full h-full object-cover"
                                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-gray-700 truncate max-w-[180px]">{getImageName(item.image_src)}</p>
                                    {item.image_alt && <p className="text-xs text-gray-400 truncate max-w-[180px]">{item.image_alt}</p>}
                                    <p className="text-xs text-gray-300">{item.image_width}x{item.image_height}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3 px-3">
                                <div className="flex items-center gap-2">
                                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${sc.bg} ${sc.text}`}>{item.visibility_score}</span>
                                  <span className="text-xs text-gray-400">{scoreLabel(item.visibility_score)}</span>
                                </div>
                              </td>
                              <td className="py-3 px-3 font-medium">{formatDuration(item.avg_duration_ms)}</td>
                              <td className="py-3 px-3">
                                <div className="flex items-center gap-2">
                                  <div className="w-16 bg-gray-100 rounded-full h-2">
                                    <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${Math.round(item.avg_max_ratio * 100)}%` }} />
                                  </div>
                                  <span className="text-xs text-gray-500">{Math.round(item.avg_max_ratio * 100)}%</span>
                                </div>
                              </td>
                              <td className="py-3 px-3">
                                <span className="font-medium">{item.view_rate}%</span>
                                <span className="text-xs text-gray-400 ml-1">({item.unique_sessions}/{imageTotalSessions})</span>
                              </td>
                              <td className="py-3 px-3 text-xs text-gray-500">{item.image_y.toLocaleString()}px</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
      {imageModal}
    </DashboardLayout>
  )
}
