# /api/heatmap pagination + ClickHouse tile query 設計

**起票**: Infrastructure Engineer (2026-05-16 夜)
**親 SSOT**: `linkscrawl/docs/fusion/strategy/19_grand_v1.md` §5.4.2 (P-04 heatmap) / §6.4 S1-04 / §3.8.1
**対応裁定**: decisions.md 2026-05-16 夕 — Infra タスク 1 (Reviewer D-1, E-2 連動)
**期限**: Sprint 1 開始 1 週間前
**migration 前提**: `migrations/2026-05-17-sprint0-tenant-isolation.sql` 適用済 (`tenant_id LowCardinality(String)` が events / heatmap_daily_summary に存在する状態)

---

## 1. 背景

旧 ugokimap heatmap (`ugokimap/app/api/heatmap/route.ts`) は配列フラット返却で、page_height が大きい LP (例: 30000px) では:

1. 単一 ClickHouse query が `LIMIT 1000` で頭頂部のホットスポットしか返さない (深部のページデータが欠落)
2. payload を canvas 全域に一気に渡すため、`heatmap.js` が描画スパイク + GC pause
3. 旧 ugokimap heatmap の **3 バグ** (canvas 単一描画 / layout flex 衝突 / ResizeObserver deps) と複合し、§6.4 S1-04 で「30000px 以上対応」が DOD に明記

Sprint 1 P-04 で Frontend は viewport 高さ単位 (例: 2400px) で canvas を分割描画する設計に切り替わるため、API も **tile 単位の lazy fetch** に統一する。

---

## 2. 公開 API 仕様 (v2 — Sprint 1 切替)

### 2.1 Endpoint

```
GET /api/heatmap
```

### 2.2 Query parameters

| param | type | required | default | 説明 |
|---|---|---|---|---|
| `site_id` | string (CIP_*) | ✅ | — | tenant 配下の site UUID。middleware が tenant_id 注入後、API 層で tenant の所有 site かを照合 |
| `page_url` | string | ✅ | — | ヒートマップ対象 URL (正規化済) |
| `heatmap_type` | `click` \| `scroll` \| `read` | — | `click` | scroll / read は本 v2 では Phase 2 (Sprint 5 末) に後ろ倒し、Sprint 1 は click のみ |
| `device_type` | `desktop` \| `mobile` \| `tablet` \| `unknown` | — | (全) | 未指定で全 device 集約 |
| `start_date` | YYYY-MM-DD | — | now-30d | inclusive |
| `end_date` | YYYY-MM-DD | — | now | inclusive (内部で 23:59:59 に補完) |
| `tile_size` | UInt16 (px) | — | `2400` | 1 tile 当たりの y 軸高さ。`viewport_height × 3` 相当を推奨。最小 800 / 最大 6000 にクランプ |
| `cursor` | string (opaque) | — | `null` | next page 取得用。前回 response の `next_cursor` をそのまま渡す。`null` または未指定で先頭から |
| `max_tiles` | UInt8 | — | `1` | 1 リクエストで何 tile 分まで返すか。`1` (default) は frontend lazy fetch 想定。 IntersectionObserver なら 1 で十分。プリフェッチが必要なら `2` |

### 2.3 Response envelope

```typescript
interface HeatmapTileResponse {
  success: true
  data: {
    tiles: HeatmapTile[]
    next_cursor: string | null   // null なら最終 tile まで返却済
  }
  meta: {
    tile_size: number             // echoed (clamp 後の実値)
    page_height_estimate: number  // データ最大 click_y 切上げ (UI 側 canvas 高さの初期値ヒント)
    cached: boolean
    cache_ttl_sec: number
    query_hash: string            // cursor 改ざん検知用 (info)
  }
}

interface HeatmapTile {
  y_start: number       // inclusive (px)
  y_end: number         // exclusive (px)
  points: HeatmapPoint[]
  truncated: boolean    // tile 内 LIMIT (1000) 到達時 true、UI で「+N 件省略」表示
}

interface HeatmapPoint {
  x: number             // click_x (UInt16)
  y: number             // click_y (UInt16)
  count: number         // クリック数 (sum)
  sessions: number      // ユニークセッション数 (uniq)
}
```

エラーは既存パターン踏襲:

```typescript
{ success: false, error: { code: 'TENANT_FORBIDDEN' | 'BAD_REQUEST' | 'CURSOR_INVALID' | 'INTERNAL', message: string } }
```

### 2.4 cursor 設計

`cursor` は opaque な `base64url(JSON.stringify({ y_start, query_hash, exp }))`:

```typescript
type CursorPayload = {
  y_start: number       // 次に取得すべき tile の y_start (px)
  query_hash: string    // SHA-256(site_id|page_url|heatmap_type|device_type|start_date|end_date|tile_size) の先頭 16 byte hex
  exp: number           // unix sec、発行時刻 + 600 sec (10 分)
}
```

**改ざん検知**: API 層で再計算した `query_hash` と cursor 内 hash を照合。不一致なら `CURSOR_INVALID` を返し、UI は cursor を破棄して `cursor=null` で再取得。

**期限切れ**: TTL 10 分 (Redis cache TTL と同期)。期限切れなら同様に `CURSOR_INVALID`。

**改ざん耐性 vs HMAC**: HMAC を入れない理由 — cursor は公開情報 (y_start) のみで、書き換えても他テナントへ越境はできない (tenant_id は cursor ではなく JWT 由来)。query_hash は単に「他のクエリ条件の cursor を流用していないか」のサニティチェック。HMAC 化は Sprint 5 末に余裕があれば追加 (現状 over-engineering 判断)。

---

## 3. ClickHouse query (tile 単位 fetch)

### 3.1 集約テーブル経由 (default path)

```sql
SELECT
  click_x AS x,
  click_y AS y,
  sum(click_count) AS count,
  sum(unique_sessions) AS sessions
FROM clickinsight.heatmap_daily_summary
WHERE tenant_id = {tenant_id:String}
  AND site_id   = {site_id:String}
  AND page_url  = {page_url:String}
  AND event_type = {event_type:String}
  AND click_y >= {y_start:UInt16}
  AND click_y <  {y_end:UInt16}
  /* device_type は指定時のみ */
  AND device_type = {device_type:String}
  /* date range は指定時のみ */
  AND date BETWEEN toDate({start_date:String}) AND toDate({end_date:String})
GROUP BY click_x, click_y
HAVING count >= 3
ORDER BY count DESC
LIMIT {limit:UInt32}
```

**バインド変数の選び方** (ClickHouse client `query_params`):

- `tenant_id`: middleware が JWT から抽出して header `x-tenant-id` で渡したものを request scope で受領。**ハードコード絶対禁止**。
- `event_type`: heatmap_type に応じ `click` 固定 (Sprint 1)、Phase 2 で `scroll` / `read` 拡張時は別 SQL を分岐 (read_y / scroll_y は別カラム)。
- `y_end`: `min(y_start + tile_size, 30000 + tile_size)`。30000 を超える深部に何かあれば最後の tile に集約 (cap 不要、UInt16 max 65535)。
- `limit`: 固定 `1000` (1 tile 内の最大ホットスポット数)。`HAVING count >= 3` で疎データを削るため実態はもっと少ない。

### 3.2 fallback (heatmap_daily_summary に未集約のサイト用)

旧 ugokimap の getHeatmapDataLegacy 相当。Sprint 1 では **fallback を経由しない** (S0-04 で heatmap_daily_summary を copy + S0-05 migration で tenant_id 列追加 → MV 再 build 済を前提)。万一空応答時は fallback せず空 tile を返し、Sentry warning + Operator alert 経由で Inngest `rebuildAll` キック (運用ジョブで吸収、API path で fallback しない方が p99 latency 安定)。

### 3.3 indexing 戦略 (新規追加なし、既存 ORDER BY 活用)

- heatmap_daily_summary の ORDER BY: `(site_id, page_url, event_type, date, device_type, click_x, click_y)` (既存)
- migration で `tenant_id` を **prefix に追加するのは不要**: `WHERE tenant_id = ... AND site_id = ...` で site_id が一意キー的に effective、追加 ORDER BY 変更は MV 再構築コストが大きい
- 代わりに `tenant_id` は MV の WHERE 句素通し + LowCardinality で skip index の効果を期待
- click_y BETWEEN は ORDER BY 末尾なので range scan は seek ではなく block prune ベース。tile 内 query は実測 < 50ms (3 ヶ月分 / 100 万 events / page_url 当たり) を目標

### 3.4 sessions テーブルとの join 不要性

cardinality 上、heatmap には session_id レベルの突合不要 (uniq() で十分)。session 一覧は別 endpoint `/api/heatmap/sessions` (Sprint 3 以降) で個別に。

---

## 4. middleware / 認可フロー

```
1. middleware.ts: JWT 検証 → tenant_id 抽出 → request header `x-tenant-id` 注入
2. /api/heatmap/route.ts:
   - request.headers.get('x-tenant-id') を必須読取 (なければ 401)
   - site_id が当該 tenant 配下か照合 (lib/tenant.ts: assertSiteBelongsToTenant)
   - 不一致 → 403 + audit_events insert (action='api.heatmap.read.denied')
3. ClickHouse query: tenant_id を必ずバインド変数で渡す
4. Response 直前: audit_events insert (非同期、waitUntil)
   - action='api.heatmap.read'
   - resource={site_id, page_url, y_start, y_end}
   - response_status=200
```

**多層防御**: middleware (層1) + API 層の site 照合 (層2) + SQL の tenant_id WHERE (層3) の 3 層。1 層でも欠けると tenant 越境の可能性 → 必ず全層必須。

---

## 5. キャッシュ戦略

### 5.1 Redis tile cache

- key: `heatmap:tile:v2:{tenant_id}:{query_hash}:{y_start}`
- TTL: 2 時間 (旧 ugokimap と同じ。クリックは 1-2 時間遅延の集計で十分)
- value: gzip(JSON tile) — 1 tile あたり 1000 points × ~50 bytes = 50KB → gzip で 10-15KB 想定
- 書き込み: Cache miss 時に SQL → 結果を SETEX

### 5.2 Cache stampede 対策

`SETNX heatmap:tile:lock:{...} (TTL 30s)` を取得した worker のみ SQL 実行。他はロック待ちで再 GET。Sprint 1 では未実装 (Sprint 4 に Cache Warmer Inngest job と合わせて導入、Sprint 1 は単純 GET → SQL → SETEX で十分、同時アクセス少ない)。

### 5.3 Invalidation

events INSERT 直後の即時 invalidate はしない (ClickHouse INSERT → MV 反映が秒オーダー、TTL 2h で十分 fresh)。明示 invalidate が必要なら `/api/heatmap/cache/invalidate?site_id&page_url` (Sprint 5 admin only) を別途。

---

## 6. Frontend (P-04) との連携シナリオ

```
1. UI 初回表示: cursor=null で fetch
   → 1 tile (y=0..2400) 返却 + next_cursor
   → canvas[0] に描画 + page_height_estimate で全 canvas 高さ確保
2. ユーザースクロール: IntersectionObserver で次 tile 必要と判定
   → cursor=<前回 next_cursor> で fetch
   → 1 tile 追加 + 次の next_cursor
3. next_cursor=null まで繰返し
4. リサイズ等で query 条件変更: cursor を破棄して cursor=null から再開
   → 古い cursor は query_hash 不一致で CURSOR_INVALID 返却 (UI は破棄して再取得)
```

**Frontend 側の API client suggestion**:

```typescript
// lib/api/heatmap.ts
async function fetchHeatmapTile(params: HeatmapQuery, cursor: string | null): Promise<HeatmapTileResponse>

// hooks/useHeatmapTiles.ts
function useHeatmapTiles(query: HeatmapQuery): {
  tiles: HeatmapTile[]
  loading: boolean
  hasMore: boolean
  loadMore: () => void
}
```

詳細は Frontend Programmer に委譲 (本 doc は API/SQL 設計まで)。

---

## 7. 完了条件

| # | 項目 | 検証方法 |
|---|---|---|
| 1 | API spec 確定 | 本 doc + decisions.md [→Director] |
| 2 | tenant_id 必須化 (3 層防御) | middleware patch + lib/tenant.ts assertSiteBelongsToTenant + SQL WHERE 句必須 |
| 3 | tile pagination で 30000px 全域取得可能 | E2E: cursor 連鎖で y=0〜30000 を 13 tile 取得、欠落なし |
| 4 | tile size 2400 で 1 tile p99 < 200ms | ClickHouse profile (3 ヶ月 / 100 万 events / 任意 page_url) |
| 5 | cursor 改ざん検知 | unit test: query 条件改ざん → CURSOR_INVALID |
| 6 | audit_events 書込 | 200 / 403 / 401 の各ケースで row 確認 |

---

## 8. リスクと未決事項

| # | リスク | 緩和 / 判断 |
|---|---|---|
| R1 | heatmap_daily_summary の MV が migration 後 tenant_id を含まない | S0-05 完了後に Operator が Inngest `rebuildAll` キック必須。本 doc は前提扱い |
| R2 | `page_height_estimate` がデータ依存で初回小さく出る | UI 側で `Math.max(estimate, 30000)` 以上を canvas 初期高さに設定し漸進拡張 |
| R3 | Sprint 5 末に scroll / read heatmap_type 追加で別 SQL が必要 | 本 doc の §3.1 は click 専用、scroll/read は別 endpoint or 同 endpoint で type 分岐実装 (Sprint 5 末で再設計) |
| R4 | tenant_id LowCardinality でも skip index が効かない可能性 | 計測結果次第で `INDEX idx_tenant tenant_id TYPE set(1024)` を ALTER TABLE 追加 (本 doc では予約) |
| R5 | cursor の query_hash 衝突 | 16 byte (128 bit) で衝突確率は無視できる |

---

## 9. 改訂履歴

| ver | date | author | 概要 |
|---|---|---|---|
| 0.1 | 2026-05-16 | Infrastructure Engineer | 初版起票 |
