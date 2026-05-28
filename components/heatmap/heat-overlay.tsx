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
} from '@/lib/heatmap/types'

interface HeatOverlayProps {
  vm: HeatmapViewModel
  layers: ReadonlySet<LayerKey>
  activeEmotions: ReadonlySet<EmotionKey>
  highlightedTagId: string | null
  onTagClick?: (tagId: string) => void
  /** parent でフォーカス scroll に使うため、tag に attach する ref map */
  tagRefs?: RefObject<Map<string, HTMLButtonElement | null>>
}

export function HeatOverlay({
  vm,
  layers,
  activeEmotions,
  highlightedTagId,
  onTagClick,
  tagRefs,
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
          style={blobStyle(b)}
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
                top: band.top,
                height: band.height,
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
        <div
          className="exit-overlay pointer-events-none absolute inset-0"
          data-testid="exit-overlay"
        >
          {vm.exitRows.map((row, i) => (
            <div
              key={`exit-${i}`}
              className={`exit-row lvl-${row.level} absolute left-0 right-0 flex items-center px-[14px] py-1 font-mono text-[11px] font-bold text-white`}
              style={{
                top: row.top,
                height: row.height,
                background: EXIT_ROW_BG[row.level],
                mixBlendMode: 'multiply',
                textShadow: '0 1px 2px rgba(0,0,0,.3)',
              }}
              data-testid={`exit-row-${row.level}`}
            >
              <span>
                {row.sectionLabel} — exit
              </span>
              <span className="ml-auto">{row.exitPct}</span>
            </div>
          ))}
        </div>
      ) : null}
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

function blobStyle(b: HeatBlob): CSSProperties {
  return {
    left: b.x,
    top: b.y,
    width: b.width,
    height: b.height,
    background: blobGradient({ mode: b.mode, severity: b.severity, emotion: b.emotion }),
    filter: 'blur(8px)',
    mixBlendMode: 'multiply',
    cursor: 'pointer',
  }
}

function TagPill({
  tag,
  highlighted,
  onClick,
  refMap,
}: {
  tag: HeatTag
  highlighted: boolean
  onClick?: (id: string) => void
  refMap?: RefObject<Map<string, HTMLButtonElement | null>>
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
        left: tag.x,
        top: tag.y,
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
