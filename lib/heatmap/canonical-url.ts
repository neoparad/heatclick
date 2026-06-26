/**
 * lib/heatmap/canonical-url.ts — heatmap 系の URL 正規化 (続135 canonical_url 一元化)
 *
 * 背景:
 *   トラッキングは `?utm_source=...` / `#formarea` 付きの生 URL を events に保存する。
 *   従来は fetch-pages / tile / elements / page-stats / screenshot-ownership が
 *   `url = {page_url}` の**完全一致**で絞っていたため、1 ページのクリックが variant 群に
 *   分散し「クリック0」「画像視認率が出ない」誤表示の原因になっていた
 *   (実データ実証: akiya4 完全一致 0 件 → canonical 27 件 / akiya8 0 → 139 件)。
 *
 * 方針:
 *   query string (`?...`) と fragment (`#...`) を**最初の出現位置で切り落とす**正規化を
 *   アプリ側 (JS) と ClickHouse 側 (SQL) で**数学的に同一**に定義し、全 consumer で共有する。
 *   - JS : `url.split('#')[0].split('?')[0]`
 *   - SQL: `replaceRegexpOne(col, '[?#].*$', '')`
 *   両者は「最初の ? または # 以降を除去」で完全等価 (実データ 14 日で差分 0 を確認済)。
 *   ※ ClickHouse 組込 `cutQueryStringAndFragment` は `a#h?x` を `a#h` にするため不採用
 *     (JS split は `a` になり不一致になりうる)。
 *
 * セキュリティ: SQL 断片の column 名は呼出側コードの固定識別子のみを渡すこと
 *   (ユーザー入力を渡さない)。値の比較は必ず parameter binding ({page_url:String}) を使う。
 */

/**
 * URL から query string と fragment を除去して canonical 形にする。
 * 最初の `?` または `#` 以降を切り落とす (どちらが先でも前半のみ残す)。
 */
export function canonicalizeHeatmapUrl(url: string): string {
  return url.split('#')[0].split('?')[0]
}

/**
 * ClickHouse 側で上記と同一の正規化を行う SQL 式を返す。
 * `canonicalUrlSql('url') = {page_url:String}` のように WHERE / GROUP BY で使う。
 *
 * @param column 正規化対象のカラム名 (固定識別子。events は `url`、image_visibility は `page_url`)
 */
export function canonicalUrlSql(column: 'url' | 'page_url' = 'url'): string {
  return `replaceRegexpOne(${column}, '[?#].*$', '')`
}
