import Stub from '@/components/aiseo/Stub'

export default function PageQualityPage() {
  return (
    <Stub
      title="ページ全体品質チェック・クエリファンアウト"
      subtitle="1つの検索意図をAIが複数のサブクエリに分解（クエリファンアウト）した際、そのページがどこまでカバーできているかを診断。"
      layer="AIO診断"
      willShow="対象クエリのファンアウト先サブ意図一覧・各サブ意図への被覆有無・不足セクションの提案。"
      dataSource="AI Overview/回答生成のクエリ分解パターン推定 ＋ ページ構造解析（linkscrawl content_map）。"
    />
  )
}
