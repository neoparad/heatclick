# Codex Desktop 用プロンプト (実装レビュー 3回目・自己完結型): 第一者 Set-Cookie 化 — PR #29

> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`、ブランチ `feat/first-party-visitor-cookie` (PR #29)
> **今回から方式変更: 見つけた問題は報告するだけでなく、あなた自身が修正・テスト・コミットまで
> 完了させる。Owner の判断が必要なものだけを報告に残す。** 往復を減らすため。

---PROMPT---

あなたは T1 (Critical) セキュリティレビュアー兼実装者です。これまで 2 回のレビュー (REJECT×2) で
指摘 → Claude が修正 → 再レビュー、という往復をしてきましたが、**今回からあなたが修正まで
完結させます**。

## 前提

- 設計書: `docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` (v5、§3-1 step 3 が束縛条件 1-5、
  §4 S-9/S-10、§7 が Owner 判断事項、付録 3/4 が過去 2 回の対応表)
- 主要コード: `workers/event-ingest/src/visitor-cookie.ts` (純関数)、`workers/event-ingest/src/worker.ts`
  (handler、`getRegisteredSiteBinding`、`countTenantsRegisteredForHost`)、
  `scripts/operator-provision-site.mjs`
- テスト: `cd workers/event-ingest && node --test test/*.test.mjs` (Node 22.6+、実 TS を直接 import。
  現状 79/79 pass)。型: `../../node_modules/.bin/tsc -p tsconfig.json --noEmit` (worker dir で、
  `npm ci` 済み)。バンドル: `npx wrangler deploy --dry-run --outdir .wrangler/dry`
- 前回 (2回目) の指摘と今回の対応: 付録4 参照。要点 — [HIGH] JWT 経路のテナント境界 → 束縛条件 (4)
  サイト登録テナント == accepted テナント を追加、[MEDIUM] 同一ホスト複数テナント → 条件 (5)
  実行時照会 + 登録スクリプトで拒否、[MEDIUM] プロキシ信頼境界 → §6 負のテスト・§2 要件化

## あなたがやること (この順で、1 回のセッションで完結させる)

### 1. 前回指摘の fix 確認 (再現手順を自分で叩く)

- [HIGH] `attacker_tenant` の有効 JWT + `victim_site` + `X-Forwarded-Host: victim.example` +
  `Sec-Fetch-Site: same-origin` + 被害者 Cookie → INSERT 行の `visitor_id` が payload 値のままで
  Set-Cookie が無いこと。正規経路 (被害者テナント JWT + 被害者 site) は束縛成立すること
- [MEDIUM] `shared.example` を 2 テナントが登録 → 両方とも束縛しない。照会が CH 5xx なら fail closed。
  照会は他条件を満たしたリクエストでのみ発行される

### 2. 新たな穴を探し、**見つけたら自分で直す**

観点 (これに限らない):
- JWT 経路と tracking_js 経路が 1 リクエストに混在して条件 (4) をすり抜ける組合せ
- `lower(domain(url))` (ClickHouse 側) と `hostFromUrl` (Worker 側) の正準化のずれ
  (IDN / 末尾ドット / ポート / 大文字 / スキーム無し url) で片方だけ一致する経路
- `SITE_HOST_CACHE` と `HOST_TENANTS_CACHE` の独立 TTL による、登録変更直後 5 分間の古い判定
- プロキシが `X-Forwarded-Host` を「追記」する構成で先頭採用が破れる経路 (Worker 側で緩和できるなら)
- テストが捕捉していない経路

**修正の基準**: 修正が局所的で、設計書 §1-§4 の設計判断を変えないものは、あなたが直す。
直したら **必ず** (a) 回帰テストを追加 (既存ファイルの流儀に合わせる)、(b) 全テスト pass、
(c) tsc clean、(d) wrangler dry-run 成功、(e) 設計書の該当箇所と付録に「付録5: 3回目 (Codex 自己修正)」
として何をなぜ直したかを追記。

### 3. Owner 判断が必要なものだけ報告に残す

以下に該当するものは **直さずに** findings として報告 (severity 付き、実コードの裏付け付き):
- 設計判断の変更 (例: `resolveTenant` の JWT 経路に site 所有照合を追加するか — §7 に既出、
  これは Owner 判断なので触らない)
- 認可・認証の仕様変更、secrets、デプロイ、顧客側 (プロキシ設定) の作業を要するもの
- 修正すると既存顧客の挙動が変わるもの
- 修正方法が複数あり、どれを取るかがトレードオフになるもの (選択肢と推奨を書く)

### 4. コミット

- 修正したファイルを **名指しで** `git add` (`git add -A` / `.` 禁止 — 並行セッションの差分が
  作業ツリーにある: `app/api/cv-journey/*`, `lib/cv-journey/*`, `app/api/auth/magic-link/*`,
  `components/heatmap/*` は触らない・stage しない)
- `git commit` (message は日本語、`fix(event-ingest): ...` 形式、末尾に
  `Co-Authored-By: Codex <noreply@openai.com>`)。**push / merge / deploy はしない** (Owner ゲート)
- 生成物 (`.wrangler/` は .gitignore 済み) を stage しないこと

## 出力形式 (短く)

1. 前回指摘の fix 確認結果 (各 1 行: CONFIRMED / STILL BROKEN + 根拠)
2. 自分で直したもの一覧 (何を・なぜ・どのテストで固定したか・commit hash)
3. Owner 判断が必要な findings (無ければ「なし」)
4. 検証結果 (tests N/N、tsc、dry-run)
5. 総合判定: **APPROVE** (Owner 判断事項以外は解消) / REJECT (自分で直せない CRITICAL/HIGH が残る場合のみ) + 理由 3 行以内

理論上の可能性のみで実コード・実挙動の裏付けがないものは書かないでください。
