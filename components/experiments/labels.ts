/**
 * 実験 UI の表示ラベル (taxonomy enum → 日本語)。
 * enum の authoritative source は lib/experiments/taxonomy.ts — ここは表示専用。
 */

import type {
  Device,
  Industry,
  InterventionType,
  PageType,
  PrimaryMetric,
} from '@/lib/experiments/taxonomy'
import type { ExperimentStatus } from '@/lib/experiments/types'

export const INTERVENTION_LABELS: Record<InterventionType, string> = {
  cta_placement: 'CTA をファーストビューへ',
  sticky_cta_mobile: 'モバイル固定 CTA バー',
  form_field_reduction: 'フォーム項目削減',
}

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  product: '商品ページ',
  lp: 'LP',
  form: 'フォーム',
  category: 'カテゴリ',
  article: '記事',
  checkout: 'チェックアウト',
}

export const INDUSTRY_LABELS: Record<Industry, string> = {
  d2c_ec: 'D2C / EC',
  saas: 'SaaS',
  lead_gen: 'リード獲得',
  media: 'メディア',
  local_service: 'ローカルサービス',
}

export const DEVICE_LABELS: Record<Device, string> = {
  mobile: 'モバイル',
  desktop: 'デスクトップ',
  tablet: 'タブレット',
}

export const METRIC_LABELS: Record<PrimaryMetric, string> = {
  cvr: 'CVR',
  cta_click_rate: 'CTA クリック率',
  form_submit_rate: 'フォーム送信率',
}

export const STATUS_LABELS: Record<ExperimentStatus, string> = {
  draft: '下書き',
  running: '計測中',
  stopped: '計測終了',
  archived: 'アーカイブ',
}
