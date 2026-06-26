/**
 * ページ候補 (heatmap ページセレクタ等) の取得クエリ — 共有実装。
 *
 * 続122: 従来この実装は app/api/pages/route.ts の中にあり、(proof)/heatmap の
 * Server Component は **自分自身へ HTTP fetch** (NEXT_PUBLIC_APP_URL 経由の外回り往復) で
 * 取得していた。この自己 fetch はデプロイ直後の alias 切替・cookie 転送・二重 middleware に
 * 弱く、失敗すると「過去7日間のイベントがまだ集まっていません」の誤バナーになる
 * (Owner 2026-06-10 報告: API 直叩きは success:true なのにページが空表示)。
 * 本ファイルに抽出し、Server Component からは **in-process で直接呼ぶ** (HTTP 往復ゼロ)。
 *
 * tenant isolation (§3.8.1): 呼び元が tenant_id を検証済みセッションから渡すこと。
 * ClickHouse query は必ず `WHERE tenant_id = {tenant_id:String}` (parameter binding)。
 * cache key は tenant_id + site_id + limit (cross-tenant 漏洩なし)。
 */

import { unstable_cache } from 'next/cache'

import { getClickHouseClient } from '@/lib/clickhouse'
import { canonicalUrlSql } from '@/lib/heatmap/canonical-url'

/** canvas のデバイスタブ。ClickHouse の device_type を UI 表現に写像した値。 */
export type PageTopDevice = 'pc' | 'sp' | 'tab'

export interface PageOption {
  url: string
  label: string
  /**
   * このページで最も計測イベントが多いデバイス (続135)。
   * 実トラフィックがモバイル主体のサイトで PC 既定だと device_type='desktop' 絞りに
   * モバイルのクリックが当たらず「データなし」誤表示になるため、初期デバイスを
   * ページごとの最多デバイスに合わせる。不明時は 'sp' (モバイル優勢の安全側)。
   */
  topDevice: PageTopDevice
}

interface PageRow {
  url: string
  events: number
  top_device_type: string | null
}

/** ClickHouse `device_type` (desktop/mobile/tablet/null) を canvas デバイスに写像。 */
function toTopDevice(deviceType: string | null): PageTopDevice {
  if (deviceType === 'desktop') return 'pc'
  if (deviceType === 'tablet') return 'tab'
  // mobile / null / unknown は 'sp' (モバイル優勢の安全側)
  return 'sp'
}

/**
 * URL から人間可読ラベルを派生させる。
 *   '/'                    → 'トップ'
 *   '/column/acne/'        → 'column/acne'
 *   '/products/foo/bar/'   → 'foo/bar' (末尾 2 セグメント)
 *   parse 失敗時            → URL そのまま
 */
export function deriveLabelFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    if (path === '/' || path === '') return 'トップ'
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) return 'トップ'
    return segments.slice(-2).join('/')
  } catch {
    return url
  }
}

/**
 * ClickHouse からページ候補を取得。tenant_id + site_id で絞り込み、過去 7 日間集計。
 */
export async function fetchPagesUncached(
  tenantId: string,
  siteId: string,
  limit: number,
): Promise<PageOption[]> {
  // 続134 (RT-01 hardening): events を読むだけの集計なので read 専用ロールで実行する。
  //   旧: 引数なし = 'default'（superuser）。これだと default を Vercel から遠隔使用する必要があり、
  //   git 露出した default creds を localhost 限定で無力化できなかった。analytics_reader に移して
  //   default を完全にローカル専用にできるようにする (アプリは default を遠隔使用しない)。
  const ch = getClickHouseClient('analytics_reader')
  // tenant_id parameter binding は必須 (§3.8.1)。文字列連結は禁止 (Codex Round 8 Fix 5)。
  // 続135: ページごとの最多デバイスも返す。内側で (url, device_type) 件数を出し、
  //   外側で argMax(device_type, dc) = そのページで最もイベントの多い device_type を選ぶ。
  //   これで初期デバイスをページ実態に合わせ「モバイル主体なのに PC 既定で空表示」を防ぐ。
  const result = await ch.query({
    // 続135: canonical_url (query/fragment 除去) で集約。variant 分散による「同一ページが複数行に
    //   割れてクリック0に見える」を防ぐ。tile/elements/page-stats の WHERE 正規化と同一規則。
    query: `
      SELECT
        canon AS url,
        sum(dc) AS events,
        argMax(device_type, dc) AS top_device_type
      FROM (
        SELECT ${canonicalUrlSql('url')} AS canon, device_type, count() AS dc
        FROM clickinsight.events
        WHERE tenant_id = {tenant_id:String}
          AND site_id = {site_id:String}
          AND timestamp >= now() - INTERVAL 7 DAY
          AND url != ''
        GROUP BY canon, device_type
      )
      GROUP BY canon
      ORDER BY events DESC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      tenant_id: tenantId,
      site_id: siteId,
      limit,
    },
    format: 'JSONEachRow',
  })
  const rows = await result.json<PageRow>()
  return rows.map((r) => ({
    url: r.url,
    label: deriveLabelFromUrl(r.url),
    topDevice: toTopDevice(r.top_device_type),
  }))
}

/**
 * 5 分 stale-while-revalidate 付き。
 * unstable_cache の key は引数全体 + tags。tenant_id を tag 化しておけば将来 revalidateTag で
 * tenant 単位 cache 破棄が可能 (Phase 5 deletion request 対応)。
 */
export function fetchPagesCached(
  tenantId: string,
  siteId: string,
  limit: number,
): Promise<PageOption[]> {
  const cached = unstable_cache(
    async () => fetchPagesUncached(tenantId, siteId, limit),
    ['api-pages', tenantId, siteId, String(limit)],
    {
      revalidate: 300, // 5 分 stale-while-revalidate
      tags: [`tenant:${tenantId}`, `pages:${tenantId}:${siteId}`],
    },
  )
  return cached()
}
