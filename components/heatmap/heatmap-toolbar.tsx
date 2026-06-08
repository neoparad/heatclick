/**
 * HeatmapToolbar — canvas 上端 (mockup `.hm-canvas-top`)
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.hm-canvas-top`
 * Dispatch:
 *   - mockup parity rebuild §4 Step 7 (2026-05-29)
 *   - 続 115 (controls 4→3段化) で `scrollLabel` 追加
 *   - 続 116 (stage-fix + D 改修) で URL bar 撤去、stats 表示領域拡大
 *     (URL は段 1 PAGE select で確認可能、canvas-top では metric 視認性を優先)
 *
 * 構成 (続 116 以降):
 *   - device tabs (PC / SP / TAB)
 *   - stats (PV / CTR / 到達率 / 滞留) — 大きめ font + ゆとり間隔
 *   - action buttons (filter 表示/非表示 / side panel / 全画面)
 *   ❌ URL bar (続 116 撤去)
 */

import type { DeviceKind } from '@/lib/heatmap/types'

interface HeatmapToolbarProps {
  device: DeviceKind
  onDeviceChange: (d: DeviceKind) => void
  pvLabel?: string
  ctrLabel?: string
  /** 滞在時間 (legacy label、Phase 2 では未配線・将来 hook で実値) */
  dwellLabel?: string
  /**
   * Phase 2 (B 改修): scroll>50% 到達率。段 2 page-stats-bar 撤去に伴い canvas-top に集約。
   * 集計データ無 / scroll event 未配備 tenant では undefined。
   */
  scrollLabel?: string
  controlsVisible: boolean
  onToggleControls: () => void
  sideVisible: boolean
  onToggleSide: () => void
  onEnterFullscreen: () => void
}

const DEVICES: ReadonlyArray<{ key: DeviceKind; label: string; icon: JSX.Element }> = [
  {
    key: 'pc',
    label: 'PC',
    icon: (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 18v3" />
      </svg>
    ),
  },
  {
    key: 'sp',
    label: 'SP',
    icon: (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="6" y="2" width="12" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18.01" />
      </svg>
    ),
  },
  {
    key: 'tab',
    label: 'TAB',
    icon: (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
    ),
  },
]

export function HeatmapToolbar({
  device,
  onDeviceChange,
  pvLabel,
  ctrLabel,
  dwellLabel,
  scrollLabel,
  controlsVisible,
  onToggleControls,
  sideVisible,
  onToggleSide,
  onEnterFullscreen,
}: HeatmapToolbarProps) {
  return (
    <div
      data-testid="heatmap-toolbar"
      className="flex items-center gap-2.5 border-b border-[var(--ug-border)] px-3.5 py-2.5"
      style={{ background: 'var(--ug-panel-2, #fbfbfc)' }}
    >
      <div
        role="radiogroup"
        aria-label="デバイス選択"
        className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--ug-border)] bg-white"
      >
        {DEVICES.map((d) => {
          const active = device === d.key
          return (
            <button
              key={d.key}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`device-tab-${d.key}`}
              onClick={() => onDeviceChange(d.key)}
              className={
                'inline-flex items-center gap-1.5 border-r border-[var(--ug-border)] px-2.5 py-1.5 text-[11.5px] last:border-r-0 ' +
                (active
                  ? 'bg-[var(--ug-bg-2)] font-semibold text-[var(--ug-text)]'
                  : 'text-[var(--ug-text-2)] hover:bg-[var(--ug-bg-subtle)]')
              }
            >
              {d.icon}
              {d.label}
            </button>
          )
        })}
      </div>

      {/*
        続 116 D 改修: canvas-top URL bar を撤去。
        URL は段 1 (heatmap-page-filter-bar) の PAGE select で確認可能。
        URL bar が占めていた空 space を stats 領域に振り、PV/CTR/到達率/滞留 を見やすく表示。
        pageUrl prop 自体は heatmap-canvas からの aria-label 用に保持 (削除しない)。
      */}
      <div
        className="ml-auto flex min-w-0 items-center gap-x-4 overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-[var(--ug-text-2)] [scrollbar-width:none]"
        data-testid="canvas-stats-group"
      >
        {pvLabel ? (
          <span data-testid="canvas-stat-pv" className="inline-flex items-baseline gap-1">
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--ug-text-3)]">PV</span>
            <b className="text-[13px] font-semibold text-[var(--ug-text-1)]">{pvLabel}</b>
          </span>
        ) : null}
        {ctrLabel ? (
          <span data-testid="canvas-stat-ctr" className="inline-flex items-baseline gap-1">
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-[var(--ug-text-3)]">CTR</span>
            <b className="text-[13px] font-semibold text-[var(--ug-text-1)]">{ctrLabel}</b>
          </span>
        ) : null}
        {scrollLabel ? (
          <span
            data-testid="canvas-stat-scroll"
            title="scroll>50% 到達率"
            className="inline-flex items-baseline gap-1"
          >
            <span className="text-[10.5px] tracking-[0.04em] text-[var(--ug-text-3)]">到達率</span>
            <b className="text-[13px] font-semibold text-[var(--ug-text-1)]">{scrollLabel}</b>
          </span>
        ) : null}
        {dwellLabel ? (
          <span data-testid="canvas-stat-dwell" className="inline-flex items-baseline gap-1">
            <span className="text-[10.5px] tracking-[0.04em] text-[var(--ug-text-3)]">滞留</span>
            <b className="text-[13px] font-semibold text-[var(--ug-text-1)]">{dwellLabel}</b>
          </span>
        ) : null}
      </div>

      <div className="ml-1 flex shrink-0 gap-1 border-l border-[var(--ug-border)] pl-1.5">
        <ToolbarIconBtn
          testid="toggle-controls-btn"
          active={controlsVisible}
          onClick={onToggleControls}
          title="フィルタバー 表示/非表示"
          icon={
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="7" y1="12" x2="17" y2="12" />
              <line x1="10" y1="18" x2="14" y2="18" />
            </svg>
          }
        />
        <ToolbarIconBtn
          testid="toggle-side-btn"
          active={sideVisible}
          onClick={onToggleSide}
          title="右パネル 表示/非表示"
          icon={
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          }
        />
        <ToolbarIconBtn
          testid="enter-fullscreen-btn"
          onClick={onEnterFullscreen}
          title="全画面表示 (Esc で戻る)"
          icon={
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9V5a2 2 0 0 1 2-2h4" />
              <path d="M15 3h4a2 2 0 0 1 2 2v4" />
              <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
              <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
            </svg>
          }
        />
      </div>
    </div>
  )
}

function ToolbarIconBtn({
  testid,
  active,
  onClick,
  title,
  icon,
}: {
  testid: string
  active?: boolean
  onClick: () => void
  title: string
  icon: JSX.Element
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={title}
      className={
        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition ' +
        (active
          ? 'border-[rgba(79,107,255,.25)] bg-[var(--ug-accent-bg)] text-[var(--ug-brand-1)]'
          : 'border-[var(--ug-border)] bg-white text-[var(--ug-text-2)] hover:border-[var(--ug-brand-1)] hover:text-[var(--ug-brand-1)]')
      }
    >
      {icon}
    </button>
  )
}
