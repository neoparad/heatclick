# CV定義機能 (Conversion Definitions) 設計書

> 作成: 2026-07-15 / 根拠: 4エージェント並列調査 (events語彙 / pathsパターン / cv-journey・paths CV消費マップ / 管理画面構造) + Codexデスクトップ本番CH調査
> 発端: bihadashop CV計測停止 (2026-03-20〜) の根因 = 顧客サイト側のアフィリ計測ビーコン欠落。Owner決定: 「ドメイン直書きでなく**管理画面で顧客がCVを定義する機能**を搭載する。CVは外部リンクだけでなく内部リンク/ボタンID/UTMなど様々な要素で定義できるべき」
> 進め方: Claude実装 → Codexレビュー → Codexデスクトップが tsc/jest/実CH検証 → commit/PR/deploy

---

## 0. 一言で

**「どのユーザー行動をCVと数えるか」を顧客が管理画面で定義し、サーバが生イベントに対して遡及評価する**。GA4のキーイベント / PostHogのアクション相当。トラッカー(tracking.js)は変更しない — 必要な生データ (クリック先URL・要素ID・UTM等) は既に全クリック/全イベントで記録済み。

### なぜこの形か (Ownerとの合意事項)
1. **per-siteの手配線 (GTMタグ修正・テーマ編集) を今後一切なくす**。知能はトラッカーでなく「設定 + サーバ側評価」に置く。
2. CVの定義はサイトごとに違う (アフィリ=外部クリック / EC=サンクスページ到達 / リード=フォーム送信 / ボタンID / UTM流入…) → **汎用ルールビルダー**として設計。「外部リンク」は数あるトリガー型の一例にすぎない。
3. **compute-on-read = 遡及可能**。定義を今日作れば過去のイベントにも適用される。bihadashopの止まっていた4ヶ月分のアフィリCVは、`element_href` にrakuten等が記録されている限り**新規計測なしで復元**される。

---

## 1. 前提事実 (一次証拠, 実装前に既知であるべき罠)

### 1.1 「拾う」は既存。足りないのは「定義とラベル付け」だけ
- tracking.js は全クリックで `element_href` (リンク先URL) / `element_id` / `element_class_name` / `element_text` / `element_selector` / `click_x/y` を送信済み (`public/v2/tracking.js:480-498`)。
- UTM (`utm_source/medium/campaign/term/content` + `gclid/fbclid`) は **全イベントに spread 注入** (`tracking.js:264-265, 353`)。
- worker の `EVENTS_COLUMNS` (`workers/event-ingest/src/worker.ts:62-82`) にこれら全てが含まれ、`clickinsight.events` に永続化される。

### 1.2 マッチに使える語彙 (確定) と使えない語彙
CVルールのマッチ対象は **events テーブルに永続化される列のみ**。UIは使える項目だけを出す (使えない項目を見せて嘘をつかない)。

**使える (EVENTS_COLUMNS 収載・確定)**:
`event_type` / `url` / `referrer` / `element_href` / `element_id` / `element_class_name` / `element_text` / `element_selector` / `element_tag_name` / `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` / `gclid` / `fbclid` / `conversion_type` / `conversion_value` / `device_type` / `session_id` / `visitor_id` / `external_id`

**使えない (workerの `pickColumns` で落ちる、または別テーブル)**:
- `element_path` / `element_x` / `element_y` / `page_title` — events列に無い
- **`form_submit` 系 — `form_interactions` 専用テーブルに routing され events に入らない** (`worker.ts:46-49`) → トリガー型「フォーム送信」は Phase 2 (評価対象テーブルが違うため別実装)
- `behavior_signals` / `video_events` 系イベントの固有フィールド — 同上

### 1.3 継承すべき実データ契約 (paths Sprint 4-B で確定した罠)
1. **conversion_type は `click` 行に載る。`event_type='conversion'` は本番0件** (歴史的データ)。現行 `trackConversion` は `event_type='conversion'` を生むため、**conversion照合は event_type を固定せず `ifNull(conversion_type,'')` 単独一致** — この不変条件を述語ビルダー1箇所に集約する (現状は各所のコメントに散在)。
2. events.url は**絶対URL**保存 → pathname照合は `path(url)` + 末尾スラッシュ除去 (`lib/paths/url-match.ts` の契約を流用)。
3. windowFunnel / countIf 条件に **NULLが1つでも混ざると全滅** → 全条件式を `ifNull(...,'')` で包む。
4. 全CHクエリで `tenant_id` + `site_id` を query_params 束縛 + `is_agent = 0` (§3.8.1 / REQ-SEC-004)。

### 1.4 依存する本番確認 (Codexデスクトップ実行中)
- `element_href` / `utm_*` / `element_id` の**本番実データ充足** (列は確定、中身の量を確認中)。
- `domain(element_href)` 分布で rakuten/amazon/qoo10 クリックが過去〜現在まで記録されているか = **遡及復元の可否**。
- → 万一 `element_href` が空 (GTM配信中のトラッカーが旧版で送っていない等) の場合: トラッカーの更新配信のみで解決 (worker/スキーマ変更不要、列は存在する)。設計は変わらない。

---

## 2. データモデル (`lib/conversions/types.ts`)

命名: 機能名「CV定義」、route `/conversions`、`lib/conversions/`、API `/api/conversions`。既存 `cv-journey` (read-onlyのファネル分析) と prefix衝突しない。

```ts
// Zod schema (実装は funnelMatchSchema / PathSetSchema の流儀を踏襲)

/** URL照合。pathname は paths の正規化契約 (path(url)+末尾スラッシュ除去) を共有 */
type UrlMatch =
  | { mode: 'exact'; path: string }        // '/thanks'
  | { mode: 'prefix'; path: string }       // '/products/'  (UIでは '/products/*' 表記)
  | { mode: 'contains'; value: string }    // 部分一致 (cv-journey position() 互換)

/** トリガー: 「何が起きたらCVか」 */
type CvTrigger =
  | { kind: 'page_reach';                   // ページ到達 (pageview + virtual_pageview)
      url: UrlMatch }
  | { kind: 'click';                        // リンク/ボタンクリック (内部・外部を問わない)
      conditions: ClickConditions }          // AND結合、最低1条件必須
  | { kind: 'custom_event';                 // 既存 trackConversion / GA4 hook が送る conversion_type
      conversionType: string }
  // Phase 2: | { kind: 'form_submit'; formSelector?: string }  ← form_interactions テーブル対応が必要

/** クリック条件 (全て任意、指定したものが AND。空は validation エラー) */
interface ClickConditions {
  hrefHosts?: string[]     // リンク先ホスト群 (1-8件、**フィールド内OR**・suffix一致:
                           // 'rakuten.co.jp' は 'a.rakuten.co.jp' も拾う)。楽天の短縮ドメイン
                           // (a.r10.to 等、実分布はCodex CH調査で確定) を1定義に収める
  hrefContains?: string    // element_href の生部分一致。tel:/mailto: 等のスキームや
                           // クエリパラメータ内のアフィリIDなど、host/pathで表現できないもの用
  hrefPath?: UrlMatch      // リンク先パス (内部遷移CVはこれ)
  elementId?: string       // ボタン/要素の id 完全一致
  elementClassContains?: string
  selector?: string        // element_selector 完全一致
  textContains?: string    // 要素テキスト部分一致
  pageUrl?: UrlMatch       // どのページ上のクリックか
}
```

**⚠計測契約 (レビュー指摘 — UIヘルプ文言に必須)**:
- `element_href` は**最寄りアンカー遡及あり** (`el.closest('a')`, tracking.js:489) — 子要素クリックでも正しく拾う。堅牢。
- `elementId` / `selector` / `elementClassContains` / `textContains` は **e.target (実クリック要素) 自身の値** (tracking.js:492) — `<button id="buy"><svg>…</svg></button>` の svg クリックは elementId 不一致になる。href系を主条件に、ID/selector系は補助条件として推奨。プレビュー0件時の案内にこの原因候補を含める。
- `element_text` のPIIサニタイズは **utils拡張ロード時のみ** (tracking.js:493 の三項) — 未ロードサイトでは生テキスト100字。textContains の一致挙動はサイト構成依存。
- **scope の UTM は「イベント行に載ったUTM」への一致** — UTMは各ページロードのURLから取得されるため、実質ランディングページ上のイベントに限られる。「UTM流入したセッションの後続CV」のようなセッションレベル帰属は Phase 2 (session集合の積、サブクエリ要)。UIの文言は「UTM付きURL上での行動」と正確に書く。
```ts

/** スコープ (どのトリガー型にも付けられる追加AND条件) */
interface CvScope {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  deviceType?: 'desktop' | 'mobile' | 'tablet'
}

interface CvDefinition {
  id: string                    // uuid
  tenant_id: string
  site_id: string
  name: string                  // 表示名 例: '楽天アフィリ送客'
  cvKey: string                 // 集計キー (slug ^[a-z0-9_]{1,64}$) 例: 'affiliate_rakuten'
                                // conversion_type と同じ名前空間。cv-journey/paths が参照する識別子
  description?: string
  enabled: boolean              // 無効化しても定義は残る (集計から除外)
  trigger: CvTrigger
  scope?: CvScope
  value: { mode: 'none' } | { mode: 'fixed'; amount: number }   // Phase 2: data属性/イベント値
  created_at: string
  updated_at: string
  version: number               // best-effort 楽観ロック (⚠新規実装。paths に version は無い —
                                // レビューで判明した誤引用を訂正。Cloudflare KV に CAS が無いため
                                // read時 version 不一致→409 の best-effort で、書込競合窓は許容)
}
```

**設計判断**:
- **cvKey = 仮想 conversion_type**。`custom_event` kind は生の conversion_type をそのまま参照し、`click`/`page_reach` kind は「述語で計算される仮想の conversion_type」になる。消費側 (paths の `conversion:<key>` / cv-journey の `conversionType`) の解決は **和集合**: `(定義の述語) OR ifNull(conversion_type,'') = cvKey`。
  - **⚠和集合にする理由 (レビューHIGH級指摘)**: bihadashop の cvKey `affiliate_rakuten` は**過去の生 conversion_type と同名**。定義述語だけで置換すると、旧ビーコン計測分 (2026-03以前の721行、element_href の形が異なる可能性) が数字から消え、C2切替時点で時系列が黙って不連続になる。和集合なら定義は生イベントの上位互換になり、過去も新規も欠けない (セッションユニーク集計なので二重計上もされない)。
- **CVの数え方 = セッションユニーク** (`uniqExactIf(session_id, <述語>)`)。1セッション内の同一CV多重発火は1と数える (GA4のセッションキーイベント同等)。生イベント件数は副次指標として併記。
- 上限ガード: 1サイト最大50定義 / ClickConditions は最低1・最大6条件 / 文字列長 ≤256。

---

## 3. 評価器 = 述語ビルダー (`lib/conversions/predicate.ts`) — 本設計の心臓

**「ルール → SQL述語」の変換点をリポジトリ全体でここ1箇所にする** (調査で判明した3重複 — cv-journey `buildStepCondition` / paths `buildPathStepCondition` / hybrid-query 8箇所のインラインCV述語 — を段階的にここへ収束)。

```ts
interface CvPredicate {
  expr: string                          // SQL断片 (全値 {p:String} param束縛、ifNull NULL-safe)
  params: Record<string, string>       // query_params
  supported: boolean                    // 未対応条件は false + reason (数値を捏造せず降格)
  reason?: string
}

function buildCvPredicate(def: CvDefinition, paramPrefix: string): CvPredicate
```

**生成SQL (トリガー型別)**:

| kind | 述語 (概形) |
|---|---|
| `page_reach` | `ifNull(event_type,'') IN ('pageview','virtual_pageview') AND <UrlMatch on url>` |
| `click` | `ifNull(event_type,'') IN ('click','rage_click','dead_click') AND <conditions...>` |
| `custom_event` | `ifNull(conversion_type,'') = {p:String}` — **event_type を固定しない (罠1.3-1 の集約点)** |

**⚠click が3種を含む理由 (レビューHIGH指摘の反映)**: tracking.js の `_isDead` は祖先5要素しか遡らないため、深くネストしたカード型リンク (`a>div>div>div>span>img`) のクリックは **dead_click に再分類される**。一方 `element_href` は無制限の `closest('a')` で正しく記録される (tracking.js:468-478 vs :489)。`='click'` 単独だと「href に rakuten が載っているのに CV 0件」というサイト単位の全滅 = 静かな失敗を再生産する。ClickConditions が最低1条件必須なので IN 拡張による誤検知は実質ゼロ。rage_click (近傍3連打の3打目以降) も同様に含める。

**ClickConditions → SQL**:
- `hrefHosts` (フィールド内OR): `multiMatchAny` は使わず単純に `(host_cond_1 OR host_cond_2 ...)`、各 `host_cond_i` = `(domain(ifNull(element_href,'')) = {p_i} OR endsWith(domain(ifNull(element_href,'')), concat('.', {p_i})))` — サブドメイン許容の suffix一致
- `hrefContains`: `position(ifNull(element_href,''), {p}) > 0` — tel:/mailto:/クエリ内アフィリID用の生部分一致
- `hrefPath` / `pageUrl` / `page_reach.url`: `UrlMatch` 共通変換 — `exact`/`prefix` は `pathnameMatchSql()` (paths契約)、`contains` は `position(ifNull(url,''), {p}) > 0` (cv-journey互換)
- `elementId`: `ifNull(element_id,'') = {p}`
- `elementClassContains`: `position(ifNull(element_class_name,''), {p}) > 0`
- `selector`: `ifNull(element_selector,'') = {p}`
- `textContains`: `position(ifNull(element_text,''), {p}) > 0`
- scope: `ifNull(utm_source,'') = {p}` 等の等値AND

**集計ビルダー** (`lib/conversions/stats-query.ts`):
```ts
// 全定義を events 1スキャンで同時集計 (定義ごとにクエリを撃たない)
async function computeCvStats(client, defs: CvDefinition[], opts: {tenantId, siteId, periodDays}):
  Promise<Array<{ defId: string; cvSessions: number; cvEvents: number; supported: boolean }>>
// SELECT uniqExactIf(session_id, <pred_1>) AS s_1, countIf(<pred_1>) AS e_1, ... FROM events
// WHERE tenant_id={t} AND site_id={s} AND is_agent=0 AND timestamp >= now()-toIntervalDay({d})
```
- base WHERE は paths `baseEventQuery` (`lib/paths/stats-query.ts:113-127`) を共通化して流用 (seam 2)。
- CH失敗 → **paths方式で可視化** (`statsComputed:false` + reason。数値を捏造しない、dummyに落とさない)。D-07: 成功時は `observed_approx` バッジ。

---

## 4. 永続化 (`lib/conversions/repository.ts`) — paths のコピー

- `lib/scenarios/kv-storage.ts` の `KvStorage` を**そのまま**使用 (prefix分離設計済み、新規実装ゼロ)。
- key: `cvdefs/{tenant_id}/{site_id}/{id}` / index: `cvdef-index/{tenant_id}/{site_id}`。
- `lib/paths/repository.ts` (133-389) をコピーし schema/prefix 差し替え:
  - index-union list (KV結果整合対策) / **REQ-SEC-004: keyを信頼せず row自身の tenant_id/site_id を再検証** / `authorize` フック / audit fire-and-forget。
- audit action: `lib/scenarios/audit.ts` の union に `cvdef.created / cvdef.updated / cvdef.deleted / cvdef.access_denied` を追加 (audit_events テーブル共用)。

---

## 5. API (`app/api/conversions/`)

paths の規約に完全準拠 (素オブジェクトレスポンス / `runtime='nodejs'` / `dynamic='force-dynamic'` / `Cache-Control: no-store` / Zod safeParse / `handleError` のHTTP写像)。

| route | method | 内容 |
|---|---|---|
| `/api/conversions?site_id=&periodDays=` | GET | 定義一覧 + **compute-on-read で各定義の cvSessions を付与** (`computeCvStats` 1クエリ)。`periodDays` 1-365 (既定30、上限は paths/cv-journey と同じ365) — **遡及復元の確認には期間を広げられることが必須** (bihadashopの4ヶ月復元を見せるため)。CH失敗時は定義のみ+`statsComputed:false` |
| `/api/conversions?site_id=` | POST | 作成。`canWriteScenario(role)` (viewer拒否) |
| `/api/conversions/[id]?site_id=` | GET / PUT / DELETE | 単体CRUD。PUTは version best-effort 楽観ロック (不一致409) |
| `/api/conversions/preview?site_id=` | POST | **保存前ドライラン** (レビュー指摘で明文化)。body = trigger/scope 部分のみ (CRUDと同一Zodスキーマの partial)、`canWriteScenario` 必須、KVに書かず `computeCvStats` を単発実行して `{cvSessions, cvEvents, statsComputed, supported}` を返す。**レート制限: tenant単位 30回/分** (magic-linkのRedis fixed-window流用、超過429)。UI側もデバウンス |

- テナント解決: `lib/paths/tenant-context.ts` の `resolvePathTenantContext` を **`lib/tenant-site-context.ts` (仮) に汎用昇格**して両機能から使う (audit action名だけ注入可能に)。昇格が大きければ Phase 1 はコピーで可。
- middleware は `/api/*` を自動で `api-tenant` 分類するため追加設定不要。`?site_id=` は middleware が JWT `site_ids` 包含を事前チェック (既存動作)。

---

## 6. 管理画面 (`app/(proof)/conversions/`)

paths のUI一式をミラー (Server page → Client view → 共有フォーム hook/Fields 分離):

```
app/(proof)/conversions/layout.tsx        ← Toaster mount (paths/layout.tsx コピー)
app/(proof)/conversions/page.tsx          ← 一覧 (定義 + 直近30日CV数 + enabled toggle)
app/(proof)/conversions/new/page.tsx
app/(proof)/conversions/[id]/edit/page.tsx
components/conversions/cv-def-form.tsx    ← useCvDefBuilder + CvDefFields (path-builder-form 流儀)
components/conversions/cv-defs-list-view.tsx / cv-def-new-view.tsx / cv-def-edit-view.tsx
```

**フォームUX**:
1. トリガー型を選ぶ (ページ到達 / クリック / カスタムイベント) → 型に応じた条件フィールドだけ表示
2. 条件フィールドは §1.2 の「使える語彙」のみ (使えない項目は出さない)
3. スコープ (UTM/デバイス) は折りたたみの詳細設定
4. **プレビュー**: 保存前に「この条件だと直近30日で N セッションがCVになります」を `computeCvStats` のドライランで表示 (捏造防止 + 設定ミスの即時発見。0件なら「マッチしません — 条件を確認してください」)
5. site picker: `session.user.site_ids` が複数のときだけ表示 (paths と同じ)

**ナビ**: `components/layout/sidebar-nav.tsx` の `PRIMARY_NAV` に `{ navKey:'conversions', href:'/conversions', label:'CV定義', icon:<Target/> }` を1エントリ追加。

**seed (bihadashop 即時復旧用)**: 初回リリース時に bihadashop (linkth_internal) へ4定義を投入するスクリプト (`scripts/operator/seed-bihadashop-cvdefs.mjs`):
`affiliate_rakuten` (click, hrefHost=rakuten.co.jp ほか短縮ドメインはCodex CH調査の実分布から確定) / `affiliate_amazon` / `affiliate_qoo10` / `affiliate_other`。→ **過去4ヶ月分が遡及して数字に戻る**。

---

## 7. cv-journey / paths との統合 (単一の真実源へ)

調査で確定した現状: 「CVとは何か」が3箇所でバラバラ定義 (cv-journey 構造化DSL / paths 文字列DSL / hybrid-query 8箇所インライン)。conversion述語のSQLは既に文字列レベルで一致 → 統合条件は揃っている。

**段階統合 (挙動不変→挙動変化の順、各段で検証)**:

| Sprint | 内容 | 挙動 |
|---|---|---|
| **C1 (MVP)** | §2-6 の新機能一式 + bihadashop seed。既存 cv-journey/paths は無変更 | 追加のみ |
| **C2** | 消費側の結線: (a) cv-journey `fetchTotals` の汎用CV述語を「(enabled な定義のいずれかにマッチ) OR (生 conversion_type 非空)」の和集合へ (b) cv-journey funnel の conversionType / paths の `conversion:<key>` を **和集合解決** (`定義述語 OR 生conversion_type一致`、§2の連続性保証) に (c) hybrid-query のインライン汎用CV述語を `buildCvPredicate` へ集約 — **完了条件は件数でなく `grep 'conversion_type IS NOT NULL'` の0件化** (レビュー実測で8箇所でなく10行。リテラル件数を追うと集約漏れする) | 定義がなければ完全後方互換 |
| **C3** | form_submit トリガー (form_interactions テーブル対応) / value の動的取得 / **CV freshness監視 (P0-α1横展開: 定義ごとの最終マッチ時刻を /api/health に)** — 今回の「4ヶ月無検知」の再発防止 | 拡張 |

- pageview URL照合方式の差 (cv-journey `position` 部分一致 vs paths pathname正規化) は `UrlMatch` が両モードを持つことで吸収。既存消費側は当面現行モードを維持し、pathsの正規化方式へ将来収束。
- evidence_level は 5-tier (`types/evidence.ts` の EvidenceLevelV2) に揃える。

---

## 8. 実装フェーズ分割 (C1 の中の作業順)

各段階で `npx tsc --noEmit` EXIT 0 + `npx jest conversions --runInBand` green → commit (Codexデスクトップ実行)。

1. **C1-a 型と述語** — `lib/conversions/types.ts` + `predicate.ts` + テスト (SQL断片・param束縛・NULL-safe・hrefHost suffix・UrlMatch 3モード・未対応降格を網羅)。**最重要・最初に固める**
2. **C1-b 集計** — `stats-query.ts` (1スキャン集計) + fakeClient テスト
3. **C1-c 永続化** — `repository.ts` + テスト (REQ-SEC-004 / index-union / version楽観ロック)
4. **C1-d API** — `app/api/conversions/*` + テスト (認証403 / Zod400 / CRUD / compute付きGET)
5. **C1-e UI** — 管理画面一式 + ナビ + E2E (`tests/e2e/conversions.spec.ts`, paths.spec.ts 流儀)
6. **C1-f seed** — bihadashop 4定義スクリプト + 実CH検証 (Codex: 遡及CV数が §1.4 の分布と一致するか)

## 9. 検証 (D-07 / セキュリティ)

- **実CH検証** (Codexデスクトップ):
  - seed 4定義の cvSessions が `domain(element_href)` 分布と整合
  - **アフィリhref行の event_type 分布** (`SELECT event_type, count() WHERE domain(element_href) LIKE '%rakuten%' GROUP BY event_type`) — dead_click/rage_click 混入率を実測し、§3 の IN 3種の妥当性を裏取り (レビューHIGH指摘のフォロー)
  - **各 seed キーで「定義述語カウント」vs「生 conversion_type カウント」の期間別比較** — 和集合解決 (§2) で時系列が不連続にならないことの確認
  - 存在しない条件が 0件かつ「未マッチ」表示 (捏造なし) / tenant跨ぎ 403 + audit
- **セキュリティ** (subagent枯渇のためClaudeインラインレビュー実施済、実装時にCodex dualで再確認):
  - 述語ビルダーは全値 query_params 束縛。**識別子(列名)はユーザー入力から一切組み立てない** — ClickConditions の各フィールド→列名は固定マップ、`pathnameMatchSql` は識別子検証済 (lib/paths/url-match.ts:55-62)。cvKey は slug 正規表現でZod検証
  - テナント越境: repository の REQ-SEC-004 (row自身のtenant/site再検証) + computeCvStats の WHERE は JWT由来 ctx のみから束縛 + middleware の site_ids 事前チェック、の3層
  - **エラーの情報漏洩**: stats系のCH失敗はクライアントへ `statsComputed:false` + 汎用reasonのみ。**CH生エラー (スキーマ/接続情報) は絶対にレスポンスに載せない** — サーバ側ログ (pino/Sentry) のみ
  - preview のDoS: レート制限 (§5) + max_execution_time + 定義条件数上限で有界
  - RBAC: 読取=member/viewer可 (定義に機微なし)、書込/enabled切替= `canWriteScenario` (viewer拒否)
  - T1 (tenant isolation関与) につき **Claude + Codex dual review 必須**
- **性能**: 1スキャン集計 + `max_execution_time:30` (analytics_reader既定)。定義50上限で述語も有界
- **UX検証**: 定義の作成/変更/無効化が cv-journey/paths の数字を**遡及的に**変えること (compute-on-readの仕様) を UI に明記 (一覧ヘッダに一文 + 変更は audit 記録済)。seed スクリプトは冪等 (同 cvKey が既存なら skip)

## 10. 明示的な非スコープ (C1)

- トラッカー変更 (不要が確定) / form_submit (C3) / 動的value / CVファネルUIの作り替え (cv-journeyが担う) / write-back・キャッシュ (paths同様 no-store で開始、負荷が出たら screenshot-cache のL1+ロックパターンを後付け)
