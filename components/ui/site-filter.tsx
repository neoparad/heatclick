'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'

// 全ページで共有されるサイト選択＋期間フィルタ
export default function SiteFilter() {
  const {
    sites, selectedSiteId, setSites, setSelectedSiteId,
    dateRange, setDateRange,
    deviceType, setDeviceType,
  } = useAppStore()

  useEffect(() => {
    const fetchSites = async () => {
      try {
        const res = await fetch('/api/sites', { credentials: 'include' })
        if (!res.ok) return
        const data = await res.json()
        const siteList = data.sites || []
        setSites(siteList)
        if (siteList.length > 0 && !selectedSiteId) {
          setSelectedSiteId(siteList[0].id)
        }
      } catch {}
    }
    if (sites.length === 0) fetchSites()
  }, [sites.length, selectedSiteId, setSites, setSelectedSiteId])

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={selectedSiteId || ''}
        onChange={(e) => setSelectedSiteId(e.target.value)}
        className="border rounded-lg px-3 py-2 text-sm bg-white"
      >
        <option value="">サイトを選択</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>{site.name}</option>
        ))}
      </select>

      <select
        value={dateRange}
        onChange={(e) => setDateRange(e.target.value as any)}
        className="border rounded-lg px-3 py-2 text-sm bg-white"
      >
        <option value="7d">過去7日</option>
        <option value="30d">過去30日</option>
        <option value="90d">過去90日</option>
        <option value="all">全期間</option>
      </select>

      <select
        value={deviceType}
        onChange={(e) => setDeviceType(e.target.value as any)}
        className="border rounded-lg px-3 py-2 text-sm bg-white"
      >
        <option value="all">全デバイス</option>
        <option value="desktop">PC</option>
        <option value="tablet">タブレット</option>
        <option value="mobile">モバイル</option>
      </select>
    </div>
  )
}
