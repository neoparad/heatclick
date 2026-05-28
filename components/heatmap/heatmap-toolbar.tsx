/**
 * HeatmapToolbar — canvas 上端 (mockup `.hm-canvas-top`)
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.hm-canvas-top`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 7
 *
 * 構成:
 *   - device tabs (PC / SP / TAB)
 *   - URL bar
 *   - stats (PV / CTR / 滞留)
 *   - action buttons (filter 表示/非表示 / side panel / 全画面)
 */

import type { DeviceKind } from '@/lib/heatmap/types'

interface HeatmapToolbarProps {
  device: DeviceKind
  onDeviceChange: (d: DeviceKind) => void
  pageUrl: string
  pvLabel?: string
  ctrLabel?: string
  dwellLabel?: string
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
  pageUrl,
  pvLabel,
  ctrLabel,
  dwellLabel,
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
        className="inline-flex overflow-hidden rounded-md border border-[var(--ug-border)] bg-white"
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

      <div
        className="flex max-w-[460px] flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-[var(--ug-border)] bg-[var(--ug-bg-2)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--ug-text-2)]"
        data-testid="heatmap-url-bar"
      >
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0 text-[var(--ug-green)]"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{pageUrl}</span>
      </div>

      <div className="ml-auto flex items-center gap-3 font-mono text-[10.5px] text-[var(--ug-text-3)]">
        {pvLabel ? (
          <span data-testid="canvas-stat-pv">
            PV <b className="text-[var(--ug-text-1)]">{pvLabel}</b>
          </span>
        ) : null}
        {ctrLabel ? (
          <span data-testid="canvas-stat-ctr">
            CTR <b className="text-[var(--ug-text-1)]">{ctrLabel}</b>
          </span>
        ) : null}
        {dwellLabel ? (
          <span data-testid="canvas-stat-dwell">
            滞留 <b className="text-[var(--ug-text-1)]">{dwellLabel}</b>
          </span>
        ) : null}
      </div>

      <div className="ml-1 flex gap-1 border-l border-[var(--ug-border)] pl-1.5">
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
