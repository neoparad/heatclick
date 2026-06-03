/**
 * Mockup parity fixture — `01_heatmap_canvas.html` の overlay 位置と
 * 右パネル数値を 1:1 で再現する固定値。
 *
 * 親 SSOT §3.6.5 / Part V §5.5.1 P-04
 * Dispatch: 2026-05-29 frontend mockup parity rebuild §5 Phase 1 / §4 Step 10
 *
 * 値は mockup の inline style と本文 (件数 / 離脱率) から抜粋。
 * tile 由来の実 data が不足する field (signal / endBand / exitRow / emotion) を
 * fallback として供給。real data が来ても座標は mockup parity 優先で表示する。
 */

import type { HeatmapViewModel } from '@/lib/heatmap/types'

export const MOCKUP_VIEW_MODEL: HeatmapViewModel = {
  blobs: [
    // 1: CTA "カートに追加" — biggest interaction, dominant hesitation
    { id: 'b-1-hes', mode: 'emotion', emotion: 'hes', x: 248, y: 178, width: 200, height: 160 },
    { id: 'b-1-click', mode: 'click', severity: 'strong', x: 268, y: 188, width: 140, height: 100 },

    // 2: Image gallery — engagement
    { id: 'b-2-eng', mode: 'emotion', emotion: 'eng', x: 30, y: 70, width: 220, height: 220 },
    { id: 'b-2-click', mode: 'click', x: 70, y: 130, width: 130, height: 130 },

    // 3: Reviews tab — comparison
    { id: 'b-3-cmp', mode: 'emotion', emotion: 'cmp', x: 122, y: 360, width: 200, height: 100 },
    { id: 'b-3-click', mode: 'click', x: 142, y: 380, width: 130, height: 60 },

    // 4: Price — hesitation
    { id: 'b-4-hes', mode: 'emotion', emotion: 'hes', x: 262, y: 128, width: 150, height: 70 },

    // 5: Reviews content area — comparison/frustration
    { id: 'b-5-frust', mode: 'emotion', emotion: 'frust', x: 200, y: 510, width: 280, height: 80 },
    { id: 'b-5-click', mode: 'click', x: 230, y: 525, width: 200, height: 50 },

    // attention blobs (att-mode)
    { id: 'b-att-1', mode: 'attention', severity: 'strong', x: 416, y: 380, width: 220, height: 180 },
    { id: 'b-att-2', mode: 'attention', x: 30, y: 90, width: 240, height: 230 },
    { id: 'b-att-3', mode: 'attention', x: 240, y: 488, width: 280, height: 130 },
    { id: 'b-att-4', mode: 'attention', x: 308, y: 130, width: 130, height: 70 },
  ],

  tags: [
    { id: 't-1', rank: 1, label: 'カートCTA', count: 1648, x: 280, y: 156, intent: 'warn' },
    { id: 't-2', rank: 2, label: '商品画像', count: 3114, x: 56, y: 60, intent: 'win' },
    { id: 't-3', rank: 3, label: 'レビュータブ', count: 2841, x: 156, y: 348, intent: 'neutral' },
    { id: 't-4', rank: 4, label: '価格表示', count: 1422, x: 286, y: 116, intent: 'warn' },
    { id: 't-5', rank: 5, label: 'サンプル要望', count: 327, x: 230, y: 498, intent: 'warn' },
  ],

  signals: [
    { id: 's-rage-1', type: 'rage', x: 286, y: 222 },
    { id: 's-rage-2', type: 'rage', x: 310, y: 232 },
    { id: 's-rage-3', type: 'rage', x: 298, y: 246 },
    { id: 's-dead-1', type: 'dead', x: 122, y: 168 },
    { id: 's-dead-2', type: 'dead', x: 148, y: 192 },
    { id: 's-dead-3', type: 'dead', x: 310, y: 138 },
    { id: 's-hover-1', type: 'hover', x: 282, y: 220 },
    { id: 's-hover-2', type: 'hover', x: 308, y: 226 },
    { id: 's-copy-1', type: 'copy', x: 282, y: 158 },
    { id: 's-copy-2', type: 'copy', x: 286, y: 184 },
    { id: 's-copy-3', type: 'copy', x: 168, y: 528 },
    { id: 's-back-1', type: 'backscroll', x: 414, y: 188 },
    { id: 's-back-2', type: 'backscroll', x: 418, y: 248 },
    { id: 's-hes-1', type: 'hesitation', x: 258, y: 200 },
  ],

  endBands: [
    { top: 50, height: 80, reachedLabel: '100% reached', survivalPct: '100%', tier: 'b1' },
    { top: 130, height: 200, reachedLabel: '80% reached', survivalPct: '82%', tier: 'b2' },
    { top: 330, height: 130, reachedLabel: '60% reached', survivalPct: '54%', tier: 'b3' },
    { top: 460, height: 130, reachedLabel: '40% reached', survivalPct: '28%', tier: 'b4' },
    { top: 590, height: 200, reachedLabel: '20% reached', survivalPct: '11%', tier: 'b5' },
  ],

  exitRows: [
    { top: 50, height: 50, sectionLabel: 'header', exitPct: '2.4%', level: 'lo' },
    { top: 100, height: 230, sectionLabel: 'FV (商品画像・価格)', exitPct: '3.8%', level: 'lo' },
    { top: 330, height: 110, sectionLabel: 'CTA + 詳細', exitPct: '22%', level: 'hi' },
    { top: 440, height: 200, sectionLabel: 'レビュー欄', exitPct: '8.1%', level: 'mid' },
    { top: 640, height: 200, sectionLabel: '関連商品', exitPct: '1.6%', level: 'ok' },
  ],

  // Fixture では read / scroll は空 (mockup parity は click + emotion + signal が主役)
  readBands: [],
  scrollReachBands: [],

  emotionSummary: {
    hes: 36,
    eng: 24,
    cmp: 18,
    frust: 12,
    anx: 6,
    conf: 4,
  },

  hotspotCards: [
    {
      id: 'hs-1',
      rank: 1,
      intent: 'warn',
      name: 'カート追加CTA',
      selector: 'button.add-to-cart',
      emotionLabel: 'hes',
      emotionPercents: [
        { key: 'hes', pct: 42 },
        { key: 'cmp', pct: 31 },
        { key: 'frust', pct: 15 },
        { key: 'eng', pct: 12 },
      ],
      stats: [
        { label: 'クリック', value: '1,648' },
        { label: '離脱', value: '73.5%', tone: 'neg' },
        { label: '滞留', value: '14s' },
      ],
    },
    {
      id: 'hs-2',
      rank: 2,
      intent: 'win',
      name: '商品画像ギャラリー',
      selector: '.product-gallery img',
      emotionLabel: 'eng',
      emotionPercents: [
        { key: 'eng', pct: 54 },
        { key: 'conf', pct: 28 },
        { key: 'cmp', pct: 12 },
        { key: 'hes', pct: 6 },
      ],
      stats: [
        { label: 'クリック', value: '3,114' },
        { label: '平均閲覧', value: '4.2 枚' },
        { label: '滞留', value: '38s' },
      ],
    },
    {
      id: 'hs-3',
      rank: 3,
      intent: 'neutral',
      name: 'レビュータブ',
      selector: '[data-tab="reviews"]',
      emotionLabel: 'cmp',
      emotionPercents: [
        { key: 'cmp', pct: 48 },
        { key: 'eng', pct: 24 },
        { key: 'hes', pct: 18 },
        { key: 'frust', pct: 10 },
      ],
      stats: [
        { label: 'クリック', value: '2,841' },
        { label: '誘導後CV', value: '+8.2%', tone: 'pos' },
        { label: '滞留', value: '52s' },
      ],
    },
    {
      id: 'hs-4',
      rank: 4,
      intent: 'warn',
      name: '価格表示',
      selector: '.price-block',
      emotionLabel: 'hes',
      emotionPercents: [
        { key: 'hes', pct: 51 },
        { key: 'cmp', pct: 28 },
        { key: 'frust', pct: 12 },
        { key: 'anx', pct: 9 },
      ],
      stats: [
        { label: '停留', value: '1,422 sessions' },
        { label: '離脱', value: '22%', tone: 'neg' },
      ],
    },
    {
      id: 'hs-5',
      rank: 5,
      intent: 'warn',
      name: 'サンプル要望 (review 内)',
      selector: '.review:contains("サンプル")',
      emotionLabel: 'frust',
      emotionPercents: [
        { key: 'frust', pct: 48 },
        { key: 'hes', pct: 32 },
        { key: 'cmp', pct: 20 },
      ],
      stats: [
        { label: '言及', value: '327 reviews' },
        { label: '該当語', value: '"サンプル"' },
      ],
    },
  ],

  signalCards: [
    {
      id: 'sc-rage',
      type: 'rage',
      name: 'rage_click（怒りクリック）',
      count: 127,
      description: '短時間に同じ位置を 3 回以上連打。要素の応答遅延 / 機能不全の強い示唆。',
      whereLabel: 'カート追加 CTA 周辺に集中。タップ判定領域不足の疑い。',
    },
    {
      id: 'sc-dead',
      type: 'dead',
      name: 'dead_click（無反応クリック）',
      count: 312,
      description: 'クリックされたが何も起きない要素。ユーザーが「ボタン」だと誤認している示唆。',
      whereLabel: '商品画像、価格表示。↑CTA 化? 機会あり。',
    },
    {
      id: 'sc-hover',
      type: 'hover',
      name: 'CTAホバー (クリック未到達)',
      count: 2418,
      description: 'CTA をホバーしたがクリックしなかったセッション。最重要離脱シグナル。',
      whereLabel: 'カートCTA: 2,418 ホバー / 1,648 クリック = 770 セッションが迷って離脱。',
      uniqueBadge: true,
    },
    {
      id: 'sc-copy',
      type: 'copy',
      name: 'テキストコピー検知',
      count: 486,
      description: '位置のみ取得 (内容は取らない PII 配慮)。他タブ比較の起点。',
      whereLabel: '商品名 (256) / 価格 (142) / レビュー本文 (88) — 他社サイトと突合中の可能性。',
      uniqueBadge: true,
    },
    {
      id: 'sc-back',
      type: 'backscroll',
      name: 'スクロール逆戻り',
      count: 1820,
      description: '下にスクロール ↑ 上に戻る動き。情報を「確認したい / 迷っている」サイン。',
      whereLabel: '価格表示 ⇄ カートCTA を行き来。24% が価格セクションで上スクロール。',
    },
    {
      id: 'sc-hes',
      type: 'hesitation',
      name: 'hesitation（迷い）',
      count: 3140,
      description: 'CTA 周辺で 5 秒以上滞留しつつクリックしないセッション。複数シグナルの統合判定。',
      whereLabel: 'カート追加 CTA: hesitation 42% — 最大ボトルネック。',
      uniqueBadge: true,
    },
  ],
}
