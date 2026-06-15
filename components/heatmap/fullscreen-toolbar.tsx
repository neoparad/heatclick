/**
 * FullscreenToolbar — 全画面モード時の floating mini toolbar
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.fs-bar`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 8
 *
 * - layer 群: クリック / スクロール (= end) / 感情 (簡易、3 種)
 * - device 群: PC / TAB / SP (シングルセレクト、`.hm-page` 最大幅を制御)
 * - 全画面終了ボタン (Esc 同等)
 */

import { DEVICES, LAYERS } from '@/lib/heatmap/mockup-spec'
import type { DeviceKind, LayerKey } from '@/lib/heatmap/types'

interface FullscreenToolbarProps {
  visible: boolean
  layers: ReadonlySet<LayerKey>
  onToggleLayer: (k: LayerKey) => void
  device: DeviceKind
  onDeviceChange: (d: DeviceKind) => void
  onExit: () => void
}

/** fullscreen layer list: disabled 情報も保持して greyed 表示に使う */
const FS_LAYERS: ReadonlyArray<{
  key: LayerKey
  label: string
  disabled?: boolean
  disabledTooltip?: string
}> = LAYERS.map((l) => ({
  key: l.key,
  label: l.label,
  disabled: l.disabled,
  disabledTooltip: l.disabledTooltip,
}))

export function FullscreenToolbar({
  visible,
  layers,
  onToggleLayer,
  device,
  onDeviceChange,
  onExit,
}: FullscreenToolbarProps) {
  if (!visible) return null
  return (
    <div
      data-testid="fullscreen-toolbar"
      role="toolbar"
      aria-label="全画面ツールバー"
      className="fixed left-1/2 top-4 z-[100] inline-flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1.5 backdrop-blur"
      style={{
        background: 'rgba(20, 22, 28, .92)',
        borderColor: 'rgba(255,255,255,.08)',
        boxShadow: '0 12px 40px rgba(0,0,0,.5)',
      }}
    >
      <div
        className="inline-flex items-center rounded-lg p-0.5"
        style={{ background: 'rgba(255,255,255,.04)' }}
      >
        {FS_LAYERS.map((l) => {
          const active = layers.has(l.key)
          const isDisabled = l.disabled === true
          return (
            <button
              key={l.key}
              type="button"
              data-testid={`fs-layer-${l.key}`}
              onClick={() => !isDisabled && onToggleLayer(l.key)}
              aria-pressed={active}
              aria-disabled={isDisabled}
              disabled={isDisabled}
              title={isDisabled ? l.disabledTooltip : undefined}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] font-medium transition"
              style={
                isDisabled
                  ? { background: 'transparent', color: 'rgba(255,255,255,.25)', cursor: 'not-allowed' }
                  : active
                    ? {
                        background: 'linear-gradient(135deg, #4F6BFF, #A855F7)',
                        color: '#fff',
                        boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                      }
                    : { background: 'transparent', color: 'rgba(255,255,255,.65)' }
              }
            >
              <span>{l.label}</span>
            </button>
          )
        })}
      </div>

      <div className="mx-1 h-[18px] w-px" style={{ background: 'rgba(255,255,255,.10)' }} />

      <div
        className="inline-flex items-center rounded-lg p-0.5"
        style={{ background: 'rgba(255,255,255,.04)' }}
      >
        {DEVICES.map((d) => {
          const active = device === d.key
          return (
            <button
              key={d.key}
              type="button"
              data-testid={`fs-device-${d.key}`}
              onClick={() => onDeviceChange(d.key)}
              aria-pressed={active}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium transition"
              style={
                active
                  ? {
                      background: 'linear-gradient(135deg, #4F6BFF, #A855F7)',
                      color: '#fff',
                      boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                    }
                  : { background: 'transparent', color: 'rgba(255,255,255,.65)' }
              }
            >
              {d.label}
            </button>
          )
        })}
      </div>

      <div className="mx-1 h-[18px] w-px" style={{ background: 'rgba(255,255,255,.10)' }} />

      <button
        type="button"
        onClick={onExit}
        data-testid="fs-exit-btn"
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11.5px] font-medium transition"
        style={{ background: 'transparent', color: '#ffb6b6' }}
        aria-label="全画面を終了"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 9V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4" />
          <path d="M15 15v4a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-4" />
        </svg>
        全画面を終了
        <span
          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[9.5px]"
          style={{ background: 'rgba(255,255,255,.08)', color: 'rgba(255,255,255,.6)' }}
        >
          ESC
        </span>
      </button>
    </div>
  )
}
