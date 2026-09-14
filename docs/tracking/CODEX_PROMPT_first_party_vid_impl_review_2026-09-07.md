# Codex Desktop 用プロンプト: 第一者 Set-Cookie 化 — 実装 (PR #29) の T1 レビュー

> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`、ブランチ `feat/first-party-visitor-cookie` (PR #29)
> 設計書: `docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` (v3)
> 前段: 設計書 v2 の Codex レビュー (REJECT、7件) → v3 で反映済み。v3 の再レビュー (round2) は
> Owner 判断で実装を先行したため未実施。**本レビューで設計 v3 の再確認と実装確認を兼ねる。**

---PROMPT---

あなたは T1 (Critical) セキュリティレビュアーです。visitor_id Cookie の発行をクライアント JS から
Cloudflare Worker の Set-Cookie へ移す実装をレビューしてください。Cookie / CORS / tenant isolation に
触れるため、このリポジトリの規約で Claude + Codex の dual review が必須です。

## レビュー対象

`git diff origin/main...feat/first-party-visitor-cookie` (PR #29)。主要ファイル:

- `workers/event-ingest/src/visitor-cookie.ts` — 新規・純関数 (parse / 検証 / 正準化 / Set-Cookie 生成)
- `workers/event-ingest/src/worker.ts` — handler 組込 (import、corsHeaders の書換、200 応答への Set-Cookie 付与)
- `workers/event-ingest/wrangler.toml`, `tsconfig.json`, `package.json`
- `workers/event-ingest/test/visitor-cookie.test.mjs`, `test/handler-set-cookie.test.mjs`
- `components/install/install-settings-pane.tsx`, `scripts/operator-provision-site.mjs` (文言のみ)
- 設計書 `docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` v3 (§3-1 / §3-2 / §4 が実装の仕様)

テスト実行: `cd workers/event-ingest && node --test test/*.test.mjs` (Node 22.6+、TS を直接 import)。
型チェック: `cd workers/event-ingest && npm ci && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit`。

## 前回 (設計 v2) で指摘した 7 件が実装で守られているか — 必ず確認

1. [HIGH] payload `visitor_id` の未検証 → `visitor-cookie.ts` の `resolveCanonicalVisitorId` /
   `pickPayloadVisitorId` が payload 値にも `VISITOR_ID_RE` を適用しているか。
   `buildVisitorIdSetCookie` が最終防御として再検証しているか
2. [HIGH] host-only の残存リスク (別ポート / cookie tossing) → 同名重複 Cookie を不採用にする
   `parseVisitorIdCookie` の挙動と、それが handler で実際に効いているか (test の duplicate ケース)
3. [HIGH] SameSite=Lax の位置づけ → `corsHeaders` のコメントと `visitor-cookie.ts` ヘッダの不変条件
   記述が設計 D-3 と一致しているか (Lax を None にする余地を残していないか)
4. [MEDIUM] S-8 (workers.dev 直叩きへの Set-Cookie) → 実装は第一者化前の顧客にも Set-Cookie を
   返す (設計通り)。これが既存経路を壊さないか、コード上で確認 (ヘッダ追加以外の差分がないか)
5. [MEDIUM] HTTPS 必須 → Secure 属性が常時付与されること。文言に前提条件が書かれているか
6. [MEDIUM] Set-Cookie の発行条件 → `acceptedEvents.length > 0` の応答 **のみ** か。
   400 / 401 / 413 / 全件 drop の 200 で漏れて付与される経路がないか (handler の全 return を追う)
7. [MEDIUM] ログ → `request.headers.get('Cookie')` の値が console.* / audit_events / INSERT 行の
   どこにも流れないか (`extractHttpHeaders` の対象ヘッダ一覧を含めて確認)

## 実装固有の観点

- **正準化の対象範囲**: `acceptedEvents` 全件の `visitor_id` を 1 つの vid で上書きしている。
  1 リクエストに複数訪問者のイベントが混在しうる経路 (SPA・サーバー中継等) はあるか。
  あるなら「最初の有効値で全件上書き」は誤った統合を起こす — tracking.js の送信単位を読んで判定せよ
- **`is_first_visit` との整合**: vid が mint (サーバー新規発行) になったとき、payload の `is_first_visit`
  が矛盾しうる。分析側に実害があるか、あるなら仕様として記述すべきか
- **`corsHeaders` の '*' 固定化**: `ALLOWED_ORIGINS` を Env から撤去した。本番の Worker secrets /
  vars にこの名前が残っていても無害か (wrangler の挙動)。`OPTIONS` 応答も同一関数経由か
- **Node 直接 import 方式のテスト**: `test/handler-set-cookie.test.mjs` は `globalThis.fetch` と
  `console.error` を差し替えて実 handler を叩く。mock が捕捉できていない外部呼び出し (KV 等) は
  ないか。テストが通っていても検証できていない経路があれば指摘せよ
- **`allowImportingTsExtensions` + `.ts` 拡張子 import**: wrangler (esbuild) のバンドルで問題ないか。
  `npx wrangler deploy --dry-run --outdir /tmp/wr` 相当で確認できるなら実行して報告

## 2段構え

- 明白な問題 (誤記・行番号ズレ・コメントと実装の食い違い) は**直接修正**し、最後に一覧を出す
- 設計判断への異議・セキュリティ上の欠陥は **findings** として severity 付きで報告し、
  あなたの一存でコードを書き換えない (裁定は Owner)

## 出力形式

1. 7件の確認結果 (番号順、CONFIRMED / STILL BROKEN / PARTIALLY + 根拠となる file:line)
2. 実装固有の findings (severity 順)
3. 直接修正した箇所の一覧
4. 総合判定: APPROVE / APPROVE-WITH-CHANGES / REJECT
5. 判定理由 (3行以内)

問題が無い観点は「問題なし」と明記してください。理論上の可能性のみで実コードの裏付けがない
指摘にはその旨を明記してください。
