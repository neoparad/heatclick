/**
 * HeatmapAccessibleTable — canvas で読めない hotspot を screen reader 用に並列提示
 *
 * 親 SSOT Part V §5.5.1 P-04 / mockup parity rebuild §4 Step 11 / Codex review HIGH-3
 *
 * mockup parity 後は visual overlay が `HeatmapViewModel.hotspotCards / tags` を
 * 表示しているため、SR table も同じ view-model を読む方が視覚との整合が取れる。
 * tiles を fallback として保持 (実 data の点を見たい advanced ユーザー向け)。
 */

import type { HeatmapTile } from '@/lib/api/heatmap'
import type { HeatmapViewModel } from '@/lib/heatmap/types'

interface HeatmapAccessibleTableProps {
  viewModel: HeatmapViewModel
  tiles: HeatmapTile[]
  layer: string
  pageUrl: string
}

const RAW_TOP_N = 30

export function HeatmapAccessibleTable({
  viewModel,
  tiles,
  layer,
  pageUrl,
}: HeatmapAccessibleTableProps) {
  const cards = viewModel.hotspotCards
  const rawTop = tiles
    .flatMap((tile) => tile.points.map((p) => ({ ...p, y_start: tile.y_start })))
    .sort((a, b) => b.count - a.count)
    .slice(0, RAW_TOP_N)

  return (
    <div className="sr-only" data-testid="heatmap-accessible-table">
      <h2>
        {layer} ヒートマップ ({pageUrl}) のホットスポット一覧
      </h2>
      <p>
        canvas 上に表示されている上位ホットスポット {cards.length} 件と、
        集計 hotspot 数値を表で並列提示しています。
      </p>

      <table>
        <caption>主要 hotspot (mockup parity、強度順)</caption>
        <thead>
          <tr>
            <th scope="col">順位</th>
            <th scope="col">名称</th>
            <th scope="col">セレクタ</th>
            <th scope="col">主要感情</th>
            <th scope="col">主要数値</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td>{c.rank}</td>
              <td>{c.name}</td>
              <td>{c.selector}</td>
              <td>{c.emotionLabel}</td>
              <td>{c.stats.map((s) => `${s.label} ${s.value}`).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {rawTop.length > 0 ? (
        <table>
          <caption>raw event data (実 tracking 由来、上位 {rawTop.length} 件)</caption>
          <thead>
            <tr>
              <th scope="col">X (px)</th>
              <th scope="col">Y (px)</th>
              <th scope="col">クリック数</th>
              <th scope="col">ユニークセッション</th>
            </tr>
          </thead>
          <tbody>
            {rawTop.map((p, i) => (
              <tr key={`${p.x}-${p.y}-${i}`}>
                <td>{p.x}</td>
                <td>{p.y}</td>
                <td>{p.count}</td>
                <td>{p.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
