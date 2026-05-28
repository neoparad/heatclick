/**
 * SignalOverlay — 6 種行動シグナル marker (rage/dead/hover/copy/backscroll/hesitation)
 *
 * 親 SSOT §3.6.5 §1.7 / Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.sig-marker.*`
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 5
 *
 * 表示制御:
 *   - 親 `signalsOn` が false なら全 marker 非表示 (mockup `.heat-overlay.sig-on` 補集合)
 *   - signalsOn が true でも、`enabledSignals` Set に含まれない type は非表示
 *
 * §1.7 Anti-Features 厳守:
 *   - rage / dead / hover / backscroll / hesitation の 5 種は集約イベントのみ表示
 *   - copy は **位置だけ** 表示し、コピーされた本文は描画しない (PII 配慮、mockup と同じ)
 */

import type { SignalKey, SignalMarker } from '@/lib/heatmap/types'

interface SignalOverlayProps {
  signals: SignalMarker[]
  signalsOn: boolean
  enabledSignals: ReadonlySet<SignalKey>
}

// `prefers-reduced-motion` で animation を抑制 (a11y、Codex review MEDIUM fix)
const RAGE_KEYFRAMES = `
@keyframes uh-pulse-rage {
  0%   { box-shadow: 0 0 0 3px rgba(214,69,69,.25), 0 0 0 6px rgba(214,69,69,.12); }
  70%  { box-shadow: 0 0 0 8px rgba(214,69,69,.05), 0 0 0 14px rgba(214,69,69,0); }
  100% { box-shadow: 0 0 0 3px rgba(214,69,69,.25), 0 0 0 6px rgba(214,69,69,.12); }
}
@media (prefers-reduced-motion: reduce) {
  .uh-sig-rage { animation: none !important; }
}
`

export function SignalOverlay({ signals, signalsOn, enabledSignals }: SignalOverlayProps) {
  if (!signalsOn) return null
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: RAGE_KEYFRAMES }} />
      <div
        className="heat-overlay sig-on pointer-events-none absolute inset-0"
        data-testid="signal-overlay"
        aria-hidden
      >
        {signals
          .filter((s) => enabledSignals.has(s.type))
          .map((s) => (
            <SigMarker key={s.id} signal={s} />
          ))}
      </div>
    </>
  )
}

function SigMarker({ signal }: { signal: SignalMarker }) {
  const common = {
    position: 'absolute' as const,
    left: signal.x,
    top: signal.y,
    pointerEvents: 'auto' as const,
    cursor: 'pointer' as const,
  }

  const testid = `sig-marker-${signal.type}-${signal.id}`

  switch (signal.type) {
    case 'rage':
      return (
        <div
          data-testid={testid}
          className="uh-sig-rage sig-marker rage"
          style={{
            ...common,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#d64545',
            boxShadow:
              '0 0 0 3px rgba(214,69,69,.25), 0 0 0 6px rgba(214,69,69,.12)',
            animation: 'uh-pulse-rage 1.6s infinite',
          }}
        />
      )
    case 'dead':
      return (
        <div
          data-testid={testid}
          className="sig-marker dead"
          style={{
            ...common,
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: '#6c6e75',
            boxShadow: '0 0 0 2px rgba(108,110,117,.25)',
          }}
        />
      )
    case 'hover':
      return (
        <div
          data-testid={testid}
          className="sig-marker hover"
          style={{
            ...common,
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'transparent',
            border: '2px dashed #4F6BFF',
          }}
        />
      )
    case 'copy':
      return (
        <div
          data-testid={testid}
          className="sig-marker copy"
          style={{
            ...common,
            width: 36,
            height: 14,
            borderRadius: 2,
            background: 'rgba(201,145,26,.5)',
            border: '1px solid #c9911a',
          }}
        />
      )
    case 'backscroll':
      return (
        <div
          data-testid={testid}
          className="sig-marker backscroll"
          style={{
            ...common,
            width: 22,
            height: 22,
            color: '#39a169',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </div>
      )
    case 'hesitation':
      return (
        <div
          data-testid={testid}
          className="sig-marker hesitation"
          style={{
            ...common,
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(201,145,26,.42) 0%, rgba(201,145,26,0) 75%)',
            border: '1px dashed rgba(201,145,26,.6)',
          }}
        />
      )
  }
}
