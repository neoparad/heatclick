# 実装指示 — P0: ヒートマップ表示速度の区間計測 (Sonnet 5 向け)

> 作成: 2026-07-19 (Fable 5) / 実装者: Sonnet 5 / repo: C:\Users\M2603\ugokimap-saas / branch: feat/conversions-c1a から新規ブランチ `feat/heatmap-p0-timing` を切る
> 背景文書 (実装前に §1 だけ読む): `docs/heatmap/HEATMAP_SPEED_CORE_CAUSES_FINAL_2026-07-19.md` §2-4, `docs/heatmap/HEATMAP_SPEED_BLINDSPOT_ADDENDUM_2026-07-19.md` §3

## 0. ゴールと絶対条件

ヒートマップ画面の 10-12秒を**区間に帰属させる計測**を入れる。速度改善そのものはしない。

絶対条件:
1. **挙動変更ゼロ** — 計測コードが失敗してもレスポンス内容・ステータスは不変 (try/catch で計測だけ落とす)
2. **触ってはならないファイル**: `components/heatmap/heatmap-canvas.tsx` / `components/heatmap/heatmap-side-panel.tsx` (並行ストリームの未コミット差分あり)。加えて `app/api/auth/magic-link/*` / `lib/cv-journey/*` / `lib/conversions/*` / `app/api/cv-journey/*`
3. 新規依存パッケージ追加禁止 (Web Performance API と Node 標準のみ)
4. `console.log` 禁止規約は維持 — サーバは構造化 1 行 JSON (`console.info`) を計測専用に限り可 (eslint-disable 行コメント付き)、クライアントは §4 の `?perf=1` ゲート内のみ可
5. Server-Timing の desc に URL・エラーメッセージ・接続情報を入れない (数値・列挙ラベルのみ。ブラウザに露出するため)

## 1. 成果物一覧

| ファイル | 種別 | 内容 |
|---|---|---|
| `lib/perf/server-timing.ts` | 新規 | 計測ヘルパ (§2) |
| `lib/perf/server-timing.test.ts` | 新規 | ヘルパの unit test |
| `app/api/heatmap/route.ts` | 編集 | span 計測 + log_comment (§3) |
| `app/api/heatmap/page-stats/route.ts` | 編集 | 同上 |
| `app/api/heatmap/elements/route.ts` | 編集 | 同上 (5 クエリ個別) |
| `app/api/heatmap/screenshot/route.ts` | 編集 | 同上 + tier/bytes (§3.4) |
| `lib/heatmap/r2-screenshot-cache.ts` | 最小編集 | tier ラベルの返却 (§3.4、既に返していれば不要) |
| `app/(proof)/heatmap/page.tsx` | 編集 | SSR gate の構造化ログ (§3.5) |
| `hooks/use-heatmap-tiles.ts` / `use-heatmap-elements.ts` / `use-page-stats.ts` | 編集 | client marks (§4) |
| `components/heatmap/heatmap-page.tsx` | 編集 | mount mark + perf ダンプ (§4) ※このファイルは編集可 (未コミット差分なし。編集前に git status で確認) |
| `components/heatmap/real-page-screenshot-underlay.tsx` | 編集 | 画像 decode/transfer 計測 (§4.3) |
| `docs/heatmap/P0_MEASUREMENT_PROTOCOL_2026-07-19.md` | 新規 | オーナー向け計測手順 (§5) |

## 2. 計測ヘルパ `lib/perf/server-timing.ts`

```ts
export interface PerfSpan { name: string; durMs: number; desc?: string }

export function createRouteTimer(route: string): {
  span<T>(name: string, fn: () => Promise<T>): Promise<T>   // 計測して結果をそのまま返す。fn が throw しても span は記録して rethrow
  mark(name: string, desc: string): void                     // dur なしのラベル (tier 等)
  headerValue(): string                                      // Server-Timing ヘッダ文字列
  logLine(): string                                          // 構造化 1 行 JSON (route, spans, coldStart, region, reqId)
}

export function coldStartInfo(): { cold: boolean; initToHandlerMs: number }
export function region(): string   // process.env.VERCEL_REGION ?? 'local'
```

実装要点 (ここで事故りやすい):
- **cold 判定**: module スコープで `const MODULE_LOAD_AT = Date.now(); let invoked = false;`。`coldStartInfo()` は `cold = !invoked` を返してから `invoked = true`。route ファイルでなく**このヘルパ module 内**で持つ (全 route が同一 function bundle に入る場合も、別 bundle の場合も、それぞれの bundle の cold を正しく表す)
- 時間は `performance.now()` (Node 18+ でグローバル)。`Date.now()` と混ぜない
- Server-Timing 形式: `name;dur=12.3` / desc 付きは `name;desc="v";dur=12.3`。合計値 `total` span を必ず含める
- `headerValue()` は必ず `cold;desc="1|0"` と `region;desc="iad1"` と `init;dur=<initToHandlerMs, cold時のみ>` を自動で付ける
- 全メソッドは内部 try/catch で自壊しない (計測失敗は握りつぶす — 絶対条件1)

unit test: (a) span が値を透過し例外を rethrow する、(b) headerValue の形式、(c) cold が最初の 1 回だけ true、(d) desc に `"` を含む文字列を渡してもヘッダが壊れない (エスケープ or 除去)。

## 3. サーバ側 span 仕様 (名前は**この通りに**。後工程の分析が名前に依存する)

### 3.1 共通
- 各 route の handler 冒頭で `const t = createRouteTimer('<route名>')`、レスポンス返却直前に `headers` へ `Server-Timing: t.headerValue()` を追加し、`console.info(t.logLine())` を出す (eslint-disable 付き)
- 既存ヘッダ (`Cache-Control` 等) を消さない — `NextResponse.json(body, { headers: { ...既存, 'Server-Timing': ... } })` の形で統合
- エラーレスポンス経路にも `total` だけは付ける (可能な範囲で。無理なら happy path のみで可、その旨コメント)

### 3.2 CH クエリの log_comment (query_log 突合用)
全 heatmap 系 `client.query(...)` 呼び出しに:
```ts
clickhouse_settings: { log_comment: JSON.stringify({ app: 'heatmap', route, span, req: reqId }) }
```
- `reqId` は `crypto.randomUUID()` を route 冒頭で 1 回生成し全 span で共有
- log_comment に **URL・tenant 値を入れない** (route/span/req のみ)
- 既存の `clickhouse_settings` があればマージ (上書きしない)

### 3.3 route 別 span 名

| route | spans |
|---|---|
| `/api/heatmap` (tiles) | `auth` (getServerSession+role 検証) / `ch` (all-bands クエリ) / `ch-fallback` (per-band 経路に入った場合のみ、batch 毎でなく合計) / `total`。mark: `bands;desc="<返却band数>"`, `points;desc="<返却point数>"` |
| `/api/heatmap/page-stats` | `auth` / `ch` / `ch-fallback` (列欠落 fallback 時) / `total` |
| `/api/heatmap/elements` | `auth` / `ch-elements` / `ch-signals` / `ch-sessions` / `ch-images` / `ch-issues` (現行の直列 5 クエリを**個別に**) / `total` — ⚠ 並列化はしない (P0 は計測のみ。並列化は P1) |
| `/api/heatmap/screenshot` | `auth` / `own-ch` (tenantTracksUrl) / `cache` (getHeatmapUnderlayWithR2Cache 全体) / `total`。mark: `tier;desc="l1|r2-fresh|r2-stale|cold-capture|degraded"`, `imgBytes;desc="<バイト数>"` (メタから取れる場合) |

### 3.4 tier の露出
`getHeatmapUnderlayWithR2Cache` の戻り値に tier 相当が既にあるか確認し、無ければ戻り値オブジェクトに `tier` フィールドを**追加** (削除・変更はしない)。既存呼び出しに影響がないことを tsc で確認。

### 3.5 SSR gate (App Router の罠)
**Server Component はレスポンスヘッダを設定できない**。Server-Timing は使えないので:
- `app/(proof)/heatmap/page.tsx` の `fetchPages` await を `performance.now()` で挟み、`console.info(JSON.stringify({ perf: 'heatmap-ssr', span: 'pages', durMs, cold, region, cacheHit: <5分cacheにhitしたか判別可能なら> }))` を 1 行出す (Vercel の function ログで見る)
- クライアント側は Navigation Timing の `responseStart - requestStart` が「SSR 所要 (cold start 込み)」の実測になる — §4 のダンプに含める

## 4. クライアント側 marks

### 4.1 命名 (この通りに)
`performance.mark()` / `performance.measure()`、prefix は `hm:`:
- `hm:mount` (HeatmapPageClient の初回 useEffect)
- `hm:tiles:start` / `hm:tiles:end` (+ measure `hm:tiles`)。batch 数を mark の detail に
- `hm:stats:start|end`, `hm:elements:start|end`, `hm:shot-json:start|end` (screenshot JSON まで)
- `hm:img:loaded` (onLoad) / `hm:img:decoded` (`img.decode()` 解決後) — §4.3
- `hm:visual-complete` = max(tiles:end, img:decoded) の時点で measure を張る (実装は tiles 完了と img decode 完了の両方が揃った時点で 1 回)

### 4.2 ダンプ
`components/heatmap/heatmap-page.tsx` に: `window.location.search` に `perf=1` がある場合のみ、`hm:visual-complete` 到達時に `console.table` で全 measure + Navigation Timing (responseStart/domContentLoaded 等) + Resource Timing から取った各 API の `serverTiming` エントリ (ブラウザは Server-Timing ヘッダを `PerformanceResourceTiming.serverTiming` で読める) を一括出力する。`?perf=1` が無ければ mark のみ (出力なし)。

### 4.3 画像計測 (`real-page-screenshot-underlay.tsx`)
- `onLoad` で `hm:img:loaded` を mark → `imgRef.current.decode()` の resolve で `hm:img:decoded`
- `performance.getEntriesByName(capture.imageUrl)` から `transferSize` / `responseEnd - startTime` を取得し mark detail に格納 (cross-origin で 0 になる場合はその旨を値 `-1` で記録 — R2 は `Timing-Allow-Origin` を返さないため transferSize が取れない可能性が高い。**取れなくてもエラーにしない**)

## 5. 計測プロトコル文書 `docs/heatmap/P0_MEASUREMENT_PROTOCOL_2026-07-19.md`

オーナー (非エンジニア想定で平易に) 向けに書く:
1. **事前合意**: 「2秒」の定義 — 3 択を提示し選んでもらう: (a) ヒートマップの色が出た瞬間 / (b) 実ページ画像まで揃った瞬間 (推奨: これを「視覚完成」とする) / (c) サイドパネル含め全部出た瞬間
2. **3 シナリオ × 3 回**: ①その日の初回 (最重要 — cold start 計測) ②直後にリロード (warm) ③5 分後に再訪。各回 `https://<本番>/heatmap?perf=1` を開き DevTools Console のテーブルをスクショ、Network タブを HAR 保存
3. **注意**: 計測中は他のヒートマップ操作をしない (他デバイス先読みが +4s/+8s に走るため、その時刻以降のリクエストは分析から除外すると明記)
4. **Clarity 対照**: 同一 PC・同一回線で Clarity の同等画面も DevTools 開いて 1 回計測 (比較基準の実数化)
5. **query_log 用 operator 手順** (実行は Codex Desktop/オーナー、Sonnet は文書化のみ): 限定 role 作成 SQL 雛形 — `CREATE USER IF NOT EXISTS perf_observer IDENTIFIED BY '<別途>'; GRANT SELECT(query, query_duration_ms, read_rows, read_bytes, result_bytes, event_time, type, query_kind, log_comment) ON system.query_log TO perf_observer;` + log_comment で絞る集計クエリ例 (CODEX_ANALYSIS §2.1 の SQL を log_comment 条件に書き換えたもの)

## 6. 検証 (green になるまで commit しない)

```
npx tsc --noEmit                          # EXIT 0
npx jest lib/perf --runInBand             # 新規 test green
npx jest --runInBand --listTests          # 既存 suite が認識される (全実行は任意)
```
- ローカル実行の限界を理解して検証する: `.env.local` の CH は firewall で不達 → route は dummy/エラー経路に落ちるが、**Server-Timing ヘッダの存在と形式は `next dev` + `curl -sI 'http://localhost:3000/api/heatmap?...'` で検証できる** (401 応答でも total が付くこと、または happy path 限定ならその旨を PR 説明に明記)
- git status で禁止ファイルに差分が無いことを確認

## 7. commit 規律

個別 add のみ (`git add .` 禁止)。2 論理コミット:
1. `feat(heatmap): P0計測 サーバ側 Server-Timing + log_comment` — lib/perf/* + 4 route + r2-screenshot-cache + page.tsx(SSR ログ)
2. `feat(heatmap): P0計測 client marks + 計測プロトコル` — hooks + heatmap-page + underlay + protocol doc

push / PR / deploy はオーナー指示待ち (本番計測にはデプロイが必要だが、その判断はオーナー)。

## 8. 非スコープ (P0 でやらないこと — やりたくなっても我慢)

- elements の並列化 / tiles キャッシュ / 画像 URL 安定化 / region 設定 / 保温 — 全て P1 (計測結果を見てから)
- fixture 誤描画バグ修正 (別タスクとして起票済み)
- heatmap-canvas.tsx への一切の変更 (先読み無効化も含む — プロトコル側で除外扱いにする)
- ダッシュボード/可視化 UI (DevTools と console.table で足りる)
