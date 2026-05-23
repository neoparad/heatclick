/**
 * HeatmapAccessibleTable — canvas で読めない hotspot を screen reader 用に並列提示
 *
 * 親 SSOT Part V §5.5.1 P-04 / §5.5 共通設計原則 a11y
 * Sprint 4 末 NVDA / VoiceOver 手動確認の対象。
 *
 * 表示:
 *  - 視覚ユーザーには `sr-only` (Tab で focus したら on-screen 表示する Toggle Sprint 2 で追加)
 *  - 全 tile を結合して top 50 hotspot のみリスト化 (情報過多回避)
 */

import type { HeatmapPoint, HeatmapTile } from '@/lib/api/heatmap'

interface HeatmapAccessibleTableProps {
  tiles: HeatmapTile[]
  layer: string
  pageUrl: string
}

const TOP_N = 50

export function HeatmapAccessibleTable({ tiles, layer, pageUrl }: HeatmapAccessibleTableProps) {
  const points: Array<HeatmapPoint & { docY: number }> = []
  for (const tile of tiles) {
    for (const p of tile.points) {
      points.push({ ...p, docY: p.y })
    }
  }
  const top = points.sort((a, b) => b.count - a.count).slice(0, TOP_N)

  return (
    <div className="sr-only">
      <h2>
        {layer} ヒートマップ ({pageUrl}) のホットスポット一覧
      </h2>
      <p>
        canvas 上に重ね描きされたヒートマップを、点ごとに表で並列提示しています。
        上位 {top.length} 件を表示中。
      </p>
      <table>
        <caption>クリック密度ホットスポット (上位 {top.length} 件)</caption>
        <thead>
          <tr>
            <th scope="col">順位</th>
            <th scope="col">X 座標 (px)</th>
            <th scope="col">Y 座標 (px)</th>
            <th scope="col">クリック数</th>
            <th scope="col">ユニークセッション</th>
          </tr>
        </thead>
        <tbody>
          {top.map((p, i) => (
            <tr key={`${p.x}-${p.docY}-${i}`}>
              <td>{i + 1}</td>
              <td>{p.x}</td>
              <td>{p.docY}</td>
              <td>{p.count}</td>
              <td>{p.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
