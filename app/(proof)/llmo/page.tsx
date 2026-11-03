import Stub from '@/components/aiseo/Stub'

export default function LlmoPage() {
  return (
    <Stub
      title="LLMO分析"
      subtitle="ChatGPT / Perplexity / Claude などの回答に、自社がどれだけ引用されるか。"
      layer="LLMO（AIに見られている度合い）"
      willShow="プロンプト別の引用回数・引用順・引用元URL・競合との引用シェア。"
      dataSource="各LLMの回答の定点観測（プロンプト群の定期実行）。"
    />
  )
}
