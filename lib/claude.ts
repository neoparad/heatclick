// Claude AI 分析クライアント
// 32軸の分析データを受け取り、改善提案・ペルソナ生成を行う

import Anthropic from '@anthropic-ai/sdk'

const apiKey = process.env.CLAUDE_API_KEY
if (!apiKey || apiKey === 'your-claude-api-key') {
  console.warn('CLAUDE_API_KEY is not set. AI analysis features will be unavailable.')
}

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    if (!apiKey || apiKey === 'your-claude-api-key') {
      throw new Error('CLAUDE_API_KEY is not configured')
    }
    client = new Anthropic({ apiKey })
  }
  return client
}

export interface AnalysisRequest {
  siteId: string
  siteName?: string
  siteUrl?: string
  analysisType: 'ux_diagnosis' | 'persona_generation' | 'page_analysis' | 'custom'
  data: Record<string, unknown>
  customPrompt?: string
}

export interface AnalysisResponse {
  analysis: string
  model: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

// UX診断のシステムプロンプト
const UX_DIAGNOSIS_SYSTEM = `あなたはUX/SEO/CROの専門コンサルタントです。
UGOKI MAPのヒートマップ・行動分析データを基に、具体的で実装可能な改善提案を行います。

【出力ルール】
1. 発見した問題を優先度順に並べる（高/中/低）
2. 各問題に対して「現状」→「問題点」→「改善案」→「期待効果」の構造で記述
3. 数値データを必ず引用して根拠を示す
4. 実装の具体性を重視（「UIを改善する」ではなく「CTAボタンをy=800の位置からy=400に移動し、背景色を#2563ebに変更」のレベル）
5. 日本語で出力`

// ペルソナ生成のシステムプロンプト
const PERSONA_GENERATION_SYSTEM = `あなたは行動データ分析の専門家です。
セッション単位の行動プロファイルデータから、3-5個の行動ベースペルソナを自動生成します。

【ペルソナ生成ルール】
1. 行動パターンの類似性でグルーピングし、各グループに象徴的な日本語名をつける
2. 各ペルソナに以下を記述:
   - セッション割合とCVR
   - 推定デモグラフィック（GA4データがある場合は統計マッチングで推定）
   - 行動特徴（スクロール速度・熟読セクション・クリック傾向）
   - 検索意図タイプ
   - CVまでの典型導線
   - このペルソナに最適化されたLP/コンテンツ/広告の提案
3. ペルソナ間の行動差を明確に対比
4. ビジネスインパクトが大きいペルソナを特定
5. 日本語で出力`

// ページ分析のシステムプロンプト
const PAGE_ANALYSIS_SYSTEM = `あなたはランディングページ最適化の専門家です。
ヒートマップデータ・エンゲージメント減衰曲線・摩擦ポイントデータを基に、ページ単位の改善提案を行います。

【出力ルール】
1. ページの強み（読まれているセクション、クリックされているCTA）を特定
2. ページの弱み（離脱ポイント、dead click、認知負荷が高い箇所）を特定
3. セクションごとの改善提案（上から順に）
4. A/Bテストで検証すべき仮説を3つ提案
5. 日本語で出力`

// Claude APIを呼び出してAI分析を実行
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisResponse> {
  const anthropic = getClient()

  let systemPrompt: string
  let userMessage: string

  switch (request.analysisType) {
    case 'ux_diagnosis':
      systemPrompt = UX_DIAGNOSIS_SYSTEM
      userMessage = `以下はサイト「${request.siteName || request.siteId}」（${request.siteUrl || ''}）の行動分析データです。このデータを基にUX診断と改善提案を行ってください。\n\n${JSON.stringify(request.data, null, 2)}`
      break

    case 'persona_generation':
      systemPrompt = PERSONA_GENERATION_SYSTEM
      userMessage = `以下はサイト「${request.siteName || request.siteId}」の行動プロファイルデータです。このデータから行動ベースペルソナを3-5個生成してください。\n\n${JSON.stringify(request.data, null, 2)}`
      break

    case 'page_analysis':
      systemPrompt = PAGE_ANALYSIS_SYSTEM
      userMessage = `以下はページの行動分析データです。このデータを基にページ改善提案を行ってください。\n\n${JSON.stringify(request.data, null, 2)}`
      break

    case 'custom':
      systemPrompt = 'あなたはUX/SEO/CROの専門コンサルタントです。UGOKI MAPの行動分析データを基に分析を行います。日本語で出力してください。'
      userMessage = request.customPrompt || JSON.stringify(request.data, null, 2)
      break

    default:
      throw new Error(`Unknown analysis type: ${request.analysisType}`)
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const textContent = response.content.find(c => c.type === 'text')
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude')
  }

  return {
    analysis: textContent.text,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}

// AI分析が利用可能かチェック
export function isAIAvailable(): boolean {
  return !!apiKey && apiKey !== 'your-claude-api-key'
}
