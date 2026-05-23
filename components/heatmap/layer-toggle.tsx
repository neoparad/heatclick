/**
 * LayerToggle — click / move / emotion / friction の 4 layer 切替
 *
 * 親 SSOT Part V §5.5.1 P-04
 *
 * @radix-ui/react-toggle-group は未 install のため、aria-pressed + button 群で実装。
 * keyboard nav: Arrow Left/Right で focus 移動、Enter/Space で選択。
 */

'use client'

import { useId, useRef } from 'react'
import { MousePointerClick, MoveDiagonal, Smile, AlertOctagon } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { HeatmapLayer } from '@/lib/api/heatmap'

interface LayerToggleProps {
  value: HeatmapLayer
  onChange: (next: HeatmapLayer) => void
}

const ITEMS: Array<{ id: HeatmapLayer; label: string; Icon: typeof MousePointerClick }> = [
  { id: 'click', label: 'クリック', Icon: MousePointerClick },
  { id: 'move', label: 'ムーブ', Icon: MoveDiagonal },
  { id: 'emotion', label: '感情', Icon: Smile },
  { id: 'friction', label: '摩擦', Icon: AlertOctagon },
]

export function LayerToggle({ value, onChange }: LayerToggleProps) {
  const groupId = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function handleKey(event: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const dir = event.key === 'ArrowRight' ? 1 : -1
      const next = (idx + dir + ITEMS.length) % ITEMS.length
      refs.current[next]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      refs.current[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      refs.current[ITEMS.length - 1]?.focus()
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="ヒートマップレイヤー"
      id={groupId}
      className="inline-flex rounded-md border border-border bg-background p-1"
    >
      {ITEMS.map((item, i) => {
        const Icon = item.Icon
        const active = item.id === value
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => handleKey(e, i)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition',
              active
                ? 'bg-brand-gradient text-white shadow-sm'
                : 'text-text-2 hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
