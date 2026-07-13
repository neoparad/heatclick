/**
 * lib/paths/poc-pathset.ts — POC seed (経路分析 比較セット)
 *
 * 旧 `lib/fixtures/path-analysis.ts` の dummy (`商品購入 · 3 経路比較`) を、永続化エンティティ
 * PathSet 1 件として表現したもの。Phase 1 dogfood では KV が空でも一覧/詳細がショーケースとして
 * 成立するよう、scenarios の POC_SCENARIOS と同じく list / detail に merge する。
 *
 * D-07: isDummy=true / evidence_level='inferred' (dummy 数値入り)。UI は INFERRED バッジを出し、
 * 断定数値を避ける。Sprint 4 で events 集計由来の observed_approx に置換予定。
 *
 * tenant/site: scenarios POC と同じ linkth_internal + CIP_EcwUTHEZdIOAUqum 固定。
 */

import type { PathSet } from './types'

const POC_TENANT = 'linkth_internal'
const POC_SITE = 'CIP_EcwUTHEZdIOAUqum'
const POC_TS = '2026-05-24T00:00:00.000Z'

export const POC_PATHSET_ID = '00000000-0000-4000-8000-0000000000a1'

export const POC_PATHSETS: ReadonlyArray<PathSet> = [
  {
    id: POC_PATHSET_ID,
    tenant_id: POC_TENANT,
    site_id: POC_SITE,
    name: '商品購入 · 3 経路比較',
    description:
      'TOP 訪問をトリガーに、商品購入までの 3 経路 (直行 / ランキング / FAQ) を比較監視。',
    status: 'monitoring',
    isDummy: true,
    evidence_level: 'inferred',
    evidence_data: {},
    averageCvRate: '4.3%',
    trigger: {
      title: 'トリガー · TOP 訪問',
      url: '/',
      periodDays: 30,
      sessions: '12,450',
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
            url: 'conversion:cart_add',
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
            url: 'conversion:cart_add',
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
            url: 'conversion:cart_add',
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
        summary: {
          cvRate: '2.1%',
          delta: '▼ -3.5pt 前週比 ⚠',
          deltaTone: 'neg',
        },
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
    created_at: POC_TS,
    updated_at: POC_TS,
    created_by: 'poc',
    archived_at: null,
  },
]

/** list ページ用の軽量サマリ (一覧の各行に表示する派生値)。 */
export interface PathSetListSummary {
  branchCount: number
  stepCount: number
  worstSeverity: 'ok' | 'warn' | 'crit'
  analyzed: boolean
}

export function summarizePathSet(pset: PathSet): PathSetListSummary {
  const branchCount = pset.branches.length
  const stepCount = pset.branches.reduce((acc, b) => acc + b.nodes.length, 0)
  const order = { ok: 0, warn: 1, crit: 2 } as const
  let worst: 'ok' | 'warn' | 'crit' = 'ok'
  for (const b of pset.branches) {
    if (order[b.severity] > order[worst]) worst = b.severity
  }
  // 1 ノードでも stats があれば「分析済み」とみなす
  const analyzed = pset.branches.some((b) => b.nodes.some((n) => n.stats.length > 0))
  return { branchCount, stepCount, worstSeverity: worst, analyzed }
}
