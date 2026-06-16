/**
 * SegmentChip — generic pill button for segment / period filters
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `mockup/01_heatmap_canvas.html` (.seg-pill)
 *
 * 続 82 Frontend Sprint 4 W1: HeatmapPage の PC+SP / 直近 7/14/30 日 chip 群で使用。
 * Sprint 5 で emotion / signals chip にも再利用予定 (本 API は安定維持)。
 *
 * A11y:
 *   - role="radio" / aria-checked で radiogroup 連携可能
 *   - Tab / Enter / Space に標準 button 挙動を残す
 */

'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export interface SegmentChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  /**
   * radiogroup 内で使う場合は親が role="radiogroup" を持ち、本 chip は role="radio"。
   * stand-alone toggle として使うなら省略 (default button role)。
   */
  asRadio?: boolean
}

export const SegmentChip = forwardRef<HTMLButtonElement, SegmentChipProps>(
  function SegmentChip(
    { active, asRadio, className, children, disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        role={asRadio ? 'radio' : undefined}
        aria-checked={asRadio ? Boolean(active) : undefined}
        aria-pressed={!asRadio ? Boolean(active) : undefined}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'border-foreground/30 bg-foreground/10 text-foreground'
            : 'border-border bg-background text-text-2 hover:bg-muted hover:text-foreground',
          disabled && 'cursor-not-allowed opacity-50 hover:bg-background hover:text-text-2',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)
