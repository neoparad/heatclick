# Codex Desktop 用プロンプト (実装レビュー 3回目): 第一者 Set-Cookie 化 — PR #29 の JWT 経路 HIGH 対応確認

> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`、ブランチ `feat/first-party-visitor-cookie` (PR #29)
> 前回 (実装レビュー 2回目): 前々回 HIGH (same-site) = CONFIRMED FIXED。新規 REJECT —
> [HIGH] JWT テナントと Cookie を認可する site が結び付いていない / [MEDIUM] プロキシ信頼境界 /
> [MEDIUM] 同一ホスト複数テナント。本 head で対応した。**主目的は HIGH の再現→遮断の確認**。

---PROMPT---

前回 (実装レビュー 2回目) の T1 レビューで REJECT・[HIGH] 1件 + [MEDIUM] 2件を出しました。
本 head で対応済みです。設計書 v5 (`docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` §3-1 step 3-4/3-5、
§4 S-10、§7、付録4) に対応内容があります。

## 対応内容 (要約)

`isFirstPartyBound` (`workers/event-ingest/src/visitor-cookie.ts`) に条件を 2 つ追加:

4. **サイト登録テナント == accepted events のテナント** — `getRegisteredSiteBinding` (`worker.ts`) が
   `sites.url` のホストに加えて登録 `tenant_id` を返し、resolveTenant が注入した `tenant_id`
   (JWT 経路なら JWT の tenant) と一致する場合のみ束縛。JWT 経路 (site lookup を経ない) では
   host cache が冷えているため、ここで lookup を走らせる
5. **同一ホストを別テナントが登録していない** — 1-4 を満たしたリクエストでのみ
   `SELECT uniqExact(tenant_id) FROM sites WHERE lower(domain(url)) = {host}` を照会
   (`countTenantsRegisteredForHost`、ホスト単位で同 TTL キャッシュ、失敗時は +Infinity = fail closed)。
   登録スクリプト `scripts/operator-provision-site.mjs` でも同一ホストの別テナント登録を拒否

`resolveTenant` 自体 (JWT 経路が site 所有を照合しない既存挙動) は **変更していません** —
認可仕様の変更は Owner 判断として設計書 §7 に別チケット化しました。

## 依頼

### 主目的: 前回 HIGH の fix 確認

前回あなたが再現した経路を **同じ方法で再実行**してください:
`attacker_tenant` の有効 JWT (Bearer) + `victim_site` + `X-Forwarded-Host: victim.example` +
`Sec-Fetch-Site: same-origin` + 被害者 Cookie。期待: INSERT 行は `tenant=attacker_tenant /
site=victim_site` のまま (既存挙動) だが `visitor_id` は payload 値で、Set-Cookie なし。
`test/handler-set-cookie.test.mjs` の "ATTACK (round3 HIGH)" がこの再現ですが、テストに頼らず叩いてください。
あわせて正規経路 (被害者テナント JWT + 被害者 site) で束縛が成立することも確認してください。

### MEDIUM 2件の fix 確認

- 同一ホスト 2 テナント: `shared.example` を `t_shared_a` / `t_shared_b` が登録した構成で、
  両テナントとも束縛しないこと。照会失敗 (CH 5xx) で fail closed になること。
  照会が「他条件を満たしたリクエストでのみ」発行され、未束縛リクエストに追加クエリを課さないこと
- プロキシ要件: 設計書 §6 の負のテスト定義と §2 の要件 (nginx `proxy_set_header X-Forwarded-Host $host;` 必須、
  Vercel は XFH == Host) が、あなたの指摘を満たす粒度か

### 新たに破る経路を探す (攻撃者視点)

- 条件 4 の一致に使う `eventTenant` は `pickSingleTenantId(acceptedEvents)` = resolveTenant が
  注入した値。JWT 経路と tracking_js 経路が **1 リクエストに混在**することはあるか
  (JWT があれば全イベントが JWT 経路になるはず — コードで確認)。混在で条件 4 をすり抜ける組合せは
- `countTenantsRegisteredForHost` の `lower(domain(url))` と Worker 側の `hostFromUrl` の正準化が
  **ずれる**入力 (IDN / 末尾ドット / ポート / 大文字 / `url` にスキーム無し) で、片方は一致・片方は
  不一致になり、束縛が成立してしまう or 誤検知する経路
- キャッシュの整合: `SITE_HOST_CACHE` (site→host,tenant) と `HOST_TENANTS_CACHE` (host→count) は
  独立 TTL。登録変更 (テナント追加・URL 変更) 直後の 5 分間に古い判定で束縛が成立する窓の評価
- `.wrangler/` を `.gitignore` に追加した。他に生成物の混入がないか

### 2段構え (前回同様)

- 明白な問題は直接修正して一覧化。設計判断への異議・セキュリティ上の欠陥は findings
  (severity 付き) で報告し、あなたの一存でコードを変えない

## 出力形式

1. 前回 HIGH の fix 確認 (CONFIRMED FIXED / STILL BROKEN / PARTIALLY + 再現手順と結果)
2. MEDIUM 2件の fix 確認
3. 新たに破る経路 (あれば severity 付き。無ければ観点ごとに「見つからず」と明記)
4. 直接修正した箇所
5. 総合判定: APPROVE / APPROVE-WITH-CHANGES / REJECT + 判定理由 (3行以内)

理論上の可能性のみで実コード・実挙動の裏付けがない指摘には、その旨を明記してください。
