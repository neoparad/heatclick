# 経路分析 (paths) 実データ結線 実装計画 (Sprint 4→5 貫通)

> 作成: 2026-07-13 / 根拠: 2エージェントによるデータモデル+events schema+cv-journey機構の一次証拠調査
> 対象: `neoparad/heatclick` (ugokimap-saas)。現状 paths は KV定義のみで統計未結線 (`lib/paths/types.ts:11-14` 「ClickHouse/ML 未結線」)。
> 進め方: Codexデスクトップが実装→自己検証(tsc/jest)→commit/PR/deploy。段階分割で Sprint 4→5 を一気通貫。

---

## 0. 前提: これは「新規発明」でなく「実証済みパターンの移植」

- **計算エンジンは既に存在**: `lib/llm/hybrid-query.ts:2500-2598` に windowFunnel ベースの funnel 集計 (events, observed_approx) が実装済み。cv-journey (`lib/cv-journey/query.ts:76-143`) も同型。paths はこれを移植する。
- **write-back seam も完備**: `lib/paths/repository.ts:258-306` の `updatePathSet` が全分析フィールド (trigger/branches/insights/evidence_level/averageCvRate) を受け付ける。新規作成時のプレースホルダ (`trigger.sessions:'—'`, node`stats:[]`, edge`label:''`, `summary.cvRate:'—'`, `averageCvRate:'—'`, `evidence_level:'planned'`) を上書きするだけ。
- **UIは既存の表示分岐を利用**: `components/paths/path-analysis-canvas.tsx:287,460` は「stats非空→数値表示 / 空→未分析バッジ」を既に実装済み。Sprint 4-Aで`observed_approx`をpathsのevidence enumと表示バッジへ追加し、実データではこのevidence levelを明示する。

## 1. 確定した設計判断 (Claudeが決定、実装前提)

### 判断① URLマッチ意味論 = canonical完全一致 (cv-journeyのsubstringから変更)
- cv-journey は `position(url, {path:String}) > 0` の**部分一致**。paths のノードは「そのページに到達したか」を厳密に判定すべきなので、heatmap と同じ **canonical完全一致**を使う:
  - SQL: `${canonicalUrlSql('url')} = {sN_url:String}` (`lib/heatmap/canonical-url.ts:34`)
  - JS: バインド前に `canonicalizeHeatmapUrl(node.url)` で `?`/`#` を除去 (`canonical-url.ts:28`)
- **グロブ `/products/*` の扱い**: POC は `/products/*` を使うが schema上マッチ意味論は未定義。**Sprint 4 では glob を「prefix一致」として解釈**する: `url` が `/*` で終わるノードは `startsWith(canonical(url), prefix)` = SQL `startsWith(${canonicalUrlSql('url')}, {sN_prefix:String})`。`/*`無しは完全一致。この2形だけをサポートし、正規表現等は非対応 (Phase 1.5)。**この分岐も query_params 束縛必須** (prefix値を文字列連結しない)。
- **pageviewノード**: `node.url` が `/` で始まる裸のパス。canonical完全一致は `event_type = 'pageview' AND ${canonicalUrlSql('url')} = {sN_url:String}`、末尾 `/*` glob は `event_type = 'pageview' AND startsWith(${canonicalUrlSql('url')}, {sN_prefix:String})`。JS側では `canonicalizeHeatmapUrl()` を適用してから束縛する。
- **event種別ノード `event:<type>`**: `event_type = {sN_evt:String}`。`<type>` は `hybrid-query.ts` の `ALLOWED_EVENT_TYPES` と同じ有限集合で検証し、未許可は warning を付けてwindowFunnel条件・表示統計から除外する。
- **conversion種別ノード `conversion:<type>`**: `event_type = 'conversion' AND conversion_type = {sN_cv:String}`。サイト固有の `<type>` はallowlist化せず、必ず `query_params` に束縛する。該当イベントが無ければ0件として扱い、数値を捏造しない。

### 判断② write-back方式 = compute-on-read (KVには書き戻さない、Sprint 4)
- **理由**: (a) KV書き戻しは「いつ再計算するか」の cache invalidation 問題を生む (step編集時リセット、期間変更、日次更新…)。(b) compute-on-read なら常に最新の events を反映し、stale化しない。(c) paths対象は限定公開規模で対象セット数が小さいので、GET時の追加クエリ1本は許容。
- **実装**: `app/api/paths/route.ts` (list) と `app/api/paths/[id]/route.ts` (detail) の GET で、KVから読んだ PathSet に対し `computePathSetStats()` を呼び、ノード/エッジ/summary/trigger.sessions/averageCvRate を埋めてから返す。KVの行自体は定義のみで不変。
- **evidence_level**: レスポンス上で `'observed_approx'` に射影 (KVは`planned`のまま)。canvas が per-node バッジを付ける。
- **Sprint 5 で write-back + 日次バッチに移行可能な設計にする**: `computePathSetStats(pathSet, {client, tenantId, ...}): Promise<PathSet>` を純粋な「定義→統計入りPathSet」関数として切り出し、compute-on-read でもバッチwrite-backでも同じ関数を使えるようにする (Sprint 5 で cron から updatePathSet に流すだけ)。
- **キャッシュ**: compute-on-read のCH負荷を抑えるため、P0-α1/screenshot と同じ L1メモリ+Redis(短TTL 60-120秒) で pathSetId+period 別にキャッシュ。fail-open。list で N セット×funnelクエリが増えるため、list は「トリガーsessionsと各branchのCV率まで」の軽量サマリのみ計算し、詳細 (node別通過数・edge・滞在・perf) は detail GET でのみ完全計算する2段構成にする。

### 判断③ 品質ゲート = is_agent=0 + tenant_id完全束縛 (cv-journeyの負債を継がない)
- cv-journey は `is_agent=0` を欠き、sessions クエリで `tenant_id` を束縛していない (調査で判明した既存負債)。paths は**最初から正しく**:
  - events クエリに `AND is_agent = 0` 必須 (bot除外、heatmap と同基準)。
  - sessions クエリにも `AND tenant_id = {tenant_id:String}` を必ず追加 (§3.8.1 準拠、防御的多層)。

## 2. 実装対象ファイル

### 新規
- `lib/paths/stats-query.ts`: 実CH計算の中核。
  - `computeBranchFunnel(client, {tenantId, siteId, periodDays, steps, isAgentExcluded})`: 1ブランチの steps[] → windowFunnel → 各step reached数 + drop/advance率。cv-journey の `fetchReachCounts`(query.ts:76-143) を移植し、URLマッチを判断①に差し替え。全値 query_params 束縛。
  - `fetchTriggerSessions(client, {tenantId, siteId, periodDays, triggerUrl})`: トリガーURL到達セッション数 (funnel分母)。
  - `computePathSetStats(client, pathSet, opts): Promise<PathSet>`: 定義PathSet → 統計入りPathSet (純粋な変換、write-back/compute-on-read両対応)。数値を表示文字列 (`'7,128'`/`'88%'`/`'6.1%'`) にフォーマットする責務も持つ (types.ts の stat.v は文字列)。滞在時間/perf(PageSpeed)は Sprint 4スコープ外 (別テーブル `page_performance`、後続)。
- `lib/paths/stats-query.test.ts`: fakeClient (cv-journey/dry-run-preview のパターン) で、windowFunnel SQL の query_params束縛・canonical URL・glob prefix分岐・is_agent=0・tenant_id束縛・drop/CV率計算・文字列フォーマット・空データ時の未分析維持、を検証。
- `lib/paths/stats-format.ts` (+test): 数値→表示文字列 (カンマ区切り/％/mm:ss)、drop率→tone、severity ロールアップ、の純粋関数群。

### 変更
- `app/api/paths/route.ts` (GET list): KV定義に軽量サマリ統計 (trigger.sessions + branch summary.cvRate + averageCvRate) を compute-on-read で付与。エラー時は統計なし(未分析)で返す=**静かにダミーにしない**、`meta` (または各セットのフラグ) に `statsComputed: boolean` を持たせCH失敗を可視化。
- `app/api/paths/[id]/route.ts` (GET detail): 完全統計 (node stats/edge label/summary/perf以外全部) を compute-on-read で付与。同じくエラー時は未分析+可視化フラグ。
- `lib/paths/repository.ts`: (Sprint 5用) `updatePathSet` は既存でOK。Sprint 4では触らない。

## 3. 段階分割 (各段階で tsc/jest green → commit)

**Sprint 4-A (計算エンジン)**: `lib/paths/stats-query.ts` + `stats-format.ts` + テスト。API未結線。純粋にユニットテストで固める。ここが最重要 (SQL正当性・束縛・canonical・glob)。
**Sprint 4-B (detail結線)**: `app/api/paths/[id]/route.ts` GET に compute-on-read。1セットの完全統計。実CHで1セット目視確認。
**Sprint 4-C (list結線)**: `app/api/paths/route.ts` GET に軽量サマリ。キャッシュ (L1+Redis) 導入。N+1クエリ抑制。
**Sprint 4-D (可観測化)**: paths統計のCH失敗を、cv-journey同様 `/api/health` か既存ログに可視化 (静かなダミー化を防ぐ既存方針の横展開)。
**Sprint 5 (任意・write-back化)**: `computePathSetStats` を cron/内部ジョブから呼び `updatePathSet` で KVへ observed_approx を焼き込み、compute-on-read をキャッシュ層に降格。日次delta(前週比 `summary.delta`)もここで。AI Insight (`insights[]`) も Sprint 5 (LLM、別スコープ)。

## 4. 検証 (各段階)
- `npx tsc --noEmit` EXIT 0
- `npx jest paths --runInBand` green
- **実CH検証必須** (Codex desktop、cv-journey と同じ IP-ACL/Tunnel経由): 実サイト `CIP_EcwUTHEZdIOAUqum` (bihadashop) で既知のURL経路を定義し、通過数が実データと一致するか。空経路 (存在しないURL) が捏造でなく0/未分析になるか。
- **D-07**: 実データは `evidence_level='observed_approx'`、CH失敗時は数値を出さず未分析 (捏造禁止)。

## 5. 既知のスキーマ注意点 (調査で判明)
- 使う events列 (session_id/url/event_type/timestamp/tenant_id/site_id/conversion_type/device_type) は全て実在確認済。
- `is_agent` はDDLがこのリポジトリに無いが本番実在 (heatmap が使用、worker が書込)。paths が `AND is_agent=0` を使う前提は本番で有効。
- `events.source`/`source_medium` 列は**存在しない** (sessions の utm_*/referrer_type から計算)。paths funnel は source 絞り込み不要なので無視でよい。
- CH client は `getClickHouseClient('analytics_reader')` (RO, max_execution_time=30s)。
