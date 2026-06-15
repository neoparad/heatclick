/**
 * Personas dummy data fixture (Sprint 2 W2 — ML S2-03 学習完了通知待ち)
 *
 * 親 SSOT §3.6.5 / Part V §5.5.2 P-05 / decisions.md 続 41 §3 / §5.5.0
 *
 * Marketer S2-04 6 ラベル草案 (5/22-24 完成想定):
 *   Researcher / Buyer / Comparator / Bouncer / Returner / Lost
 *
 * 切替計画:
 *   - 現状 (Sprint 2 W2 前半): 本 fixture から dummy persona を返却
 *   - ML S2-03 完了通知 (5/27 想定) 後: `/api/personas?site_id` 経由で
 *     ClickHouse persona_predictions テーブルから実 cluster を取得し
 *     同 PersonaCluster shape にマップ
 *   - cluster.silhouette_score ≥ 0.4 → evidence_level='observed'
 *     未達 → 'inferred' (Marketer S2-04 mapping 検証案で確定)
 *
 * D-07 規約:
 *   - inferred の場合、persona size は range 表記 + 「推定」prefix
 *   - 比率 (%) は dummy では非表示 (Sprint 2 W2 後半で実データ後切替)
 *   - 断定数値 (例: "全 cv の 42%") は proven / observed のみ
 */

import type { EvidenceMeta } from './dashboard'

/** Marketer S2-04 で確定予定の 6 ラベル */
export type PersonaLabel =
  | 'researcher'
  | 'buyer'
  | 'comparator'
  | 'bouncer'
  | 'returner'
  | 'lost'

export interface PersonaKpi {
  id: string
  label: string
  /** 表示値 — inferred の場合 range / 「推定」prefix 必須 (D-07) */
  value: string
  unit?: string
  evidence: EvidenceMeta
}

export interface PersonaCluster {
  id: string
  /** ML cluster id (e.g. 'persona_classifier:CIP_xxx:cluster_0') */
  refId: string
  label: PersonaLabel
  /** Marketer S2-04 ラベル草案、5/24 完成後に最終確定 */
  displayName: string
  /** 1 行 description (Marketer 草案ベース) */
  description: string
  /** ML cluster の Silhouette ≥ 0.4 → 'observed'、未達 → 'inferred' */
  evidence: EvidenceMeta
  /** persona-level KPI 4 件 (Part V §5.5.2 = KpiCard × 4 per persona) */
  kpis: PersonaKpi[]
  /** Sheet (cluster detail) 用補足 */
  detail: {
    /** 代表行動 3-5 件 */
    behaviors: string[]
    /** 推奨次アクション (Marketer joint で確定) — inferred 時は仮説扱い */
    suggestedActions: string[]
  }
}

export interface PersonasData {
  siteName: string
  siteId: string
  generatedAt: string // ISO
  isDummy: boolean
  /** ML 全体メタ (Part V §5.5.0 API envelope) */
  global: {
    nClusters: number
    silhouetteScore: number
    evidence: EvidenceMeta
  }
  clusters: PersonaCluster[]
}

const NOW = () => new Date().toISOString()

/**
 * inferred persona — ML S2-03 学習完了前の dummy 表示用。
 * D-07 整合のため、size は range + 「推定」prefix、ratio は非表示。
 */
const inferredEvidence = (): EvidenceMeta => ({
  level: 'inferred',
  confidence: 0.0,
  references: [],
})

export function getDummyPersonas(siteId: string = 'site_bihada_demo'): PersonasData {
  return {
    siteName: 'bihadashop.jp',
    siteId,
    generatedAt: NOW(),
    isDummy: true,
    global: {
      nClusters: 6,
      silhouetteScore: 0.0, // dummy = 学習未実行
      evidence: inferredEvidence(),
    },
    clusters: [
      {
        id: 'persona-researcher',
        refId: 'persona_classifier:dummy:cluster_researcher',
        label: 'researcher',
        displayName: 'Researcher (情報収集)',
        description:
          '記事 / レビュー / 比較情報を多面的に閲覧。CV 直近ではないが将来 cv 候補。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 中規模',
            unit: '(Sprint 2 W2 後半に実数値切替)',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 長め',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 低〜中',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 高',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            'レビュータブを 30 秒以上閲覧',
            '商品比較ページに複数回遷移',
            '初訪では cv に到達しない',
            'FAQ / お客様の声 を閲覧',
          ],
          suggestedActions: [
            '比較表 / レビューサマリの強化 (仮説)',
            '再訪導線 (メルマガ / リターゲ) 整備 (仮説)',
          ],
        },
      },
      {
        id: 'persona-buyer',
        refId: 'persona_classifier:dummy:cluster_buyer',
        label: 'buyer',
        displayName: 'Buyer (購入意欲高)',
        description: '直接購入動線をたどる、cv 寄与の中核セグメント想定。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 小〜中規模',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 短〜中',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 高',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 中',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            'PDP → カート遷移が高速',
            '価格 / 在庫 / 配送ページの閲覧時間が短い',
            '初訪 or 2 訪以内に cv',
          ],
          suggestedActions: [
            'cart 内 UX の摩擦削減 (仮説)',
            '配送・返金保証の明示 (仮説)',
          ],
        },
      },
      {
        id: 'persona-comparator',
        refId: 'persona_classifier:dummy:cluster_comparator',
        label: 'comparator',
        displayName: 'Comparator (比較検討)',
        description: '他社サイトと並行 tab、価格 / スペックを横断比較する慎重派。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 中規模',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 長',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 中',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 中〜高',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            'tab 切替頻度が高い',
            '価格比較 + レビュー比較を並行',
            '初訪は cv 直前で離脱、2-3 訪目で cv',
          ],
          suggestedActions: [
            '価格 / スペック比較表の自社サイト内設置 (仮説)',
            '比較離脱直後のリターゲ施策 (仮説)',
          ],
        },
      },
      {
        id: 'persona-bouncer',
        refId: 'persona_classifier:dummy:cluster_bouncer',
        label: 'bouncer',
        displayName: 'Bouncer (即離脱)',
        description: 'LP 着地後 10 秒未満で離脱。流入経路ミスマッチ可能性あり。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 大',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 極短',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 極低',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 低',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            'LP 着地後 10 秒未満で離脱',
            'スクロールほぼなし',
            '広告クリエイティブと LP のメッセージ乖離が疑われる',
          ],
          suggestedActions: [
            '広告 → LP のメッセージ整合チェック (仮説)',
            'LP first view の優先メッセージ再設計 (仮説)',
          ],
        },
      },
      {
        id: 'persona-returner',
        refId: 'persona_classifier:dummy:cluster_returner',
        label: 'returner',
        displayName: 'Returner (再訪問)',
        description: '複数回再訪。検討期間が長く、最終 cv まで時間を要するセグメント。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 中規模',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 中',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 中〜高',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 極高',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            '3 訪以上、平均 2 週間以内に再訪',
            'PDP + レビュー + FAQ を回遊',
            '最終 cv は 3-5 訪目想定',
          ],
          suggestedActions: [
            'メルマガ / push の再訪導線整備 (仮説)',
            '検討段階別のコンテンツ出し分け (仮説)',
          ],
        },
      },
      {
        id: 'persona-lost',
        refId: 'persona_classifier:dummy:cluster_lost',
        label: 'lost',
        displayName: 'Lost (離脱完了)',
        description: 'cv 未達のまま長期間再訪なし。Win-back 対象。',
        evidence: inferredEvidence(),
        kpis: [
          {
            id: 'size',
            label: 'Size',
            value: '推定 中〜大',
            evidence: inferredEvidence(),
          },
          {
            id: 'avg-session',
            label: '平均セッション長',
            value: '推定 不安定',
            evidence: inferredEvidence(),
          },
          {
            id: 'cv-contrib',
            label: 'CV 寄与',
            value: '推定 極低',
            evidence: inferredEvidence(),
          },
          {
            id: 'return-rate',
            label: '再訪率',
            value: '推定 極低',
            evidence: inferredEvidence(),
          },
        ],
        detail: {
          behaviors: [
            '初訪後 30 日以上再訪なし',
            '前回 cv 未達 + 直近離脱ページが PDP / cart',
            'win-back キャンペーン対象候補',
          ],
          suggestedActions: [
            'win-back メール / リターゲ (仮説)',
            '前回離脱ページ別のオファー出し分け (仮説)',
          ],
        },
      },
    ],
  }
}
