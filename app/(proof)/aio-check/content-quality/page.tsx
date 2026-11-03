import Stub from '@/components/aiseo/Stub'

export default function ContentQualityPage() {
  return (
    <Stub
      title="記事コンテンツ品質"
      subtitle="個別記事が、AIに引用・要約されるに足る品質か（一次情報性・具体性・鮮度）を診断。"
      layer="AIO診断"
      willShow="記事別の一次情報スコア・古い情報/根拠不足箇所の指摘・競合上位記事との差分。"
      dataSource="記事本文解析（linkscrawl） ＋ 競合上位記事との比較。"
    />
  )
}
