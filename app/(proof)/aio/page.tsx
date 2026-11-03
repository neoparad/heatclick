import Stub from '@/components/aiseo/Stub'

export default function AioPage() {
  return (
    <Stub
      title="AIO分析"
      subtitle="Google AI Overview に自社が出ているか・どの問いで・何位で引用されるか。"
      layer="AIO（AIに見られている度合い）"
      willShow="クエリ別の AI Overview 露出・引用順位・引用元URL・競合との露出シェア。"
      dataSource="AI Overview の定点観測（検索クエリ群の定期スクレイプ）。"
    />
  )
}
