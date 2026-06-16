/**
 * /aiseo root entry — Analytics の最初の tab にリダイレクト (Phase 1)
 *
 * AISEO-Director SSOT: decisions.md 続 AISEO-1 §4 (AISEO-2)
 *
 * Phase 1 では Analytics > 内部リンク診断 が唯一機能している page なので、
 * /aiseo にアクセスしたら即座に /aiseo/analytics/internal-links へ。
 * Phase 2 で AISEO ダッシュボード (overview) を /aiseo に配備予定。
 */

import { redirect } from 'next/navigation'

export default function AiseoRootPage() {
  redirect('/aiseo/analytics/internal-links')
}
