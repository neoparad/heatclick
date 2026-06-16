/**
 * Dashboard dummy data fixtures (Sprint 1 only)
 *
 * 親 SSOT §6.4 Sprint 1 / Part V §5.5.1 P-03
 *
 * Sprint 1 では実 ML データが流入していないため、UI 実装と Owner デモ用の
 * 固定ダミーを返す。Sprint 2 (S2-01 実流入確認 + S2-02 Data Quality Gate) で
 * `/api/v1/insights/[site_id]` に切替予定。
 *
 * Evidence Level (§1.6 / §1.8.2 / D-07):
 *   - proven  : A/B + 統計有意 (p<0.05) で実測済み
 *   - observed: 実流入データから観測 (集計値)
 *   - inferred: LLM / ML の推論 (実測なし)
 *   - planned : ロードマップ上の予測 (未流入)
 *
 * Sprint 1 dummy はすべて inferred / planned 扱い。UI 側で「Sprint 1 は
 * dummy data。Sprint 2 で実流入切替」バナーを必ず表示する。
 */

/**
 * EvidenceLevel — D-07 SSOT (4-tier V1)
 *
 * 5-tier V2 (`EvidenceLevelV2`) は `types/evidence.ts` に独立配備 (続 68 W2-A)。
 * V1 ⇄ V2 変換は `toEvidenceLevelV1()` / `toEvidenceLevelV2()` 経由。
 * 既存 UI / fixture / ChatReply 経路は V1 維持で破壊なし。
 */
export type EvidenceLevel = 'proven' | 'observed' | 'inferred' | 'planned'

export interface EvidenceMeta {
  level: EvidenceLevel
  confidence: number // 0-1
  /** evidence_data references (Sprint 2 以降で session_id / event_id) */
  references: string[]
}

export interface KpiCard {
  id: string
  label: string
  value: string
  unit?: string
  /** trend percentage (positive/negative) */
  delta?: number
  /** "vs last 7 days" など */
  deltaLabel?: string
  /** sparkline 用簡易データ (0-100 にスケール) */
  spark?: number[]
  /** highlight = brand gradient で目立たせる */
  highlight?: boolean
  evidence: EvidenceMeta
}

export type InsightCategory =
  | 'alert' // CV loss / bug / urgent
  | 'pattern' // 新パターン発見
  | 'win' // 施策が CV+ に効いた
  | 'persona' // 新ペルソナ
  | 'speed' // パフォーマンス劣化

export interface InsightItem {
  id: string
  category: InsightCategory
  meta: string
  title: string
  description: string
  timestamp: string // ISO
  evidence: EvidenceMeta
  /** proposal ticket id linkage (e.g. PROP-002) */
  proposalRef?: string
}

export interface AlertItem {
  id: string
  severity: 'warn' | 'info' | 'good'
  title: string
  detail: string
  timestamp: string // HH:mm
}

export interface DashboardData {
  siteName: string
  siteId: string
  generatedAt: string // ISO
  isDummy: boolean
  kpis: KpiCard[]
  insights: InsightItem[]
  alerts: AlertItem[]
}

const NOW = () => new Date().toISOString()

export function getDummyDashboard(siteId: string = 'site_bihada_demo'): DashboardData {
  return {
    siteName: 'bihadashop.jp',
    siteId,
    generatedAt: NOW(),
    isDummy: true,
    kpis: [
      {
        id: 'sessions',
        label: 'Sessions',
        value: '19,766',
        delta: 8.4,
        deltaLabel: 'vs 先週',
        spark: [42, 48, 44, 56, 52, 64, 70, 78],
        evidence: { level: 'planned', confidence: 0.0, references: [] },
      },
      {
        id: 'cv',
        label: 'CV',
        value: '428',
        unit: '件',
        delta: -2.1,
        deltaLabel: 'vs 先週',
        spark: [72, 68, 70, 64, 60, 56, 54, 48],
        evidence: { level: 'planned', confidence: 0.0, references: [] },
      },
      {
        id: 'cvr',
        label: 'CVR',
        value: '2.16',
        unit: '%',
        delta: -0.22,
        deltaLabel: 'pt vs 先週',
        spark: [80, 76, 74, 70, 64, 60, 58, 54],
        evidence: { level: 'planned', confidence: 0.0, references: [] },
      },
      {
        // B-2 (a) fix (Reviewer T1 dual 続 10):
        // 旧: value '+¥1.24M' = inferred で断定数値 → D-07 違反。
        // 修正: range 表記 + 「推定」prefix で不確実性を一次的に伝える。
        id: 'lift',
        label: '推定リフトポテンシャル',
        value: '推定 +¥0.8M〜1.5M',
        unit: '/月 (P1 施策 4 件想定)',
        deltaLabel: '実測ではなく推定値、Sprint 2 で実流入切替',
        highlight: true,
        evidence: { level: 'inferred', confidence: 0.42, references: [] },
      },
      {
        id: 'bottleneck',
        label: '最大ボトルネック',
        value: '商品詳細 → カート',
        unit: '73.5% 離脱',
        evidence: { level: 'inferred', confidence: 0.0, references: [] },
      },
    ],
    insights: [
      {
        id: 'ins-001',
        category: 'alert',
        meta: 'ALERT · CV LOSS · P1',
        title: 'SP モバイルのカート追加 CTA が 73.5% 離脱している',
        description:
          '商品詳細から add_to_cart への遷移で SP セッション 4,562 が離脱。主因は hesitation 42% / comparison 31%。AI 施策提案 PROP-002 が起票済み。',
        timestamp: NOW(),
        proposalRef: 'PROP-002',
        evidence: { level: 'inferred', confidence: 0.0, references: [] },
      },
      {
        id: 'ins-002',
        category: 'pattern',
        meta: 'INSIGHT · BEHAVIOR PATTERN · 新検出',
        title: 'レビュー欄に「サンプル」言及が急増 (127件・前週比 +82%)',
        description:
          'テキストマイニングで frustration 主成因と判定。サンプル請求動線の不在が離脱要因。施策提案 PROP-005 起票。',
        timestamp: NOW(),
        proposalRef: 'PROP-005',
        evidence: { level: 'inferred', confidence: 0.0, references: [] },
      },
      {
        // B-2 (b) fix (Reviewer T1 dual 続 10):
        // 旧: 'win' カテゴリで planned レベルなのに「+0.18pt 押し上げ」「CVR 1.98→2.16%」実績表記 → D-07 違反。
        // 修正: 仮説扱い・A/B テスト計画中の表記に変更。実測値は proven/observed まで非表示。
        id: 'ins-003',
        category: 'pattern',
        meta: 'HYPOTHESIS · PROP-008 計画中 · 効果不確定',
        title: 'フッター「30日返金保証」バッジで CV 改善が見込まれる (仮説)',
        description:
          'anxiety パターン -20% 前後の改善余地を ML が推定。A/B テスト計画中、効果は未確定。Sprint 2 で実走行 → 数値確定後に WIN カテゴリへ昇格予定。',
        timestamp: NOW(),
        proposalRef: 'PROP-008',
        evidence: { level: 'planned', confidence: 0.0, references: [] },
      },
      {
        id: 'ins-004',
        category: 'persona',
        meta: 'PERSONA · 新クラスタ · auto-detected',
        title: '「毎晩検討中の 30 代女性」が 12,840 sessions 検出',
        description:
          'レビュータブを 52s 以上閲覧 + 他社サイトと並行 tab → カート未追加 のパターン。専用 LP の検討余地。',
        timestamp: NOW(),
        evidence: { level: 'inferred', confidence: 0.0, references: [] },
      },
      {
        id: 'ins-005',
        category: 'speed',
        meta: 'SPEED · 低下傾向',
        title: '商品詳細ページの LCP が 3.2s → 4.2s に悪化 (過去 14 日)',
        description:
          'hero 画像 1.4MB が render-blocking。LCP > 4s セッションは bounce +18pt、CVR -32%。PROP-003 進行中。',
        timestamp: NOW(),
        proposalRef: 'PROP-003',
        evidence: { level: 'planned', confidence: 0.0, references: [] },
      },
    ],
    alerts: [
      {
        id: 'alt-001',
        severity: 'warn',
        title: 'CVR が業界中央値を下回りました',
        detail: '2.16% vs 2.96% (median)',
        timestamp: '14:32',
      },
      {
        id: 'alt-002',
        severity: 'info',
        title: '新規ペルソナ「毎晩検討 30 代女性」検出',
        detail: '12,840 sessions',
        timestamp: '11:08',
      },
      {
        id: 'alt-003',
        severity: 'warn',
        title: 'LCP が threshold (4s) を超過',
        detail: '8 ページで発生',
        timestamp: '09:42',
      },
      {
        // B-2 (c) fix (Reviewer T1 dual 続 10):
        // 旧: severity=good で「統計的有意 p=0.012」断定 → level メタなしで D-07 違反。
        // 修正: Sprint 1 dummy で実測値は不在のため「計画中」表記に変更。
        // Sprint 2 で proven 昇格と同時に severity=good + 数値復活。
        id: 'alt-004',
        severity: 'info',
        title: '施策 PROP-008 効果検証スケジュール確定',
        detail: 'A/B テスト計画中 · 実測値は Sprint 2 で確定',
        timestamp: '08:15',
      },
    ],
  }
}
