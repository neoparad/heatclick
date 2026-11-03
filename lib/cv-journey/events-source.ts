/**
 * CV経路分析 — events テーブルからの first-touch 流入元分類 SQL
 *
 * 背景 (2026-07-14 確定): `clickinsight.sessions` は writer が一度も実装されておらず全件空。
 * 旧実装が sessions から読んでいた first-touch 流入元 (utm / referrer_type) を、
 * 実データが満ちている `clickinsight.events` から再構成する。
 *
 * - session ごとに最初のイベント (argMin by timestamp) の utm_source / utm_medium / referrer /
 *   url を first-touch として採用する。
 * - `referrer_type` は events に列が無いため、生 referrer から SQL 内で分類導出する:
 *     utm あり → 'utm_source / utm_medium'
 *     referrer 空 or 自サイト内 (firstSignificantSubdomain が LP と同じ) → 'direct / none'
 *     検索エンジン → 'search' / SNS → 'social' / それ以外 → 'referral'
 * - 分類に使うドメイン語は本ファイルの静的 allowlist のみ (ユーザー入力を SQL に埋めない)。
 *   可変値 (tenant/site/期間/デバイス) は呼び出し側の WHERE 句で query_params 束縛済み。
 */

/** 検索エンジン判定 (firstSignificantSubdomain と一致)。静的リテラルのみ・[a-z] 限定。 */
export const SEARCH_ENGINE_DOMAINS: readonly string[] = [
  'google',
  'yahoo',
  'bing',
  'duckduckgo',
  'baidu',
  'ecosia',
  'naver',
]

/** SNS 判定 (firstSignificantSubdomain と一致)。't' は t.co (Twitter 短縮)。 */
export const SOCIAL_DOMAINS: readonly string[] = [
  'twitter',
  'x',
  't',
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'pinterest',
  'threads',
  'linkedin',
  'line',
]

/** 静的ドメイン配列を SQL の IN リストへ ('a','b',...)。[a-z] のみ許可 (defense in depth)。 */
function toSqlInList(domains: readonly string[]): string {
  const invalid = domains.filter((d) => !/^[a-z]+$/.test(d))
  if (invalid.length > 0) {
    throw new Error(`SQL allowlist に不正なドメイン語: ${invalid.join(', ')}`)
  }
  return domains.map((d) => `'${d}'`).join(', ')
}

/**
 * (session_id, source_medium) を返すサブクエリ SQL を組み立てる。
 * `where` は呼び出し側 baseFilter の WHERE 句 (tenant_id / site_id / 期間 / device /
 * is_agent=0 / session_id 非空 を query_params 束縛済み) をそのまま受け取る。
 * このサブクエリ自体は追加の query_params を導入しない。
 */
export function buildFirstTouchSessionsSubquery(where: string): string {
  return `
    SELECT
      session_id,
      multiIf(
        utm_src != '' AND utm_med != '', concat(utm_src, ' / ', utm_med),
        utm_src != '', concat(utm_src, ' / unknown'),
        ref = '', 'direct / none',
        firstSignificantSubdomain(ref) = firstSignificantSubdomain(first_url), 'direct / none',
        firstSignificantSubdomain(ref) IN (${toSqlInList(SEARCH_ENGINE_DOMAINS)}), 'search',
        firstSignificantSubdomain(ref) IN (${toSqlInList(SOCIAL_DOMAINS)}), 'social',
        'referral'
      ) AS source_medium
    FROM (
      SELECT
        session_id,
        argMin(ifNull(utm_source, ''), timestamp) AS utm_src,
        argMin(ifNull(utm_medium, ''), timestamp) AS utm_med,
        argMin(ifNull(referrer, ''), timestamp) AS ref,
        argMin(ifNull(url, ''), timestamp) AS first_url
      FROM clickinsight.events
      WHERE ${where}
      GROUP BY session_id
    )
  `
}
