import { create } from 'zustand'

// --- サイト選択・期間フィルタの共有ストア ---

interface Site {
  id: string
  name: string
  url: string
  tracking_id?: string
}

interface AppStore {
  // サイト選択
  sites: Site[]
  selectedSiteId: string | null
  setSites: (sites: Site[]) => void
  setSelectedSiteId: (id: string) => void

  // 期間フィルタ
  dateRange: 'all' | '7d' | '30d' | '90d' | 'custom'
  startDate: string | null
  endDate: string | null
  setDateRange: (range: 'all' | '7d' | '30d' | '90d' | 'custom') => void
  setCustomDates: (start: string, end: string) => void

  // デバイスフィルタ
  deviceType: 'all' | 'desktop' | 'tablet' | 'mobile'
  setDeviceType: (device: 'all' | 'desktop' | 'tablet' | 'mobile') => void

  // ローディング・エラー
  isLoading: boolean
  error: string | null
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearError: () => void
}

// 日付計算ヘルパー
function getDateRange(range: string): { start: string | null; end: string | null } {
  if (range === 'all') return { start: null, end: null }
  const end = new Date()
  const start = new Date()
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 0
  if (days === 0) return { start: null, end: null }
  start.setDate(start.getDate() - days)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

export const useAppStore = create<AppStore>((set) => ({
  // サイト
  sites: [],
  selectedSiteId: null,
  setSites: (sites) => set({ sites }),
  setSelectedSiteId: (id) => set({ selectedSiteId: id }),

  // 期間
  dateRange: '30d',
  startDate: getDateRange('30d').start,
  endDate: getDateRange('30d').end,
  setDateRange: (range) => {
    const { start, end } = getDateRange(range)
    set({ dateRange: range, startDate: start, endDate: end })
  },
  setCustomDates: (start, end) => set({ dateRange: 'custom', startDate: start, endDate: end }),

  // デバイス
  deviceType: 'all',
  setDeviceType: (device) => set({ deviceType: device }),

  // ローディング・エラー
  isLoading: false,
  error: null,
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
}))
