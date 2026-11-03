import Stub from '@/components/aiseo/Stub'

export default function ExposureDailyPage() {
  return (
    <Stub
      title="日次トラッキング"
      subtitle="露出（引用・順位）の日次推移。施策を打った日と数字の動きを並べる。"
      layer="露出（AIに見られている度合い）"
      willShow="引用回数・順位・流入の日次折れ線。施策イベントの注記。"
      dataSource="AIO・LLMO 引用の定点観測ログ（日次スナップショット）。"
    />
  )
}
