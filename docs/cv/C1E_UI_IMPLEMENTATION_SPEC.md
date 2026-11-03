# C1-e 実装指示書 — CV定義 管理画面UI + E2E

> 作成: 2026-07-17 / 親設計: [CV_DEFINITIONS_DESIGN.md](./CV_DEFINITIONS_DESIGN.md) §6
> 目的: /goal 一気完走用。親設計 §6 が未記述の3点 (①ビルダー状態設計 ②プレビューUX ③evidence表示規約) を確定させ、エージェントの裁量事故を防ぐ。
> **本書と親設計が矛盾したら本書が優先** (本書は実装済み C1-d API の実コードを根拠に書かれているため)。

---

## 0. 前提 (確定済み・変更禁止)

- C1-a〜d は commit 済み (`f8bbf69` C1-b / `0208feb` C1-c / `3f9aa3d` C1-d)。branch: `feat/conversions-c1a`。
- UI が叩く API は実装済み。**契約はコードが真実源**:
  - `GET /api/conversions?site_id=&periodDays=` → `{ tenant_id, site_id, periodDays, statsComputed, statsReason?, count, definitions: (CvDefinition & { stats: { cvSessions, cvEvents, supported, reason? } })[] }`
  - `POST /api/conversions` (body に site_id 埋め込み) → 201 で CvDefinition / 400 `invalid_body`+issues / 403 / 409 `limit_exceeded`
  - `GET/PUT/DELETE /api/conversions/[id]?site_id=` — PUT は version 楽観ロック、**不一致 409**
  - `POST /api/conversions/preview?site_id=&periodDays=` body `{ trigger, scope? }` → `{ statsComputed, reason?, periodDays, cvSessions, cvEvents, supported, unsupportedReason? }` / **429 `rate_limited`** (tenant 30回/分)
- 型は `lib/conversions/types.ts` から import。**UI 側で Zod スキーマ・型を再定義しない。**
- ミラー元 (流儀の真実源): `app/(proof)/paths/*` + `components/paths/*` + `tests/e2e/paths.spec.ts`

## 1. ファイル構成 (親設計 §6 のとおり + 修正1点)

```
app/(proof)/conversions/layout.tsx        ← paths/layout.tsx コピー (Toaster mount)
app/(proof)/conversions/page.tsx          ← 一覧 (Server page → Client view)
app/(proof)/conversions/new/page.tsx
app/(proof)/conversions/[id]/edit/page.tsx
components/conversions/cv-def-form.tsx    ← useCvDefBuilder + CvDefFields (§2)
components/conversions/cv-defs-list-view.tsx
components/conversions/cv-def-new-view.tsx
components/conversions/cv-def-edit-view.tsx
tests/e2e/conversions.spec.ts             ← §6
```

**⚠修正1点: 詳細ページは作らない** (`[id]/page.tsx` なし — paths と違う)。
作成成功 (201) 後は **`/conversions` (一覧) へ router.push + 成功トースト**。編集成功も同様に一覧へ戻る。

ナビ: `components/layout/sidebar-nav.tsx` の `PRIMARY_NAV` に
`{ navKey: 'conversions', href: '/conversions', label: 'CV定義', icon: <Target /> }` を1エントリ追加 (lucide-react `Target`)。既存エントリの順序・構造は変更しない。

## 2. 【隙間①】useCvDefBuilder 状態設計 — フラット下書き + 送信時シリアライズ

`CvTrigger` は discriminated union (page_reach / click / custom_event) だが、
**state を union で持つな**。トリガー型を切り替えるたびに入力値が消える UI は事故る。

### 2.1 Draft 型 (フラット上位集合 — 全 kind のフィールドを常に保持)

```ts
// cv-def-form.tsx 内で定義 (export する)
export interface UrlMatchDraft {
  mode: 'exact' | 'prefix' | 'contains'
  value: string            // exact/prefix は path、contains は部分一致文字列
}

export interface CvDefDraft {
  name: string
  cvKey: string            // ^[a-z0-9_]{1,64}$ — 入力欄下に常時ヒント表示
  description: string
  enabled: boolean
  triggerKind: 'page_reach' | 'click' | 'custom_event'
  // --- page_reach 用 ---
  pageReachUrl: UrlMatchDraft
  // --- click 用 (全て空文字 = 未指定。表示は kind='click' 時のみ) ---
  hrefHostsText: string    // 改行/カンマ区切り → string[] (max 8)
  hrefContains: string
  hrefPathUse: boolean     // false = 条件不使用 (optional UrlMatch の表現)
  hrefPath: UrlMatchDraft
  elementId: string
  elementClassContains: string
  selector: string
  textContains: string
  pageUrlUse: boolean
  pageUrl: UrlMatchDraft
  // --- custom_event 用 ---
  conversionType: string
  // --- scope (折りたたみ) ---
  utmSource: string
  utmMedium: string
  utmCampaign: string
  deviceType: '' | 'desktop' | 'mobile' | 'tablet'
  // --- value ---
  valueMode: 'none' | 'fixed'
  valueAmount: string      // input は文字列で保持、シリアライズ時に Number
}
```

- `useCvDefBuilder(initial: CvDefDraft)` は `usePathBuilder` と同じ controlled state + immutable setter 群。
- `defaultDraft(): CvDefDraft` (新規用) と `definitionToDraft(def: CvDefinition): CvDefDraft` (編集初期値。union → フラット展開、未使用フィールドは空) を export。

### 2.2 シリアライズ (`draftToBody`) — union はここでだけ組む

```ts
export function draftToBody(draft: CvDefDraft):
  | { ok: true; body: CreateCvDefinitionBody }
  | { ok: false; error: string }
```

- `triggerKind` に応じて該当フィールド**のみ**から `CvTrigger` を構築。他 kind の入力値は捨てる (state には残る = 切替で消えない)。
- click: 空文字/`Use=false` の条件は除外。`hrefHostsText` は `/[\n,]/` split → trim → 空除去 → 小文字化。
- scope: 全フィールド空なら `scope` 自体を undefined に (空オブジェクトを送らない — Zod が落とす)。
- value: `none` なら `{ mode: 'none' }`。

### 2.3 クライアント検証 (`validateDraft`) — サーバ Zod のメッセージを先回り

`validateBuilder` (paths) と同じ「OK なら null、NG ならメッセージ」方式。最低限:
1. name 必須 / cvKey 必須 + `^[a-z0-9_]{1,64}$` 不一致で「cvKey は小文字英数字とアンダースコアのみ (例: affiliate_rakuten)」
2. click: 有効条件 0 個 →「クリック条件を最低1つ指定してください」/ 7 個以上 →「条件は最大6つまでです」/ hosts 9 件以上 →「リンク先ホストは最大8件です」
3. page_reach / hrefPath / pageUrl の exact・prefix: 値が `/` 始まりでも `http(s)://` でもない →「'/' 始まりのパスまたは http(s) 絶対URLを指定してください」
4. custom_event: conversionType 必須
5. valueMode='fixed' で amount が非数値または負 → エラー

**サーバ 400 の issues 配列はトーストに `path: message` で列挙する** (握りつぶし禁止)。

### 2.4 条件フィールドの表示規約 (click)

- 条件カウンタ「n/6」を常時表示 (paths の `{n}/{MAX_BRANCHES}` と同じ流儀)。
- 各フィールドに1行ヘルプ。**特に必須の2つ** (types.ts のコメントが根拠):
  - hrefHosts: 「サブドメインも自動で一致します (rakuten.co.jp は hb.afl.rakuten.co.jp も拾う)」
  - elementId/selector/textContains 群: 「クリックされた要素自身の値で照合します。子要素クリックは不一致になることがあるため、リンク先 (href) 系を主条件に推奨」

## 3. 【隙間②】プレビュー UX 規約 (429 / 失敗 / 0件 / 未対応)

**手動実行のみ。自動発火 (入力のたび debounce fire) は実装しない** — レート制限 30回/分 を UI 側から食い潰さないため。

1. フォーム下部に「プレビュー実行」ボタン + periodDays クイック選択 (`30 / 90 / 180 / 365`、既定 30)。365 が要るのは bihadashop 4ヶ月遡及復元を保存前に見せるため。
2. **in-flight ロック**: リクエスト中は disabled + スピナー。完了後 **1.5 秒のクールダウン** (連打で 429 を自il引きしない)。実装は `useRef<number>` の最終実行時刻比較で十分。
3. 結果表示 (ボタン直下の結果カード、状態は4分岐で網羅):

| 応答 | 表示 |
|---|---|
| 200 + `statsComputed:true` + cvSessions>0 | 「直近{periodDays}日で **{cvSessions} セッション** ({cvEvents} イベント) がCVになります」+ evidence バッジ (§4) |
| 200 + `statsComputed:true` + cvSessions=0 | 「マッチしません — 条件を確認してください」(警告トーン。0 を成果として見せない) |
| 200 + `statsComputed:false` | 「集計を実行できませんでした{reason ? `: ${reason}` : ''}」— **数値は一切出さない** |
| 200 + `supported:false` | 「この条件は現在未対応です: {unsupportedReason}」 |
| 429 | トースト「プレビューが混み合っています。約1分後に再試行してください」。**直前の結果カードは消さず残す** (stale 表示のまま) |
| 400/403/500 | エラートースト (issues があれば列挙) |

4. draft 変更後は結果カードに「条件が変更されました — 再実行してください」の stale マーカーを出す (結果は消さない)。

## 4. 【隙間③】evidence / D-07 表示規約

CLAUDE.md 絶対ルール④の実装点。**数値を出す場所には必ずバッジ、集計失敗時は数値ゼロ埋め禁止**。

1. コンポーネントは既存 `components/dashboard/evidence-badge.tsx` の `EvidenceBadge` を再利用 (新規バッジを作らない)。呼び出し規約:
   ```tsx
   <EvidenceBadge evidence={{ level: 'observed', confidence: 0 }} levelV2="observed_approx" compact />
   ```
   親設計 §3 の裁定どおり **成功時は `observed_approx` 固定** (`EvidenceMeta` の形は `lib/fixtures/dashboard` を確認して合わせる。confidence 0 で % 表示は自動非表示)。
2. 適用箇所: (a) 一覧の CV数カラムヘッダ脇に1個 (行ごとに出さない — ノイズ)、(b) プレビュー結果カード内。
3. `statsComputed:false` (一覧 GET) のとき: CV数カラムは全行 **「—」** + ヘッダに「集計不可{statsReason ? `: ${statsReason}` : ''}」チップ。**0 と表示してはならない** (捏造)。バッジも出さない。
4. `stats.supported:false` の行: 数値の代わりに「未対応」+ title に reason。
5. **POC/dummy fixture を作らない**。定義 0 件の一覧は空状態カード「CV定義がまだありません — 新規作成から始めてください」+ 新規ボタン。paths の `poc-pathset.ts` に相当するものは conversions では作らない (dummy 数値の混入源になるため)。
6. 一覧ヘッダ直下に compute-on-read の説明を1文 (親設計 §9 UX検証の要求):
   「CV数は保存済みの生イベントに対して定義を遡及適用した実測値です。定義の作成・変更は過去の数字にも反映されます。」

## 5. 一覧画面仕様

- テーブル列: `名前 / cvKey / トリガー型 / 状態(enabled toggle) / CV数(セッション) / CVイベント数 / 更新日 / 操作(編集)`
- **periodDays セレクタ** (30/90/180/365) を一覧ヘッダに。変更で GET 再取得。
- **enabled トグル**: `PUT /api/conversions/[id]?site_id=` に `{ enabled, version }`。
  - 楽観更新はしない (シンプルに: 成功レスポンスで行を差し替え)。
  - **409 (version conflict)**: トースト「他の更新と競合しました。最新の状態を再読み込みします」→ 一覧を refetch。
- 削除は edit 画面内 (paths と同じ)。`confirm()` ダイアログ → DELETE → 一覧へ。
- site picker: `session.user.site_ids` が複数のときだけ表示 — **paths の実装 (`paths/page.tsx` → list-view) をそのまま踏襲**。
- viewer ロール: 新規ボタン・enabled トグル・編集リンクを disabled (API は 403 を返すが、UI でも先に塞ぐ)。

## 6. E2E (`tests/e2e/conversions.spec.ts`) — paths.spec.ts 完全ミラー

構成・認証方針・env ゲートを paths.spec.ts からコピーして書き換える:

1. `unauthenticated access redirects to sign-in` (`/conversions` → `/auth/sign-in`)
2. authenticated (E2E_TEST_TOKEN ゲート、cookie `ugokimap_saas_token` 注入):
   - 一覧 render: 「新規CV定義」リンク + 空状態 or 一覧テーブルの見出しが出る
   - 新規フォーム: 未入力送信 → 「CV定義名を入力してください」系のバリデーションメッセージ
   - トリガー型切替: click → custom_event → click と切り替えて、click の入力値が保持されていること (§2 の状態設計の回帰テスト)
   - POST mock (`**/api/conversions` route.fulfill 201) → 一覧へ redirect + 成功トースト
   - **プレビュー mock**: `**/api/conversions/preview` を 200 (`cvSessions: 42`) で fulfill → 「42 セッション」表示。続けて 429 で fulfill → レート制限トーストが出て前回結果が残ること
3. KV happy path: `E2E_CONVERSIONS_KV=1` ゲート (paths の `E2E_PATHS_KV` と同じ構造) — 新規登録 → 一覧に出る → 編集 (改名) → enabled トグル → 削除

## 7. 検証 & commit 規律

各段階 green になるまで commit しない:

```
npx tsc --noEmit                          # EXIT 0
npx jest lib/conversions --runInBand      # 既存 47 tests が壊れていないこと
npx playwright test conversions --list    # spec が認識されること (実行は TOKEN 無ければ skip で可)
```

**git add はこの一覧のみ (個別 add、`git add .` 禁止)**:

```
git add app/(proof)/conversions components/conversions tests/e2e/conversions.spec.ts components/layout/sidebar-nav.tsx
```

commit: `feat(conversions): CV定義 C1-e 管理画面UI+E2E`

**触ってはならないもの** (並行ストリーム、working tree に差分が存在する):
`app/api/auth/magic-link/*` / `app/api/cv-journey/*` / `lib/cv-journey/*` / `components/heatmap/*`

push / PR / deploy は Owner 指示まで実施しない。

## 8. 非スコープ (親設計 §10 + C1-e 固有)

- C2 消費側結線 (cv-journey / paths への和集合解決) — 別 Sprint
- form_submit トリガー / 動的 value / CV freshness 監視 (C3)
- 詳細ページ (`[id]/page.tsx`) / POC fixture / 一覧のグラフ表示
- i18n (既存 UI と同じく日本語ハードコードで可)
