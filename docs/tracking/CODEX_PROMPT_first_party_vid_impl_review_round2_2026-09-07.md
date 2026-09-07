# Codex Desktop 用プロンプト (実装レビュー 2回目): 第一者 Set-Cookie 化 — PR #29 の HIGH 対応確認

> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`、ブランチ `feat/first-party-visitor-cookie` (PR #29)
> 前回 (実装レビュー 1回目、head `10bbdae`): REJECT — [HIGH] Cookie 由来の被害者 vid を別テナントの
> イベントへ書き込める (same-site 兄弟サブドメインから顧客プロキシへ攻撃者 site_id を送る)。
> 本 head で **第一者束縛** を追加して対応した。**主目的はこの HIGH が本当に塞がったかの確認**。

---PROMPT---

前回 (head `10bbdae`) の T1 実装レビューで REJECT・[HIGH] 1件を出しました。今回の head で
対応済みです。設計書 v4 (`docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` §3-1 step 3、
§4 S-9、付録3) に対応内容があります。

## 対応内容 (要約)

Cookie 由来 vid の採用と Set-Cookie 発行を、以下すべてを満たす場合に限定しました
(`workers/event-ingest/src/visitor-cookie.ts` `isFirstPartyBound`、`worker.ts` の handler):

1. `Sec-Fetch-Site: same-origin` (ブラウザ付与の Fetch Metadata。兄弟サブドメイン = `same-site` を除外。
   ヘッダ欠落は fail closed)
2. `X-Forwarded-Host` 先頭値 (正準化: 小文字・ポート/末尾ドット除去・punycode) ==
   payload の site_id が `sites.url` に登録しているホスト (`lookupTenantBySiteId` の SELECT を
   `tenant_id, url` に拡張し `SITE_HOST_CACHE` に同 TTL でキャッシュ)
3. acceptedEvents の site_id が単一

未束縛時: イベントの `visitor_id` は payload のまま (上書きしない)、Set-Cookie も返さない。
結果として workers.dev 直叩き (プロキシ無し) には Set-Cookie が一切返らなくなりました。
mint 時は `is_first_visit` を true に補正 (前回の指摘)。前回の直接修正 3 点は取り込み済み。

## 依頼

### 主目的: 前回 HIGH の fix 確認

前回あなたが実 handler + モック DB で再現した経路 (攻撃者の正規 site/tenant を顧客プロキシ経由で
送り、被害者 Cookie が同乗) を **同じ方法で再実行**し、`attacker_tenant` の INSERT 行に被害者 vid が
入らないこと、Set-Cookie が返らないことを確認してください。
`test/handler-set-cookie.test.mjs` の "ATTACK" 2 件がこの再現ですが、テストに頼らず自分で叩いてください。

### 束縛判定を破る経路を探す (攻撃者視点)

- `Sec-Fetch-Site` を `same-origin` にできる経路: ページ JS からは不可 (forbidden header) だが、
  顧客プロキシ (Vercel rewrite / nginx) が **値を書き換える・付け直す**ケースはあるか。
  Service Worker、iframe (`srcdoc` / `about:blank` の継承 origin)、`<form>` POST、
  `navigator.sendBeacon` の各経路で Fetch Metadata がどう付くか
- `X-Forwarded-Host` の偽装: 顧客プロキシは元 Host で上書きするか、それともクライアントが
  送った値を「追記」するか (多段 `a, b` の先頭採用は、クライアント値が先頭に来る構成で破れないか)。
  Vercel / nginx / Cloudflare の既定挙動を根拠付きで
- 同一オリジンでも登録ホスト一致を要求する二重条件で、第三者スクリプト経由の別テナント site_id
  送信が遮断されることの確認。逆に、正当な構成 (www と apex の混在、CDN 経由でホストが変わる等)
  で束縛が **成立しなくなる** 誤検知ケースがあれば列挙 (可用性側の指摘も歓迎)
- `sites.url` の一意性が崩れた場合 (同一ホストを 2 テナントが登録) の挙動。現状 operator 発行のみ
  だが、コード上で防いでいないことのリスク評価

### その他

- `getRegisteredSiteHost` の JWT 経路 (Bearer で tenant を解決した場合、site lookup が走らない) で
  host cache が冷えている時の追加 lookup が正しく動くか
- 束縛判定に伴う追加 I/O (SELECT に `url` を足しただけで追加クエリは無いはず) の確認
- テストが捕捉していない経路があれば指摘

## 2段構え (前回同様)

- 明白な問題は直接修正して一覧化。設計判断への異議は findings (severity 付き) で報告し、
  あなたの一存でコードを変えない

## 出力形式

1. 前回 HIGH の fix 確認 (CONFIRMED FIXED / STILL BROKEN / PARTIALLY + 再現手順と結果)
2. 束縛判定を破る経路 (あれば severity 付き。無ければ「見つからず」と観点ごとに明記)
3. 誤検知 (可用性) の指摘
4. 直接修正した箇所
5. 総合判定: APPROVE / APPROVE-WITH-CHANGES / REJECT + 判定理由 (3行以内)

理論上の可能性のみで実コード・実挙動の裏付けがない指摘には、その旨を明記してください。
