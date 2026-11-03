import Stub from '@/components/aiseo/Stub'

export default function DailyPage() {
  return (
    <Stub
      title="日次トラッキング"
      subtitle="AIO・LLMO の露出（引用・順位）の日次推移。施策を打った日と数字の動きを並べる。"
      layer="AIO / LLMO"
      willShow="引用回数・順位の日次折れ線。施策イベントの注記。"
      dataSource="AIO・LLMO 定点観測の日次スナップショット。"
    />
  )
}
