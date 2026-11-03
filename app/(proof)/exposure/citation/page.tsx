import Stub from '@/components/aiseo/Stub'

export default function ExposureCitationPage() {
  return (
    <Stub
      title="サイテーション分析"
      subtitle="Webの被リンク・言及のうち、どれが AI の引用につながっているか。"
      layer="露出（AIに見られている度合い）"
      willShow="被リンク/言及元の一覧・テーマ・AI引用との相関。競合の引用元との差。"
      dataSource="Common Crawl webgraph（ドメイン単位の被リンク）＋ 引用観測との突合。"
    />
  )
}
