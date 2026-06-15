/**
 * Path Analysis dummy fixture — 経路分析エージェント (続 75 Task B)
 *
 * 親 SSOT mockup `linkscrawl/docs/fusion/mockups/11_path_analysis.html`
 * 親 SSOT §3.6.5 / Part V P-11 / D-07
 *
 * Sprint 3 W2-A 範囲:
 *   - 全 path/branch/node は Marketer dummy 草案ベース (isDummy=true)
 *   - 実 ML 結線は Sprint 3 W2 後 (ML 続 68 orchestrator が path_analysis tool 配備時)
 *   - 数値は inferred 扱い、断定表現禁止 (D-07)、UI 側で DummyBanner 常時表示
 *
 * Sprint 4 想定 (続 76+):
 *   - `/api/paths?site_id=<id>&period_days=<n>` で実 ClickHouse path_sessions
 *     mat-view から取得 (Infra 配備待ち)
 *   - Branch 自動検出は ML が経路 frequency mining で生成
 */

export type BranchSeverity = 'ok' | 'warn' | 'crit'
export type NodeBand = 'warn' | 'win' | undefined
export type EdgeBand = 'warn' | 'crit' | undefined

export interface PathNodeStat {
  /** 表示 label (例: '通過'、'離脱'、'CV率') */
  k: string
  /** 値 (例: '7,128'、'88%'、'6.1%') */
  v: string
  /** 値の severity (pos = 緑強調 / neg = 赤強調 / 未指定 = neutral) */
  tone?: 'pos' | 'neg'
}

export interface PathNodePerf {
  /** PageSpeed score 0-100 */
  score: number
  /** LCP 文字列 ('1.8s' 等) */
  lcp: string
  /** node の perf severity (ok / warn / bad) — bar 色 + bg tint に反映 */
  band: 'ok' | 'warn' | 'bad'
}

export interface PathNode {
  id: string
  /** ステップ番号 (例: 'A1', 'B2', 'CV') */
  step: string
  title: string
  url: string
  /** node の severity (warn / win が強調枠線になる、未指定なら neutral) */
  band?: NodeBand
  stats: ReadonlyArray<PathNodeStat>
  perf?: PathNodePerf
  /** Compare 用 selected (mockup の A/B 帯) — Phase 1 では ring 強調のみ */
  selected?: 'A' | 'B' | 'C'
}

export interface PathEdge {
  /** edge label (例: '通過 18%'、'迷い時間 +75%') */
  label: string
  band?: EdgeBand
}

export interface PathBranch {
  id: string
  name: string
  description: string
  severity: BranchSeverity
  /** nodes は順序通り、edges は nodes.length - 1 個 (各 node 間に 1 つ) */
  nodes: ReadonlyArray<PathNode>
  edges: ReadonlyArray<PathEdge>
  summary: {
    cvRate: string
    delta: string
    deltaTone: 'pos' | 'neg'
  }
}

export interface PathAiInsight {
  id: string
  label: string
  body: string
  severity: 'info' | 'warn' | 'crit'
}

export interface PathAnalysisData {
  isDummy: boolean
  /** breadcrumb / h1 表示用の workflow 名 */
  workflowName: string
  trigger: {
    title: string
    url: string
    sessions: string
    periodLabel: string
  }
  branches: ReadonlyArray<PathBranch>
  insights: ReadonlyArray<PathAiInsight>
  meta: {
    siteName: string
    siteId: string
    periodDays: number
    averageCvRate: string
  }
}

export function getDummyPathAnalysis(): PathAnalysisData {
  return {
    isDummy: true,
    workflowName: '商品購入 · 3 経路比較',
    trigger: {
      title: 'トリガー · TOP 訪問',
      url: '/',
      sessions: '12,450',
      periodLabel: '30 日',
    },
    branches: [
      {
        id: 'A',
        name: '経路 A · 商品直行',
        description: '直接商品ページ → カート → 購入',
        severity: 'ok',
        nodes: [
          {
            id: 'A1',
            step: 'A1',
            title: '商品ページ閲覧',
            url: '/products/*',
            selected: 'A',
            stats: [
              { k: '通過', v: '7,128' },
              { k: '滞在', v: '3:42' },
            ],
            perf: { score: 82, lcp: '1.8s', band: 'ok' },
          },
          {
            id: 'A2',
            step: 'A2',
            title: 'カート投入',
            url: 'event:cart_add',
            band: 'warn',
            stats: [
              { k: '通過', v: '1,283' },
              { k: '離脱', v: '88%', tone: 'neg' },
            ],
            perf: { score: 68, lcp: '2.4s', band: 'warn' },
          },
          {
            id: 'A3',
            step: 'CV',
            title: '購入完了',
            url: '/thanks/',
            band: 'win',
            stats: [
              { k: '完了', v: '757', tone: 'pos' },
              { k: 'CV 率', v: '6.1%', tone: 'pos' },
            ],
            perf: { score: 78, lcp: '2.1s', band: 'ok' },
          },
        ],
        edges: [{ label: '通過 18%' }, { label: '通過 65%' }],
        summary: { cvRate: '6.1%', delta: '▲ +0.3pt 前週比', deltaTone: 'pos' },
      },
      {
        id: 'B',
        name: '経路 B · ランキング経由',
        description: 'ランキング比較 → 商品 → カート → 購入',
        severity: 'warn',
        nodes: [
          {
            id: 'B1',
            step: 'B1',
            title: 'ランキング閲覧',
            url: '/ranking',
            stats: [
              { k: '通過', v: '3,485' },
              { k: '滞在', v: '5:18' },
            ],
            perf: { score: 62, lcp: '2.8s', band: 'warn' },
          },
          {
            id: 'B2',
            step: 'B2',
            title: '商品ページ閲覧',
            url: '/products/*',
            selected: 'B',
            stats: [
              { k: '通過', v: '2,562' },
              { k: 'tab 戻り', v: '+180%', tone: 'neg' },
            ],
            perf: { score: 42, lcp: '4.2s', band: 'bad' },
          },
          {
            id: 'B3',
            step: 'B3',
            title: 'カート投入',
            url: 'event:cart_add',
            band: 'warn',
            stats: [
              { k: '通過', v: '307' },
              { k: 'CV 率', v: '54%' },
            ],
            perf: { score: 68, lcp: '2.4s', band: 'warn' },
          },
          {
            id: 'B4',
            step: 'CV',
            title: '購入完了',
            url: '/thanks/',
            stats: [
              { k: '完了', v: '167' },
              { k: 'CV 率', v: '4.8%' },
            ],
            perf: { score: 78, lcp: '2.1s', band: 'ok' },
          },
        ],
        edges: [
          { label: '迷い時間 +75%', band: 'warn' },
          { label: '通過 12%' },
          { label: '通過 54%' },
        ],
        summary: { cvRate: '4.8%', delta: '▼ -1.2pt 前週比', deltaTone: 'neg' },
      },
      {
        id: 'C',
        name: '経路 C · FAQ 経由',
        description: '不安解消 → FAQ → 商品 → 購入',
        severity: 'crit',
        nodes: [
          {
            id: 'C1',
            step: 'C1',
            title: 'FAQ 閲覧',
            url: '/faq',
            stats: [
              { k: '通過', v: '1,837' },
              { k: '熟読', v: '8:24' },
            ],
            perf: { score: 58, lcp: '3.1s', band: 'warn' },
          },
          {
            id: 'C2',
            step: 'C2',
            title: '商品ページ閲覧',
            url: '/products/*',
            band: 'warn',
            stats: [
              { k: '通過', v: '643' },
              { k: '解約検索', v: '+220%', tone: 'neg' },
            ],
            perf: { score: 75, lcp: '2.0s', band: 'ok' },
          },
          {
            id: 'C3',
            step: 'C3',
            title: 'カート投入',
            url: 'event:cart_add',
            band: 'warn',
            stats: [
              { k: '通過', v: '38' },
              { k: '離脱', v: '94%', tone: 'neg' },
            ],
            perf: { score: 68, lcp: '2.4s', band: 'warn' },
          },
          {
            id: 'C4',
            step: 'CV',
            title: '購入完了',
            url: '/thanks/',
            stats: [
              { k: '完了', v: '11', tone: 'neg' },
              { k: 'CV 率', v: '2.1%', tone: 'neg' },
            ],
            perf: { score: 78, lcp: '2.1s', band: 'ok' },
          },
        ],
        edges: [
          { label: '不安継続 65%', band: 'crit' },
          { label: '通過 6%', band: 'crit' },
          { label: '通過 30%' },
        ],
        summary: { cvRate: '2.1%', delta: '▼ -3.5pt 前週比 ⚠', deltaTone: 'neg' },
      },
    ],
    insights: [
      {
        id: 'i1',
        severity: 'crit',
        label: 'パフォーマンス異常 · 1 分前',
        body:
          '経路 B の商品ページの LCP が 4.2 秒（経路 A の同一 URL は 1.8 秒）。' +
          'ランキング経由で追加トラッキングが読み込まれ、ファーストビュー描画が遅延している可能性。' +
          'これが経路 B の CV 率低下の隠れた原因かもしれません。',
      },
      {
        id: 'i2',
        severity: 'warn',
        label: '経路 C 異常検知 · 2 分前',
        body:
          '経路 C (FAQ 経由) の CV 率が 2.1%(-3.5pt) に低下。' +
          'FAQ 熟読後の「解約検索」が +220% 増加 → 解約条件への不安が決定打を欠いている可能性。' +
          'FAQ 内の「定期解約の自由度」セクション追加を推奨。',
      },
    ],
    meta: {
      siteName: 'bihadashop.jp',
      siteId: 'CIP_EcwUTHEZdIOAUqum',
      periodDays: 30,
      averageCvRate: '4.3%',
    },
  }
}
