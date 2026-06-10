/**
 * HeatOverlay — `.hm-page` の上に絶対配置するヒート overlay 全般
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04 / mockup `01_heatmap_canvas.html` `.heat-overlay` etc.
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §4 Step 4
 *
 * 担当:
 *   - heat-blob (radial gradient, click / attention / emotion)
 *   - heat-tag (常時ラベル)
 *   - att-mode (熟読 blob)
 *   - end-bands (スクロール終了 % band)
 *   - exit-overlay (section 別離脱率)
 *
 * 表示制御:
 *   - layers Set に key が含まれていれば描画
 *   - emotion blob は activeEmotions Set にあるものだけ描画
 *
 * pointer-events:
 *   - overlay コンテナ自体は none、blob / tag だけ auto。
 */

import { type CSSProperties, type RefObject, useMemo } from 'react'

import {
  END_BAND_BG,
  EXIT_ROW_BG,
  blobGradient,
} from '@/lib/heatmap/mockup-spec'
import type {
  EmotionKey,
  HeatBlob,
  HeatTag,
  HeatmapViewModel,
  LayerKey,
  ReadBand,
  ScrollReachBand,
} from '@/lib/heatmap/types'

interface HeatOverlayProps {
  vm: HeatmapViewModel
  layers: ReadonlySet<LayerKey>
  activeEmotions: ReadonlySet<EmotionKey>
  highlightedTagId: string | null
  onTagClick?: (tagId: string) => void
  /** parent でフォーカス scroll に使うため、tag に attach する ref map */
  tagRefs?: RefObject<Map<string, HTMLButtonElement | null>>
  /**
   * 続 117 v2: vm の座標は capture CSS px 空間 (referenceWidth × pageHeight)。
   * `<img width:100%>` の縮小率 (= actualOuterWidth / referenceWidth) を各要素に掛けて
   * 画像とピクセル一致させる。Phase 1 fallback / fixture は 1 (mockup 720 空間そのまま)。
   */
  displayScale?: number
}

export function HeatOverlay({
  vm,
  layers,
  activeEmotions,
  highlightedTagId,
  onTagClick,
  tagRefs,
  displayScale = 1,
}: HeatOverlayProps) {
  const visibleBlobs = useMemo(
    () => vm.blobs.filter((b) => blobVisible(b, layers, activeEmotions)),
    [vm.blobs, layers, activeEmotions],
  )

  const clickLayerOn = layers.has('click')

  return (
    <div
      className="heat-overlay pointer-events-none absolute inset-0"
      data-testid="heat-overlay"
    >
      {visibleBlobs.map((b) => (
        <div
          key={b.id}
          data-testid={`heat-blob-${b.id}`}
          className={
            'heat-blob ' +
            (b.mode === 'click'
              ? `click-mode${b.severity === 'strong' ? ' strong' : ''}`
              : b.mode === 'attention'
                ? `att-mode${b.severity === 'strong' ? ' strong' : ''}`
                : `emo-${b.emotion ?? 'hes'}`) +
            ' pointer-events-auto absolute rounded-full'
          }
          style={blobStyle(b, displayScale)}
          aria-hidden
        />
      ))}

      {clickLayerOn
        ? vm.tags.map((t) => (
            <TagPill
              key={t.id}
              tag={t}
              highlighted={highlightedTagId === t.id}
              onClick={onTagClick}
              refMap={tagRefs}
              displayScale={displayScale}
            />
          ))
        : null}

      {layers.has('end') ? (
        <div className="end-bands pointer-events-none absolute inset-0" data-testid="end-bands">
          {vm.endBands.map((band, i) => (
            <div
              key={`end-${i}`}
              className={`end-band ${band.tier} absolute left-0 right-0 flex items-center px-[14px] py-1 font-mono text-[11px] font-bold text-white`}
              style={{
                top: band.top * displayScale,
                height: band.height * displayScale,
                background: END_BAND_BG[band.tier],
                mixBlendMode: 'multiply',
                textShadow: '0 1px 2px rgba(0,0,0,.25)',
                borderBottom: '1px dashed rgba(255,255,255,.4)',
              }}
              data-testid={`end-band-${band.tier}`}
            >
              <span>{band.reachedLabel}</span>
              <span className="ml-auto">{band.survivalPct}</span>
            </div>
          ))}
        </div>
      ) : null}

      {layers.has('exit') ? (
        <ExitGradientOverlay rows={vm.exitRows} displayScale={displayScale} />
      ) : null}

      {layers.has('attention') && vm.readBands.length > 0 ? (
        <ReadBandOverlay
          bands={vm.readBands}
          displayScale={displayScale}
        />
      ) : null}

      {layers.has('scroll') && vm.scrollReachBands.length > 0 ? (
        <ScrollReachOverlay
          bands={vm.scrollReachBands}
          displayScale={displayScale}
        />
      ) : null}
    </div>
  )
}

/**
 * 熟読 (read / attention) バンドオーバーレイ。
 * 全幅の帯を intensity に応じた warm-to-cool gradient で描画。
 * intensity = count / maxCount (0..1)。強い帯ほど赤寄り・不透明。
 */
/** intensity [0,1] → warm rgba (low=yellow-green, high=red)。 */
function readHeatColor(intensity: number): string {
  const r = Math.round(50 + intensity * 165)
  const g = Math.round(161 - intensity * 130)
  const b = Math.round(80 - intensity * 70)
  const alpha = 0.16 + intensity * 0.44
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`
}

function ReadBandOverlay({
  bands,
  displayScale,
}: {
  bands: ReadBand[]
  displayScale: number
}) {
  // 続124 ④ (Owner: 「グラデーションのはずがセクションで切れている」):
  // 帯ごとのベタ塗り (200px 階段) をやめ、バンド中心を color stop にした
  // **連続 linear-gradient 1 枚**で描く。隣接バンド間は CSS が線形補間 = 滑らかな熱表現。
  // データの無いギャップ (バンド間隔 > 2×bin) には透明 stop を挟み、
  // 「計測していない場所に熱がある」嘘の絵は作らない (D-07)。
  const sorted = [...bands].sort((a, b) => a.top - b.top)
  const maxBottom = sorted.reduce((m, b) => Math.max(m, b.top + b.height), 0)

  const stops: string[] = []
  if (maxBottom > 0) {
    stops.push('rgba(80,161,80,0) 0%')
    for (let i = 0; i < sorted.length; i++) {
      const band = sorted[i]
      const prev = sorted[i - 1]
      // ギャップ検出: 前バンドの下端から 2 bin 以上離れていたら透明で区切る
      if (prev && band.top - (prev.top + prev.height) > prev.height * 2) {
        const prevEndPct = (((prev.top + prev.height) / maxBottom) * 100).toFixed(2)
        const curStartPct = ((band.top / maxBottom) * 100).toFixed(2)
        stops.push(`rgba(80,161,80,0) ${prevEndPct}%`, `rgba(80,161,80,0) ${curStartPct}%`)
      }
      const centerPct = (((band.top + band.height / 2) / maxBottom) * 100).toFixed(2)
      stops.push(`${readHeatColor(band.intensity)} ${centerPct}%`)
    }
    stops.push('rgba(80,161,80,0) 100%')
  }

  return (
    <div
      className="read-band-overlay pointer-events-none absolute inset-0"
      data-testid="read-band-overlay"
    >
      {maxBottom > 0 ? (
        <div
          className="absolute left-0 right-0"
          style={{
            top: 0,
            height: maxBottom * displayScale,
            background: `linear-gradient(180deg, ${stops.join(', ')})`,
            mixBlendMode: 'multiply',
          }}
          aria-hidden
        />
      ) : null}
      {/* 熟読の強いゾーンのみ session 数ラベルを表示 (clutter 回避) */}
      {sorted
        .filter((b) => b.intensity > 0.55)
        .map((band, i) => (
          <div
            key={`read-label-${i}`}
            className="absolute right-[10px] font-mono text-[10px] font-semibold"
            style={{
              top: (band.top + band.height / 2) * displayScale - 7,
              color: 'rgba(100,20,20,.75)',
              textShadow: '0 1px 1px rgba(255,255,255,.7)',
            }}
            aria-hidden
          >
            {band.sessions.toLocaleString()} sessions
          </div>
        ))}
    </div>
  )
}

/**
 * スクロール到達率 (scroll reach) オーバーレイ。
 * 続125 ②: 帯のベタ塗り (段差) をやめ、バンド中心を color stop にした連続 gradient 1 枚 +
 * 10% 刻みの reach% ラベル。バンドは view-model が 0..95% を連続で出すため
 * 構造的に screenshot 全高をカバーする (途切れ不可能)。
 */
function ScrollReachOverlay({
  bands,
  displayScale,
}: {
  bands: ScrollReachBand[]
  displayScale: number
}) {
  const sorted = [...bands].sort((a, b) => a.top - b.top)
  const maxBottom = sorted.reduce((m, b) => Math.max(m, b.top + b.height), 0)

  const stops: string[] = []
  if (maxBottom > 0) {
    for (const band of sorted) {
      const centerPct = (((band.top + band.height / 2) / maxBottom) * 100).toFixed(2)
      const alpha = 0.08 + band.reach * 0.4
      stops.push(`rgba(47,134,224,${alpha.toFixed(2)}) ${centerPct}%`)
    }
  }

  // ラベルは 10% 刻み (= 2 バンドごと) のみ表示して clutter を避ける
  const labeled = sorted.filter((_, i) => i % 2 === 0)

  return (
    <div
      className="scroll-reach-overlay pointer-events-none absolute inset-0"
      data-testid="scroll-reach-overlay"
    >
      {maxBottom > 0 ? (
        <div
          className="absolute left-0 right-0"
          style={{
            top: 0,
            height: maxBottom * displayScale,
            background: `linear-gradient(180deg, ${stops.join(', ')})`,
            mixBlendMode: 'multiply',
          }}
          aria-hidden
        />
      ) : null}
      {labeled.map((band, i) => (
        <div
          key={`scroll-reach-label-${i}`}
          className="absolute left-[10px] font-mono text-[10.5px] font-bold"
          style={{
            top: (band.top + band.height / 2) * displayScale - 7,
            color: 'rgba(10,40,90,.85)',
            textShadow: '0 1px 1px rgba(255,255,255,.7)',
          }}
          data-testid={`scroll-reach-band-${i}`}
          aria-hidden
        >
          {band.reachLabel}
        </div>
      ))}
    </div>
  )
}

/**
 * 続125 ②: 離脱 (exit) グラデーションオーバーレイ。
 * view-model が 0..95% 全スロットを連続で出す (dropoff=0 は透明) ため全高カバー。
 * dropoff >= 5% のスロットのみ右側にラベル表示。
 */
function ExitGradientOverlay({
  rows,
  displayScale,
}: {
  rows: import('@/lib/heatmap/types').ExitRow[]
  displayScale: number
}) {
  const sorted = [...rows].sort((a, b) => a.top - b.top)
  const maxBottom = sorted.reduce((m, r) => Math.max(m, r.top + r.height), 0)
  const maxDrop = sorted.reduce((m, r) => Math.max(m, r.dropoff ?? 0), 0)

  const stops: string[] = []
  if (maxBottom > 0) {
    for (const row of sorted) {
      const centerPct = (((row.top + row.height / 2) / maxBottom) * 100).toFixed(2)
      const norm = maxDrop > 0 ? (row.dropoff ?? 0) / maxDrop : 0
      const alpha = norm * 0.5
      stops.push(`rgba(214,69,69,${alpha.toFixed(2)}) ${centerPct}%`)
    }
  }

  const labeled = sorted.filter((r) => (r.dropoff ?? 0) >= 0.05)

  return (
    <div
      className="exit-overlay pointer-events-none absolute inset-0"
      data-testid="exit-overlay"
    >
      {maxBottom > 0 ? (
        <div
          className="absolute left-0 right-0"
          style={{
            top: 0,
            height: maxBottom * displayScale,
            background: `linear-gradient(180deg, ${stops.join(', ')})`,
            mixBlendMode: 'multiply',
          }}
          aria-hidden
        />
      ) : null}
      {labeled.map((row, i) => (
        <div
          key={`exit-label-${i}`}
          className="absolute right-[10px] rounded px-1.5 py-px font-mono text-[10.5px] font-bold"
          style={{
            top: (row.top + row.height / 2) * displayScale - 8,
            color: '#fff',
            background: EXIT_ROW_BG[row.level],
            textShadow: '0 1px 2px rgba(0,0,0,.3)',
          }}
          data-testid={`exit-row-${row.level}`}
          aria-hidden
        >
          {row.sectionLabel} 離脱 {row.exitPct}
        </div>
      ))}
    </div>
  )
}

function blobVisible(
  b: HeatBlob,
  layers: ReadonlySet<LayerKey>,
  activeEmotions: ReadonlySet<EmotionKey>,
): boolean {
  if (b.mode === 'click') return layers.has('click')
  if (b.mode === 'attention') return layers.has('attention')
  if (b.mode === 'emotion') {
    if (!layers.has('emo')) return false
    if (!b.emotion) return true
    return activeEmotions.has(b.emotion)
  }
  return false
}

function blobStyle(b: HeatBlob, displayScale: number): CSSProperties {
  // blur も scale して、縮小時に blob が過度にボケない / 拡大時に固くならないよう追従させる。
  const blur = Math.max(3, Math.round(8 * displayScale))
  return {
    left: b.x * displayScale,
    top: b.y * displayScale,
    width: b.width * displayScale,
    height: b.height * displayScale,
    background: blobGradient({ mode: b.mode, severity: b.severity, emotion: b.emotion }),
    filter: `blur(${blur}px)`,
    mixBlendMode: 'multiply',
    cursor: 'pointer',
  }
}

function TagPill({
  tag,
  highlighted,
  onClick,
  refMap,
  displayScale,
}: {
  tag: HeatTag
  highlighted: boolean
  onClick?: (id: string) => void
  refMap?: RefObject<Map<string, HTMLButtonElement | null>>
  displayScale: number
}) {
  const numBg =
    tag.intent === 'warn'
      ? 'var(--ug-red, #d64545)'
      : tag.intent === 'win'
        ? 'var(--ug-green, #39a169)'
        : 'var(--ug-brand-1, #4F6BFF)'

  return (
    <button
      type="button"
      ref={(el) => {
        refMap?.current?.set(tag.id, el)
      }}
      onClick={onClick ? () => onClick(tag.id) : undefined}
      data-testid={`heat-tag-${tag.rank}`}
      className={
        'heat-tag ' +
        (tag.intent === 'warn' ? 'warn ' : tag.intent === 'win' ? 'win ' : '') +
        'pointer-events-auto absolute inline-flex items-center whitespace-nowrap rounded-full border bg-white px-2 py-[3px] font-mono text-[10.5px] font-semibold transition-transform'
      }
      style={{
        // 座標は capture CSS px → displayScale で img と整列。pill 自体のサイズ / font は固定
        // (label は読みやすさ優先で縮小しない、anchor だけ移動)。
        left: tag.x * displayScale,
        top: tag.y * displayScale,
        borderColor: 'var(--ug-border, #e7e8ec)',
        color: 'var(--ug-text, #0a0b0d)',
        boxShadow:
          '0 4px 12px rgba(15,17,23,.06), 0 1px 3px rgba(15,17,23,.04)',
        transform: highlighted ? 'scale(1.15)' : undefined,
        zIndex: highlighted ? 20 : 1,
      }}
      aria-label={`hotspot rank ${tag.rank}: ${tag.label}, ${tag.count.toLocaleString()} clicks`}
    >
      <span
        className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white"
        style={{ background: numBg }}
      >
        {tag.rank}
      </span>
      {tag.label} · {tag.count.toLocaleString()}
    </button>
  )
}
