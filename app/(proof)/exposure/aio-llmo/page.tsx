import Stub from '@/components/aiseo/Stub'

export default function ExposureAioLlmoPage() {
  return (
    <Stub
      title="AIO・LLMO 引用"
      subtitle="ChatGPT / Perplexity / Google AI Overview に、自社が何回・どの問いで引用されたか。"
      layer="露出（AIに見られている度合い）"
      willShow="クエリ別の引用回数・引用順位・引用元URL・競合との引用シェア。"
      dataSource="LLM回答の定点観測（プロンプト群の定期実行）＋ AI Overview スクレイプ。"
    />
  )
}
