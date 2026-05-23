/**
 * HeatmapPage — P-04 のクライアントトップレベル
 *
 * 親 SSOT Part V §5.5.1 P-04
 *
 * 構成:
 *  - 左サイドコントロール: layer toggle / page url select / date range (Sprint 2 で本格化)
 *  - 中央: HeatmapCanvas (tile pagination)
 *  - 右下: HotspotDetail (slide-in)
 */

'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { EvidenceBadge } from '@/components/dashboard/evidence-badge'
import type { HeatmapLayer, HeatmapPoint, HeatmapTile } from '@/lib/api/heatmap'
import { HeatmapCanvas } from './heatmap-canvas'
import { HotspotDetail } from './hotspot-detail'
import { LayerToggle } from './layer-toggle'

interface HeatmapPageProps {
  siteId: string
  initialPageUrl: string
  pageOptions: Array<{ url: string; label: string }>
}

export function HeatmapPage({ siteId, initialPageUrl, pageOptions }: HeatmapPageProps) {
  const [layer, setLayer] = useState<HeatmapLayer>('click')
  const [pageUrl, setPageUrl] = useState(initialPageUrl)
  const [selected, setSelected] = useState<{ point: HeatmapPoint; tile: HeatmapTile } | null>(null)

  return (
    <div className="relative space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <PageSelector value={pageUrl} options={pageOptions} onChange={setPageUrl} />
          <LayerToggle value={layer} onChange={setLayer} />
        </div>
        <EvidenceBadge
          evidence={{
            level: layer === 'emotion' || layer === 'friction' ? 'inferred' : 'observed',
            confidence: layer === 'emotion' ? 0.65 : layer === 'friction' ? 0.72 : 1,
            references: [],
          }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <HeatmapCanvas
            query={{ site_id: siteId, page_url: pageUrl, layer }}
            onHotspotSelect={(point, tile) => setSelected({ point, tile })}
          />
        </CardContent>
      </Card>

      <HotspotDetail
        point={selected?.point ?? null}
        tile={selected?.tile ?? null}
        pageUrl={pageUrl}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

function PageSelector({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ url: string; label: string }>
  onChange: (next: string) => void
}) {
  return (
    <label className="relative inline-flex items-center gap-2 text-xs text-text-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">Page</span>
      <span className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none rounded-md border border-border bg-background px-3 py-1.5 pr-8 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="ヒートマップ表示対象ページ"
        >
          {options.map((opt) => (
            <option key={opt.url} value={opt.url}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
          aria-hidden
        />
      </span>
    </label>
  )
}
