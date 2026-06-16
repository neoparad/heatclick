/**
 * HotspotDetail — 右下にスライドインする hotspot 詳細パネル
 *
 * 親 SSOT Part V §5.5.1 P-04 (右パネル: hotspot detail)
 *
 * Sprint 1 は Sheet primitive を入れずに role="dialog" + transition で実装。
 * Sprint 3 で @radix-ui/react-dialog 経由の本格 Sheet に置換。
 */

'use client'

import { useEffect } from 'react'
import { Activity, MapPin, Users, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { HeatmapPoint, HeatmapTile } from '@/lib/api/heatmap'
import { cn } from '@/lib/utils'

interface HotspotDetailProps {
  point: HeatmapPoint | null
  tile: HeatmapTile | null
  pageUrl: string
  onClose: () => void
}

export function HotspotDetail({ point, tile, pageUrl, onClose }: HotspotDetailProps) {
  const open = point != null && tile != null

  // Escape で閉じる
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="ホットスポット詳細"
      aria-hidden={!open}
      className={cn(
        'fixed bottom-4 right-4 z-30 w-80 origin-bottom-right rounded-md border border-border bg-background p-4 shadow-lg transition',
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      {point && tile ? (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">ホットスポット詳細</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="閉じる"
              className="h-7 w-7"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>

          <p className="mb-3 break-all font-mono text-[11px] text-text-3">{pageUrl}</p>

          <dl className="space-y-2 text-xs">
            <Row icon={MapPin} label="位置" value={`x: ${point.x}px, y: ${point.y}px`} />
            <Row icon={Activity} label="クリック数" value={point.count.toLocaleString()} />
            <Row icon={Users} label="ユニークセッション" value={point.sessions.toLocaleString()} />
            <Row
              icon={MapPin}
              label="所属 tile"
              value={`${tile.y_start} – ${tile.y_end}px${tile.truncated ? ' (省略あり)' : ''}`}
            />
          </dl>
        </>
      ) : null}
    </aside>
  )
}

function Row({ icon: Icon, label, value }: { icon: typeof MapPin; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 text-text-3" aria-hidden />
      <div>
        <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-text-3">{label}</dt>
        <dd className="text-foreground">{value}</dd>
      </div>
    </div>
  )
}
