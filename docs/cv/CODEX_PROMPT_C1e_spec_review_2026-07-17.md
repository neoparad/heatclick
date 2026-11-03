# Codex 委譲プロンプト — C1-e 実装指示書のレビュー + 改善

> 作成: 2026-07-17 / 宛先: Codex デスクトップ
> レビュー対象: `docs/cv/C1E_UI_IMPLEMENTATION_SPEC.md`
> 親設計: `docs/cv/CV_DEFINITIONS_DESIGN.md` §6 / branch `feat/conversions-c1a` (HEAD `3f9aa3d`)

---

## この指示書の用途 (レビューの判断基準)

対象文書は、**自律エージェントに C1-e (CV定義 管理画面UI + E2E) を一気に完走させるための実装指示書**である。
人間が随時補足する前提の設計メモではない。したがってレビューの合格基準は:

> **「この文書だけを渡された実装エージェントが、裁量判断で事故らずに、
> tsc/jest/E2E green + 親設計 §6 準拠の UI を一発で作り切れるか」**

美文かどうかではなく、**曖昧さ・事実誤認・矛盾・欠落**を潰すことが目的。
逆に、過剰指定(エージェントが自明に判断できることまで縛って柔軟性を殺す箇所)も指摘対象。

## Step 1 — 事実検証 (最重要)

指示書は「実装済み C1-d API の実コードを根拠に書いた」と主張している。**その主張自体を疑え。**
以下の実ファイルを読み、指示書の記述と突き合わせて、事実と異なる記述を全て挙げること:

| 指示書の主張 | 検証対象 |
|---|---|
| §0 API 契約 (GET/POST/PUT/DELETE/preview のレスポンス形状・エラーコード・429) | `app/api/conversions/route.ts` / `app/api/conversions/[id]/route.ts` / `app/api/conversions/preview/route.ts` |
| §2 Draft 型が `CreateCvDefinitionBody` に正しくシリアライズ可能か (フィールド漏れ・型不一致) | `lib/conversions/types.ts` (cvDefinitionSchema / createCvDefinitionBodySchema / clickConditionsSchema / urlMatchSchema / cvScopeSchema / cvValueSchema) |
| §2.3 クライアント検証がサーバ Zod と整合するか (メッセージの先回りが実際の reject 条件と一致するか) | 同上 + `normalizeCvHost` / `CV_KEY_PATTERN` |
| §4 EvidenceBadge の呼び出し規約 (`evidence={{ level:'observed', confidence:0 }}` が型に合うか、confidence 0 で % 非表示になるか) | `components/dashboard/evidence-badge.tsx` / `lib/fixtures/dashboard` の `EvidenceMeta` |
| §1 ミラー元の流儀 (Server page → Client view 分離、site picker、Toaster、toast ライブラリ) | `app/(proof)/paths/page.tsx` / `paths/layout.tsx` / `components/paths/paths-list-view.tsx` / `path-new-view.tsx` |
| §5 PUT の version 楽観ロック・enabled トグルの body 形状 | `app/api/conversions/[id]/route.ts` + `lib/conversions/repository.ts` の `UpdateCvDefinitionInput` |
| §5 viewer ロール判定を UI で先回りする方法 (session からの role 取得経路が実在するか) | `lib/scenarios/publish-rbac.ts` / paths の view 実装 / `lib/auth/server-session.ts` |
| §6 E2E の前提 (cookie 名 / env ゲート / mock パターン) | `tests/e2e/paths.spec.ts` / `playwright.config.ts` |

特に重点的に疑うべき箇所 (Claude 自身が自信のない点):

1. **§2.1 Draft 型の `hrefPathUse`/`pageUrlUse` boolean 方式** — optional UrlMatch の表現としてこれが最善か。編集初期値生成 (`definitionToDraft`) との往復で情報が落ちないか。
2. **§3 プレビューの「手動実行のみ + 1.5秒クールダウン」** — 30回/分の制限に対して過剰か不足か。stale マーカーの実装コストは妥当か。
3. **§4 の `observed_approx` 固定** — `uniqExactIf` は exact 集計なのに親設計 §3 は observed_approx を指定している。この裁定をそのまま採用したが、`observed_exact` が正しいなら親設計ごと訂正すべきか、evidence 意味論の観点から判定せよ。
4. **§1 「詳細ページを作らない」の断定** — 親設計 §6 のファイル一覧に `[id]/page.tsx` が無いことを根拠にしたが、一覧行クリックの遷移先が edit になることの UX 妥当性を含めて判定せよ。
5. **§5 enabled トグルの「楽観更新はしない」** — シンプルさ優先の裁定だが、トグルの体感遅延 (KV round-trip) とのトレードオフを判定せよ。

## Step 2 — 完走可能性監査 (エージェント裁量事故の予見)

実装エージェントになったつもりで指示書を頭から実行トレースし、**判断に迷う・解釈が割れる・手が止まる箇所**を列挙せよ。例:

- 指定が無いために勝手に決めることになる UI 要素 (レイアウト・ボタン配置・トースト文言・ローディング状態)
- 「paths を踏襲」とだけ書かれていて、paths 側に該当実装が無い/複数流儀がある箇所
- §6 E2E の各シナリオが、§2-5 の指定通りに実装した UI に対して実際に pass しうるか (セレクタ・文言の整合)
- `git add app/(proof)/conversions ...` — このパス表記が Windows の git で glob 解釈事故を起こさないか

## Step 3 — 改善提案

指摘の各項目に**具体的な修正文面** (指示書にそのまま貼れる差し替え文) を付けること。
加えて、指示書に無い観点で「入れておくと完走率が上がる」提案があれば OPTIONAL として提示
(ただし総量が膨らむ提案は不可 — この文書は短いほど強い)。

## 出力形式

`docs/cv/C1E_SPEC_REVIEW_codex_2026-07-17.md` に以下の構成で書き出すこと:

```
# C1-e 指示書レビュー (Codex)

## 1. 指摘一覧
| 深刻度 | 指示書§節 | 指摘 | 修正案 |
(深刻度: BLOCKER=事実誤認・実装不能 / HIGH=裁量事故を誘発 / MEDIUM=曖昧・非効率 / LOW=好み)

## 2. 実行トレースで手が止まった箇所 (Step 2 の結果)

## 3. OPTIONAL 提案

## 4. 総合判定
GO (このまま /goal 投入可) / 条件付きGO (BLOCKER+HIGH 修正後) / NO-GO (再設計要)
```

## 制約

- **レビューのみ。コード・指示書本体の変更はしない** (修正はレビュー受領後に Claude が実施)。
- 検証で実ファイルと矛盾を見つけた場合、**必ず file:line を添えて**指摘すること (根拠なしの指摘は不可)。
- 並行ストリームの working tree 差分 (`app/api/auth/magic-link/*` / `lib/cv-journey/*` / `components/heatmap/*`) には触れない。
- tsc/jest の実行は不要 (コード変更が無いため)。読むだけでよい。
