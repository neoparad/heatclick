/**
 * HeatmapLegend — canvas 右下の凡例 (色強度スケール + アクティブ層の指標名)
 *
 * 5 つの data layer (click / 終了 end / 熟読 attention / scroll / 離脱 exit) は実データ由来だが
 * 色だけでは「濃い = どれくらい?」が解釈できないため、層連動の凡例を出す。
 * 色は heat-overlay / mockup-spec.blobGradient の配色に整合させる。
 * move / emo (未収集 / 未実装、disabled) は凡例を出さない。
 *
 * legendSpecFor() は純関数 (テスト対象)。HeatmapLegend は `.hm-page` 内に absolute 配置。
 */

import type { LayerKey } from '@/lib/heatmap/types'

export interface LegendSpec {
  /** アクティブ層の指標名 (例: クリック密度) */
  caption: string
  /** 色スケール (左=弱 → 右=強) の CSS gradient */
  gradient: string
  /** スケール左端ラベル (弱側) */
  lowLabel: string
  /** スケール右端ラベル (強側) */
  highLabel: string
}

// 帯系 (scroll / exit / end) 共通の warm 強度スケール (heat-overlay の intensity 配色に整合)
const WARM_SCALE =
  'linear-gradient(90deg, rgba(57,161,105,.30), rgba(242,201,76,.60) 50%, rgba(214,69,69,.90))'

/** data layer → 凡例仕様。disabled 層 (move/emo) は持たない = 凡例なし。 */
const LEGEND_BY_LAYER: Partial<Record<LayerKey, LegendSpec>> = {
  click: {
    caption: 'クリック密度',
    gradient:
      'linear-gradient(90deg, rgba(79,107,255,.15), rgba(79,107,255,.60) 55%, rgba(168,85,247,.90))',
    lowLabel: '少',
    highLabel: '多',
  },
  attention: {
    caption: '熟読の強さ',
    gradient:
      'linear-gradient(90deg, rgba(166,209,99,.25), rgba(242,201,76,.60) 50%, rgba(214,69,69,.90))',
    lowLabel: '浅',
    highLabel: '深',
  },
  scroll: { caption: 'スクロール到達', gradient: WARM_SCALE, lowLabel: '少', highLabel: '多' },
  exit: { caption: '離脱の集中', gradient: WARM_SCALE, lowLabel: '低', highLabel: '高' },
  end: { caption: '終了の集中', gradient: WARM_SCALE, lowLabel: '低', highLabel: '高' },
}

// 排他選択が基本だが、複数 active 時の優先順 (data layer のみ)。
const LAYER_PRIORITY: ReadonlyArray<LayerKey> = ['click', 'attention', 'scroll', 'exit', 'end']

/** アクティブな data layer から凡例仕様を1つ決める。該当なし (disabled のみ等) は null。 */
export function legendSpecFor(layers: ReadonlySet<LayerKey>): LegendSpec | null {
  for (const key of LAYER_PRIORITY) {
    if (layers.has(key)) {
      const spec = LEGEND_BY_LAYER[key]
      if (spec) return spec
    }
  }
  return null
}

interface HeatmapLegendProps {
  layers: ReadonlySet<LayerKey>
}

export function HeatmapLegend({ layers }: HeatmapLegendProps) {
  const spec = legendSpecFor(layers)
  if (!spec) return null
  return (
    <div
      data-testid="heatmap-legend"
      className="absolute bottom-3 right-3 z-10 flex flex-col gap-1 rounded-md border border-[var(--ug-border)] bg-white/90 px-2.5 py-1.5 shadow-sm backdrop-blur-sm"
    >
      <span className="font-mono text-[10px] tracking-[0.04em] text-[var(--ug-text-3)]">
        {spec.caption}
      </span>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9.5px] text-[var(--ug-text-3)]">{spec.lowLabel}</span>
        <i
          aria-hidden
          style={{ width: 96, height: 8, borderRadius: 4, background: spec.gradient }}
        />
        <span className="font-mono text-[9.5px] text-[var(--ug-text-3)]">{spec.highLabel}</span>
      </div>
    </div>
  )
}
