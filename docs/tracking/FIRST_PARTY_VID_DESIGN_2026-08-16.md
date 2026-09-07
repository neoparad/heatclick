# 設計書 v4: visitor_id の第一者 Set-Cookie 化 (ITP 7日制限対応)

> 2026-08-16 / 起票: link-th.co.jp 導入先からの第4報 (2026-08-16)
> 分類: **T1 (Critical)** — Cookie / CORS / tenant isolation に触れるため Claude + Codex dual review 必須
> ステータス: **v4 — 実装済み (PR #29)、Codex T1 実装レビュー 2回目 (REJECT・HIGH 1件) を反映。3回目待ち**。
> v1→v2: 2並列敵対的レビュー (red-team / browser挙動fact-check、計15 findings) を反映
> (§2-B パターンB不採用、§3-2 credentialed CORS 撤回、§6 検証項目の書換)。
> v2→v3: **Codex dual review (1回目、REJECT・findings 7件) を反映**
> (§3-1 payload 値の検証追加・Set-Cookie 発行条件の確定、§1 D-3 の範囲訂正、
> §4 S-4 の「XSS必須」誤りを訂正、§3-4 Sentry 記載の誤りを訂正、HTTPS 前提条件を追加)。
> v3→v4: **Codex 実装レビュー (2回目、REJECT・HIGH 1件) を反映 — 第一者束縛の追加**
> (§3-1 step 3: Cookie 由来 vid の採用と Set-Cookie 発行を「Sec-Fetch-Site: same-origin ×
> 転送元ホスト == サイト登録ホスト × 単一 site_id」に束縛。未束縛時は payload 値のまま・
> Set-Cookie なし。§2 プロキシ要件、§4 S-9、§6 検証、§7 残存リスクを追加)。
> 詳細は末尾の変更理由表を参照

---

## 0. 課題 (実測で確認済みの事実)

`__ugk_vid` (訪問者識別子) はクライアント JS が発行している:

- 発行箇所: `public/v2/tracking.js:193-196` — `document.cookie` 経由、365日指定、`SameSite=Lax; Secure`、**Domain 属性なし (host-only)**
- ingest Worker (`workers/event-ingest/src/worker.ts`) は Set-Cookie を一切返さない (全文 grep 確認済み)

Safari ITP は **`document.cookie` で作られた Cookie と script-writable storage (localStorage) を
「サイトに操作 (click/tap/キー入力) なしで Safari を使った日数が7日」で失効させる**
(毎日 Safari を使う訪問者では暦7日に等しい。閲覧のみの再訪ではタイマーはリセットされない)。

さらに、**広告リンク経由 (gclid/fbclid 等のリンクデコレーション付き) で Safari に着地した場合、
JS 発行 Cookie は7日ではなく24時間で失効する** (WebKit のトラッカー分類ドメイン対策)。
広告アトリビューションでは影響がさらに大きい。

**影響**: Safari / iOS (日本のモバイルの過半) の訪問者はセッションをまたぐと別人としてカウントされ、
BtoB の数週間〜数ヶ月の検討導線のアトリビューションが成立しない。
セッション内で完結する指標 (ヒートマップ、スクロール計測) は影響なし。全導入先で同じ状態。

## 1. 解決原理

ITP の7日制限が見るのは **Cookie の作られ方** (document.cookie か、HTTP レスポンスの
Set-Cookie ヘッダか) であり、HttpOnly 属性ではない。WebKit は Cookie ごとに
「set in JavaScript」ビットを持ち、**同名 Cookie を HTTP Set-Cookie で再発行すると
RFC 6265 の同名置換により新 Cookie にはこのフラグが付かない** = サーバー発行に昇格する
(fact-check で WebKit commit レベルまで確認済み。業界標準の cookie refresh パターンと同一機構)。

→ **第一者コンテキストのエンドポイントから同名・同スコープで Set-Cookie を返せば、
既存訪問者の vid 値を変えずに ITP 免除へ昇格でき、最長400日 (rfc6265bis 上限) 保持できる。**

### 設計判断 D-1: HttpOnly は付けない

第4報の原案は HttpOnly を提案していたが、**採用しない**。理由:

1. ITP 免除に HttpOnly は不要 (Set-Cookie 経由であることだけが条件)
2. `public/scenario-runtime.js:163` が `document.cookie` から `__ugk_vid` を読んで
   シナリオ配信の visitor 判定に使っており、HttpOnly にすると **M-Agent バナーの
   ターゲティングが機能停止する**

採用する属性: `Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400日)。
**Domain 属性は付けない (host-only)** — §2-B の不採用理由と表裏一体で、これが
既存 JS Cookie と同一スコープ = 確実な同名置換を成立させる条件でもある。

### 設計判断 D-2: 同名 Cookie の昇格 (移行の要 — fact-check 確認済み)

JS 発行済みの `__ugk_vid` と**同名かつ同スコープ (host-only / Path=/)** で Set-Cookie を
返すと、同一 Cookie がサーバー発行に置換され、その時点から ITP 免除対象になる。
既存訪問者の vid 値は変わらないため、**識別子の連続性は保たれる**。

⚠ この置換が成立するのは **Cookie のキー (name, domain, path) が完全一致する場合のみ**。
Domain 属性付きで発行すると host-only の既存 Cookie とは**別 Cookie として共存**し、
クライアントの読み手 (first-match) は ITP 制限付きの旧 Cookie を読み続ける
(v1 パターンBが不採用になった理由の1つ。red-team 指摘)。

### 設計判断 D-3: SameSite=Lax が防ぐもの・防がないもの (Codex 指摘 [HIGH] 反映で範囲を訂正)

メイン送信経路 (text/plain Blob の sendBeacon) は CORS の preflight を経ない
「simple request」であり、**CORS は ingestion を守らない** (レスポンスの読み取りを
ブロックするだけで、fire-and-forget のビーコンには無関係)。

**SameSite=Lax が防ぐもの**: cross-site ページ (evil.com) が被害者のブラウザに
「被害者の `__ugk_vid` Cookie を付けて」track 経路へ送らせること。Lax は cross-site
の subresource request (fetch/beacon/img 等) に Cookie を付与しないため、
**Cookie を伴う偽造 (victim の識別子を騙る攻撃)** はこれで防がれる。
**この属性を None に緩めることを禁止事項として明記する** (将来サブドメイン間の
利便性のために None にしたくなった時、この防御が消える)。

**SameSite=Lax が防がないもの (Codex [HIGH] 指摘、v2 で誤って混同していた点)**:
`/api/track` は Origin 検証も認証も無い公開 POST エンドポイントであり
(`worker.ts:801-845` 確認済み)、**Cookie の有無に関係なく**任意の送信元
(ブラウザ以外も含む) が任意の `site_id`/`event_type`/`visitor_id` を送りつけられる。
これは**本設計が導入する前から存在する、ingest パイプライン自体の既知の性質**であり、
Cookie の SameSite 属性では原理的に防げない。本設計はこの既存リスクを悪化させない
(§3-1 の payload 検証追加でむしろ改善する)が、解消もしない。
**Origin 検証・署名付き ingest token・レート制限によるペイロード偽造対策は本設計の
スコープ外とし、別チケットで扱う** (§7 に追記)。

## 2. 第一者化の方式: パスプロキシ一本 (v1 から変更)

### 採用: パスプロキシ (旧パターンA)

顧客サイト自身のパスを ingest Worker へリバースプロキシする。

```
ブラウザ → https://customer.com/ugoki/track → (顧客側プロキシ) → Worker
```

- 顧客側設定例 (Vercel): `vercel.json` の rewrites に
  `{ "source": "/ugoki/track", "destination": "https://ugokimap-event-ingest.linkth.workers.dev/api/track" }`
  (nginx / CloudFront / Cloudflare 等でも同等の rewrite で可)
- タグ側: `window.CLICKINSIGHT_API_URL = '/ugoki/track'` を設置スニペットに追加
  (**tracking.js:124 に既存の上書きフックがあり、コア改修不要**)
- Cookie: Worker は **Domain 属性なし (host-only)** で Set-Cookie
  → ブラウザはリクエスト先オリジン (= customer.com) に対して既存 JS Cookie を同名置換
- **完全に同一オリジンのため、CORS・CNAME/IP クローキング判定・DNS 要件がすべて消える。**
  fetch のデフォルト credentials (same-origin) で Cookie が送られるため、
  クライアント側の credentials 対応も不要
- **プロキシの要件 (v4、第一者束縛のため必須)**: プロキシは以下 2 ヘッダを Worker へ転送すること。
  転送されない場合、Worker は束縛不成立として **Set-Cookie を返さず、従来挙動 (JS Cookie の
  ままで7日制限) に安全側で倒れる** (壊れはしないが第一者化の効果が出ない)。
  - `Sec-Fetch-Site` (ブラウザ付与の Fetch Metadata。ページ JS からは偽装不可)
  - `X-Forwarded-Host` (元リクエストの Host。多段なら先頭値を採用)
  Vercel の platform rewrite がこれらを既定で転送するかは **§5 手順0 のスパイクで確認**する
  (Vercel は `x-forwarded-host` を付与する挙動が知られているが、外部宛 rewrite での
  `Sec-Fetch-Site` 転送は要実測)。nginx は `proxy_pass` が既定で転送する
  (`proxy_set_header X-Forwarded-Host $host;` を明示推奨)。

⚠ **Vercel 顧客への注意 (fact-check 指摘)**: `vercel.json` (platform rewrite) を使うこと。
`next.config.js` の rewrites には **Set-Cookie がドロップされる既知報告** (next.js #29488,
#86798) があり、顧客ごとに実機確認が必要。Cookie リクエストヘッダの転送は確認済み。
**Set-Cookie の返送は Vercel 公式ドキュメントに明記がないため、実装着手前に §5 手順0 の
スパイクで実測確認する** (不成立ならこの設計全体が成立しないため、最初に検証する)。

⚠ **HTTPS 必須 (Codex [MEDIUM] 指摘)**: Worker が発行する Set-Cookie は常に `Secure`
属性付きであり、HTTP サイトではブラウザが Cookie 自体を破棄する
(`public/v2/tracking.js:183` の JS 発行 Cookie は HTTP 時 Secure を付けないため、
これまで気づかれていなかった非対称性)。**第一者化はサイトが HTTPS 配信されていることを
前提条件とする**。導入手順書・§5 のロールアウト前提条件に明記する。

### 不採用: サブドメイン + Cloudflare Custom Domain (旧パターンB) — 理由の記録

v1 で「正式サポート」としていたが、レビューで前提が崩れたため**不採用**とする。

1. **【致命的・fact-check】ITP の IP アドレスクローキング防御に捕まる**:
   ITP は CNAME クローキング対策に加え、サブリソースホストの**解決 IP をトップフレームと
   比較する防御**を通常ブラウジングで実施している (webkit.org/tracking-prevention +
   WebKit PR #5347)。Workers Custom Domain は A/AAAA で Cloudflare edge IP に解決するため、
   **顧客のメインサイト自体が同一 Cloudflare ゾーンで proxy (orange-cloud) されていない限り
   Set-Cookie は7日にキャップされる**。「DNS が Cloudflare 配下」では不十分で、
   当社顧客の主流 (Vercel 等でホスト) はほぼ全員が不適格。
2. **【致命的・red-team】D-2 の同名置換が成立しない**: Domain 属性付き Cookie は
   host-only の既存 JS Cookie と別 Cookie として共存し、クライアント読み手 (first-match)
   は ITP 制限付きの旧 Cookie を読み続ける。ITP が旧 Cookie を消した瞬間に vid が
   不連続になる = 機能目的そのものが達成されない。
3. **【HIGH・red-team】Domain=登録ドメインの共有スコープ**: 代理店の顧客別サブドメイン等、
   同一登録ドメインに複数テナントが同居する構成で vid が全テナント共有になる
   (tenant isolation 違反、§3.8.1)。兄弟サブドメインからの cookie tossing で
   識別子固定攻撃も可能。Public Suffix List 検証など追加の防御層も必要になる。

メインサイトが orange-cloud 済みの顧客が現れた場合に限り、上記3点への対策込みで
再設計する (このドキュメントの本文には含めない)。

### rewrite が設定できない顧客

現状維持 (7日制限を許容) とし、制約として案内する。第一者化は任意適用。

## 3. 変更対象と変更内容

### 3-1. Worker (`workers/event-ingest/src/worker.ts`) — 本体

POST `/api/track` ハンドラに追加:

1. **Cookie parse**: リクエストの `Cookie` ヘッダから `__ugk_vid` を抽出。
   **同名 Cookie が複数ある場合は Cookie 由来値を採用しない** (payload へフォールバック。
   red-team 指摘: 重複時の優先順は環境依存で、サーバーとクライアントの識別が乖離しうる。
   Domain 属性付きの兄弟 Cookie が cookie tossing で同名を送ってきた場合もこの分岐で吸収される)
2. **形式検証 — Cookie 値・payload 値の両方に同一基準を適用 (Codex [HIGH] 指摘、v2 の欠陥修正)**:
   `/^[A-Za-z0-9_-]{8,64}$/` を **Cookie 由来値・payload 内 `visitor_id` の両方**に適用する。
   v2 は Cookie 値だけを検証し、公開 POST エンドポイント (`worker.ts:801-845`、Origin 検証も
   認証もない) から誰でも送れる payload 値を無検証で正準値に採用していた —
   これは Cookie 属性注入 (payload 値に `;` や制御文字を仕込んで Set-Cookie を汚染) や
   任意 ID の固定化に直結する欠陥だった。両方を同一 regex で検証し、不合格ならその
   ソースは「値なし」として扱う
3. **第一者束縛の判定 (v4、Codex 実装レビュー [HIGH] 対応) — 以下すべてを満たす場合のみ
   Cookie 由来 vid を採用し Set-Cookie を返す**:
   1. `Sec-Fetch-Site: same-origin` — 送信元ページとリクエスト先 (顧客プロキシ) が同一オリジン。
      兄弟サブドメイン (`same-site`) や `cross-site`、ヘッダ欠落は不成立 (fail closed)
   2. `X-Forwarded-Host` の先頭値 (正準化: 小文字・ポート/末尾ドット除去・IDN punycode)
      == payload の site_id が `sites.url` に登録しているホスト (同じ正準化)
   3. acceptedEvents の site_id が単一
   **背景 (Codex が実 handler で再現)**: 束縛が無いと、顧客の HTTPS 兄弟サブドメインから
   顧客プロキシ (`customer.com/ugoki/track`) へ「攻撃者自身の正規 site_id/tenant_id」を送るだけで、
   same-site のため Lax でも被害者の `__ugk_vid` が同乗し、Worker が被害者 vid を
   攻撃者テナントの行に書いていた (テナント間の識別子流出)。resolveTenant は payload の
   site/tenant 対応しか見ておらず「Cookie を運んできたホスト」を検証していなかった。
   同一オリジンの任意スクリプトは document.cookie を直接読めるため、同一オリジンが
   原理的な信頼境界であり、本判定はその境界に一致させたもの。
   **束縛不成立時**: イベントの `visitor_id` は payload の値のまま (従来挙動、上書きしない)、
   Set-Cookie も返さない (返すと被害者 Cookie を攻撃者値で上書き = 固定化できてしまう)。
   登録ホストの取得: `lookupTenantBySiteId` の SELECT を `tenant_id, url` に拡張し、
   同 TTL でホストをキャッシュ (`SITE_HOST_CACHE`)。url 欠落/不正は「不明」= 束縛不可
4. **vid 正準化 (束縛時のみ。優先順、検証パス済みの値のみが対象)**:
   1. Cookie の `__ugk_vid` (単一・形式検証パス時)
   2. payload 内の `visitor_id` (形式検証パス時 — 既存 JS 発行値の移行時連続性担保)
   3. どちらも無い/両方とも検証不合格なら新規 UUID v4 を mint。
      この場合 `is_first_visit` を true に補正する (サーバー新規発行 = 初見。client 判定の
      false が残ると新規 id が再訪扱いになる — Codex 指摘)
5. **イベントへの反映 (束縛時のみ)**: acceptedEvents (tenant 解決済み・site_id/event_type 妥当) の
   各イベントの `visitor_id` を正準値で上書き
6. **Set-Cookie 発行 — 束縛成立かつ accepted イベントが1件以上ある応答のみ**:
   `__ugk_vid=<vid>; Max-Age=34560000; Path=/; Secure; SameSite=Lax` (Domain なし) を付与する。
   400/401/413 や「全イベント drop で 0 件受理」の 200 応答では発行しない
   (無条件発行だと、失敗確定のリクエストを送りつけるだけで Cookie 設定を誘発できてしまうため)。
   あわせて **`Cache-Control: no-store`** を必須付与 (fact-check 指摘: Set-Cookie 付き応答が
   中間層でキャッシュされると訪問者間で vid が混線するため)。
   **結果として workers.dev 直叩き (プロキシ無し = X-Forwarded-Host 無し) には Set-Cookie が
   一切返らない** — v3 S-8 の「第三者コンテキストへの Set-Cookie は無害か」という論点自体が消える
7. **Cookie ヘッダの生値を Worker コード内で一切ログしない** (§4 S-3)

### 3-2. CORS — v1 から方針変更: credentialed 化を撤回

パターンB不採用により **credentialed CORS (`Access-Control-Allow-Credentials`) は不要になった**。
第一者経路は同一オリジンで CORS 自体が発生せず、既存の workers.dev 直叩き顧客は
従来通り非 credential で動く。

やること:
- `ALLOWED_ORIGINS='*'` (現行 wrangler.toml:17) を**意図された構成として文書化**する。
  公開 ingest endpoint であり、実際の受入制御は site_id→tenant registry 照合 (既存) と
  SameSite=Lax (D-3) が担う
- `corsHeaders()` (worker.ts:772-781) の**誤解を招く echo 分岐を削除**:
  現状 `allowed !== '*'` のとき allowlist を検証せず任意 Origin をエコーする実装に
  なっており、「制限している風で制限していない」。`'*'` 固定に単純化する
- **不変条件をコードコメントに記録**: 「この endpoint に `Access-Control-Allow-Credentials:
  true` を追加してはならない。追加が必要になったら Origin の完全一致 allowlist
  (endsWith/includes 禁止、Origin: null 拒否) を先に実装すること」

⚠ v1 の「allowlist 完全一致・不一致時 ACAO なし」案は fact-check で **既存顧客を壊す**
ことが判明したため撤回 (未登録オリジンの application/json 経路 — debug fetch と
sendBeacon 失敗時フォールバック — の preflight が失敗しイベントがサイレント消失する)。

### 3-3. クライアント (`public/v2/tracking.js`) — 変更ほぼゼロ

- `_getVisitorId()` は**そのまま維持** (初回ブートストラップ + フォールバック。
  サーバー発行 Cookie が同名置換された後はそれを読むだけになる)
- 同一オリジン化により credentials 対応も不要 (fetch デフォルトの same-origin で送られる)
- 変更は**設置スニペットのみ**: 第一者化する顧客向けに `CLICKINSIGHT_API_URL = '/ugoki/track'`
  の記載を install-settings-pane / operator-provision-site.mjs に追加

### 3-4. 観測性・ログ基盤 (red-team S-3 拡張)

パスプロキシ経由では顧客サイトの **Cookie ヘッダ全体** (顧客自身のセッショントークン等を
含む) が Worker に転送される。Worker コードで読まない・ログしないだけでは不十分。

⚠ **v2 の記載を訂正 (Codex [MEDIUM] 指摘)**: v2 は「Sentry の自動計装が request header を
capture しうる」としていたが、`workers/event-ingest/` に Sentry SDK の import/初期化は
**存在しない** (grep で確認。「Sentry breadcrumb」と記載していた説明コメントも
PR #29 レビューで実態に合わせて構造化ログの説明へ訂正済み。
`package.json` の `@sentry/nextjs` は別デプロイ物である
Next.js アプリ側の依存であり、この Cloudflare Worker には無関係)。
Sentry 関連の対応は不要。ただし `console.error` 経由のログ (`worker.ts:583-610` の
audit/drop logging 等) が **Cookie ヘッダの値を引数に含めていない**ことは実装時に
コードレビューで確認する (現状のコードは含めていないことを確認済み。今後の変更でも
この不変条件を維持する)。

**Cloudflare 側ログの確認 (実装チケットへ落とす粒度に具体化、Codex [MEDIUM] 指摘反映)**:
- 確認コマンド: `wrangler tail ugokimap-event-ingest --format=json` を実行しながら
  テストリクエストを送り、出力に `Cookie` ヘッダの値が含まれないことを確認する。
  加えて Cloudflare dashboard の当該 Worker → Logs → Logpush 設定を確認し、
  Logpush が有効な場合は destination 側での header 保持ポリシーも確認する
- 合格条件: tail 出力・Logpush 設定のいずれにも Cookie ヘッダの値が現れないこと
- 失敗時の停止条件: Cookie ヘッダが記録される設定になっていた場合、§5 手順4 を
  ブロックし、Logpush 側で header 除外設定を入れるか、Logpush 自体を無効化してから
  再確認する (Owner 確認ゲート)
- **顧客への開示**: 導入手順書に「パスプロキシ方式では貴サイトの first-party Cookie が
  当社インフラを経由します」を明記し、顧客側で proxy 時に Cookie を `__ugk_vid` のみへ
  絞れる環境 (nginx 等) ではその設定例を提供する (Vercel rewrite では不可)

### 3-5. ドキュメント

- `/install` の CSP 案内を更新: 第一者化した顧客は connect-src が自オリジンに変わる
- 導入手順書に方式判定フロー (rewrite 可否) と Vercel の vercel.json / next.config.js
  注意書きを追加

## 4. セキュリティ考慮 (T1 レビュー観点)

| # | 論点 | 対応 |
|---|---|---|
| S-1 | CORS | credentialed 化は撤回 (§3-2)。ACAO:'*' + ACAC 禁止の不変条件をコード化 |
| S-2 | 入力検証 (Codex [HIGH] 指摘反映: payload 側も対象に) | Cookie 値・payload 値の両方に形式 regex + 長さ上限を適用 + Cookie 重複拒否。不合格は無視 (エラーにしない、§3-1) |
| S-3 | 顧客 Cookie の Worker 転送 | §3-4 の2点 (CF ログ確認・確認コマンド/合格条件/停止条件付き / 顧客開示)。Sentry は Worker に SDK が存在しないため対応不要と確認済み (Codex [MEDIUM] 指摘で訂正) |
| S-4 | vid 固定攻撃の残存リスク (Codex [HIGH] 指摘で訂正: 「XSS 必須」は誤り) | host-only Cookie は Path をセキュリティ境界として信頼できず (RFC 6265)、**XSS が無くても**同一ホスト上の別ポート/別サービス、または `Domain=customer.com` を持つ兄弟サブドメインからの cookie tossing により第三者が値を送り込める経路が残る。ただし §3-1 の payload 検証追加 (Codex 指摘反映) と同名 Cookie 重複時のフォールバックにより、**「攻撃者値が400日 Set-Cookie として永続化する」経路は正規の accepted event 応答を介するものに限定**され、無検証のまま持続化することはない。残存リスクとして受容し、将来の hardening として HMAC 署名付き vid (別 Cookie `__ugk_vid_h` に署名を保持し、検証失敗時は再 mint) を §7 に記録。攻撃面を「XSS 前提」と限定していた v2 の記載は誤りだったため撤回 |
| S-5 | tenant isolation | vid は認証ではなく識別子。tenant 解決は既存の site_id→tenant lookup のまま不変。host-only 化により v1 パターンBの cross-tenant 共有リスクは消滅 |
| S-6 | プライバシー | vid はランダム UUID で PII なし。400日識別子になるため顧客向け規約テンプレの Cookie 記載を更新 (別チケット)。既存 opt-out (`clickinsight_optout`) は tracking.js が送信自体を止めるため引き続き機能 |
| S-7 | SameSite=Lax の不変条件 | D-3 参照。None への変更禁止を明文化 + §6 に検証を追加 |
| S-8 | 既存デプロイとの互換 (v4 で論点解消) | v4 の第一者束縛により、プロキシを経由しない workers.dev 直叩き (X-Forwarded-Host 無し) には **Set-Cookie が一切返らず、イベントの visitor_id も上書きしない** = 既存顧客の挙動は完全に不変。v3 で懸念した「第三者コンテキストへの Set-Cookie をブラウザがどう扱うか」は発生しない。CORS も触らない (§3-2) |
| S-9 | **Cookie 由来 vid のテナント間流出 (Codex 実装レビュー [HIGH]、v4 で対応)** | Lax は same-site (兄弟サブドメイン) からの送信を防がず、resolveTenant は payload の site/tenant 対応しか見ないため、攻撃者が「自分の正規 site_id」を顧客プロキシへ送ると被害者 vid が攻撃者テナントに書かれた (Codex が実 handler で再現)。対策 = §3-1 step 3 の束縛 (Sec-Fetch-Site: same-origin × 転送元ホスト == 登録ホスト × 単一 site_id)。**運用上の前提**: `sites.url` のホストはテナント間で一意であること。現在は operator 発行のみで担保。セルフサーブ化時はドメイン所有確認 (DNS TXT 等) を必須にする (§7) |

## 5. ロールアウト計画

**前提条件 (Codex [MEDIUM] 指摘反映)**: 第一者化する顧客サイトは HTTPS 配信必須
(§2 参照、Secure 属性の Cookie は HTTP では保存されない)。

0. **【最初にやる】Vercel rewrite スパイク (30分)**: linkth-web に使い捨て rewrite を1本
   追加し、Set-Cookie を返すテストエンドポイントに向けて (a) Cookie ヘッダが宛先に届く
   (b) Set-Cookie がブラウザに保存される、を実測。**ここが不成立なら設計全体を再検討**
   (fact-check 指摘: Vercel 公式ドキュメントに Set-Cookie passthrough の明記がない)
1. **Worker 改修デプロイ** (§3-1 + §3-2 の echo 分岐削除)。既存顧客は workers.dev
   直叩きのままで挙動不変 (§4 S-8)
2. **link-th.co.jp で dogfood**: vercel.json rewrite + `CLICKINSIGHT_API_URL` 設置
3. **検証** (§6) をパスしたら、導入手順書を更新し他顧客へ展開 (顧客側作業が必要なため
   任意適用)
4. bihadashop.jp 等の既存 dogfood サイトへ順次適用

## 6. 検証項目 (v1 から観測可能な形に書換 — fact-check 指摘反映)

- [ ] **手順0スパイク**: Vercel platform rewrite が Cookie 転送 + Set-Cookie 返送すること (実測)
- [ ] Safari 実機で **ITP Debug Mode** (Develop メニュー → Intelligent Tracking Prevention
  Debug Mode) を有効化し、Console の ITP ログで `__ugk_vid` が削除対象に分類されないこと
  (v1 の「Set-Cookie 由来として保存されること」は Web Inspector で観測不能なため書換)
- [ ] 長期試験: テスト端末1台で1回訪問 → サイト操作なしで7日以上 Safari を日常使用 →
  Cookie 残存を確認 (機能検証の最終確認、非ブロッキングで並走)
- [ ] 既存訪問者 (JS 発行 vid 保持) の vid が**値を変えずに**サーバー発行へ昇格すること
  (dogfood 前後の ClickHouse `events.visitor_id` 連続性)
- [ ] scenario-runtime.js が引き続き `__ugk_vid` を読めること (バナー配信の回帰確認)
- [ ] **cross-site 偽造テスト**: 別サイトから text/plain ビーコンを顧客 track 経路へ送り、
  `__ugk_vid` Cookie が**付かない**こと (SameSite=Lax が機能している確認。
  v1 の CORS 拒否テストは実効性がないため置換 — D-3 参照)
- [ ] 未登録オリジンからの非 credential リクエスト (preflight 含む) が引き続き成功すること
  (既存顧客の回帰確認)
- [ ] opt-out 状態で Worker が呼ばれないこと (既存挙動の回帰確認)
- [ ] Worker 単体テスト: **Cookie 値・payload 値それぞれの正常系/不正形式 (regex 不合格)/
  欠落**の組み合わせ行列で正準化と Set-Cookie 値を検証 (Codex [HIGH] 指摘反映: payload
  側も検証対象に含める行列にする)
- [ ] Worker 単体テスト: 不正な payload 値 (`;` や制御文字を含む文字列、65文字超) を
  送った場合に regex で弾かれ、mint された新規 UUID が Set-Cookie に使われること
  (Cookie 属性注入・固定化の回帰防止)
- [ ] Worker 単体テスト: `acceptedEvents.length === 0` になる各ケース (400/401/413、
  全件 tenant 解決失敗による 200+0件) で **Set-Cookie ヘッダが付与されない**こと
  (Codex [MEDIUM] 指摘反映)
- [ ] ~~ブラウザ別確認 (S-8)~~ → v4 で不要化 (workers.dev 直叩きには Set-Cookie が返らない)。
  代わりに: workers.dev 直叩きの応答に Set-Cookie が無いことを handler テストで固定 (実装済み)
- [ ] **束縛テスト (v4、Codex [HIGH])** — handler 単体テスト (実装済み・pass):
  兄弟サブドメイン (`Sec-Fetch-Site: same-site`) からの攻撃者 site_id 送信で被害者 vid が
  攻撃者テナント行に入らない / 同一オリジンでも登録ホスト不一致なら不採用 / X-Forwarded-Host
  欠落・偽装・Sec-Fetch-Site 欠落は不採用 / 単一 site_id 以外は不採用 / ホスト正準化
  (大文字・ポート・末尾ドット・多段リスト)
- [ ] **手順0 スパイクに追加**: Vercel の platform rewrite が `Sec-Fetch-Site` と
  `X-Forwarded-Host` を Worker まで転送すること (転送されなければ束縛が成立せず、第一者化の
  効果が出ない。その場合は手順書で明示的なヘッダ転送設定が可能なプロキシに限定する)
- [ ] dogfood (link-th.co.jp) で実ブラウザから送信し、Worker 側で束縛成立 → Set-Cookie 付与を確認
  (`wrangler tail` で応答ヘッダを観測。Cookie ヘッダの値は出力しないこと)

## 7. スコープ外 (明示)

- **`/api/track` のペイロード偽造対策 (Codex [HIGH] 指摘、D-3 参照)**: Origin 検証・
  署名付き ingest token・レート制限のいずれも本設計には含まない。現状エンドポイントは
  認証も Origin 検証も無い公開 POST であり、これは本設計以前から存在する ingest
  パイプライン自体の性質。本設計は payload 由来 visitor_id の検証を追加する (§3-1) が、
  それ以外のペイロード偽造対策は別チケットで扱う
- **同一オリジン上のスクリプトによる vid 取得 (v4 で残存として明記)**: HttpOnly を付けない
  設計 (D-1) のため、顧客ページ上の任意の同一オリジンスクリプト (顧客が導入した第三者タグを含む)
  は `document.cookie` から `__ugk_vid` を読める。第一者束縛はこの境界 (同一オリジン) に
  一致させたものであり、この内側は本設計では守れない (守るには HttpOnly + scenario-runtime の
  サーバー側 vid 供給への再設計が必要。将来課題)
- **`sites.url` ホストのテナント間一意性 / ドメイン所有確認 (S-9)**: 第一者束縛は「登録ホストが
  そのテナントのものである」ことを前提にする。operator 発行の現状では運用で担保。
  セルフサーブ化の際は DNS TXT 等によるドメイン所有確認と、同一ホストの重複登録拒否を必須にする
- `ci_user_id` (730日指定の第2識別子): 同じ ITP 制限を受けるが用途が限定的なため触らない
- GA4 `_ga` Cookie: JS 発行のため救えない (サーバーサイド GTM の領域、linkth-web 側の別件)
- HMAC 署名付き vid (S-4 の hardening): 第一者化が安定したら別チケットで検討
- audit beacon (`_auditBeacon`, tracking.js:364-380) が application/json Blob のため cross-origin
  で preflight 必須になっており、顧客サイトからの audit telemetry が現時点でも届いていない
  可能性 (fact-check が発見した既存の別問題)。text/plain 化 or SaaS 側 preflight 対応を
  別チケット化
- セルフサーブでの設定管理 UI: 顧客増加時に別チケット
- v1 パターンB (サブドメイン方式) の再設計: orange-cloud 済み顧客が現れた場合のみ

## 8. 実装順序とレビューゲート

| # | 作業 | ゲート | 状態 |
|---|---|---|---|
| 1 | 設計書 v2 の Codex dual review (T1) 1回目 | Owner が desktop で実施 | **完了 (REJECT・findings 7件 → v3 で反映)** |
| 2 | 設計書 v3 の Codex dual review (T1) 2回目 | **Owner が desktop で実施** | 未実施 (Owner 判断で実装を先行。実装差分込みで実施可) |
| 3 | §5 手順0 Vercel スパイク | 結果を本書に追記。不成立なら設計再検討 | 未着手 (linkth-web 側作業。Worker 実装後は実 Worker を宛先にして実施可) |
| 4 | §3-1 Worker Set-Cookie + vid 正準化 (payload 検証含む) + 第一者束縛 (v4) + §3-2 echo 分岐削除 (単体テスト付き) | Claude 実装 + Codex review | **実装完了 (PR #29、未デプロイ)**: `visitor-cookie.ts` (純関数) + `worker.ts` 組込。Codex 実装レビュー 1回目 = REJECT (HIGH: テナント間流出) → v4 で束縛を追加。テスト: 純関数 21 + handler 17 (攻撃再現→遮断・未束縛時の不変・Set-Cookie 発行条件・属性注入拒否・重複 Cookie・Cookie ヘッダ非漏洩・CORS 不変条件) を実 TS を直接 import して検証、全 pass。**Codex 実装レビュー 2回目 待ち** |
| 5 | §3-4 CF ログ確認 (確認コマンド/合格条件/停止条件は本書記載済み) | **Owner 確認項目あり** | 未着手 |
| 6 | Worker デプロイ | **Owner 確認ゲート** (wrangler deploy は Owner SSH 経由) | 未着手 |
| 7 | link-th.co.jp 側設定 (rewrite + スニペット) | linkth-web 側セッションと連携 | 未着手 |
| 8 | §6 検証 → 手順書更新 | 検証結果を本書に追記 | 未着手 |

---

## 付録: v1 → v2 の変更理由 (レビュー findings 対応表)

| Finding (severity) | 対応 |
|---|---|
| fact-check HIGH: パターンBは ITP の IP クローキング防御に捕まる | パターンB不採用 (§2-B) |
| red-team HIGH: Domain Cookie は host-only と共存し D-2 が不成立 | 同上 + D-2 に条件を明記 |
| red-team HIGH: Domain Cookie の cross-tenant 共有 / cookie tossing | パターンB不採用により消滅 (§2-B に記録) |
| fact-check HIGH: 厳格 allowlist の先行デプロイが既存顧客を壊す | credentialed CORS 自体を撤回 (§3-2) |
| red-team HIGH: 攻撃者値の400日 bless (vid 固定) | A限定で攻撃面を再評価し受容 + HMAC を将来 hardening 化 (S-4) |
| red-team MED: SameSite=Lax が実質の防御でCORSテストは誤誘導 | D-3 新設 + §6 テスト置換 |
| red-team MED: Sentry/CF ログが顧客 Cookie を捕捉しうる | §3-4 新設 |
| fact-check MED: Vercel Set-Cookie passthrough 未確認 | §5 手順0 スパイクを最優先化 |
| fact-check MED: 検証基準が観測不能 | §6 を ITP Debug Mode / 長期試験へ書換 |
| fact-check MED: debug fetch credentials の条件未定義 | 同一オリジン化により不要 (§3-3) |
| red-team LOW: fallback _fetch の credentials 欠落 | 同上 |
| fact-check LOW: gclid/fbclid の24hキャップ | §0 に追記 (設計の必要性を補強) |
| fact-check LOW: Cache-Control 未規定 | §3-1.5 に no-store を必須化 |
| fact-check LOW: audit beacon の preflight 問題 (既存) | §7 に別チケットとして記録 |
| red-team LOW: 動的 allowlist の不変条件 | §3-2 の不変条件コメントに集約 |

## 付録2: v2 → v3 の変更理由 (Codex T1 レビュー 1回目、REJECT、findings 7件)

| Finding (severity) | 対応 |
|---|---|
| [HIGH] payload の visitor_id が無検証で Set-Cookie に混入 | §3-1: Cookie値・payload値の両方に同一regex検証を適用するよう修正 (最重要の修正) |
| [HIGH] S-4「host-only は XSS が無ければ安全」は不成立 (同一ホスト別ポート・cookie tossing) | §4 S-4 を書き換え、XSS 限定の誤りを撤回。payload検証追加により「無検証のまま400日persist」経路は塞いだ上で、残存リスクを正直に記載 |
| [HIGH] SameSite=Lax を ingestion 全体の偽造防止と混同 | §1 D-3 を書き換え、「Cookie付き偽造を防ぐ」と「payload偽造(既存・別問題)」を明確に分離。後者を§7でスコープ外化 |
| [MEDIUM] workers.dev 直叩き時の「無害」断定 (S-8) が未検証 | ブラウザ別実機確認を§6に追加、断定を緩和 |
| [MEDIUM] HTTP サイトでは Secure Cookie が発行できない | §2・§5 に HTTPS 必須の前提条件を明記 |
| [MEDIUM] Set-Cookie 発行対象の応答分岐が未定義 | §3-1: acceptedEvents.length>0 の応答のみに限定と確定 |
| [MEDIUM] Sentry 記載が実コードと不一致 (Worker に Sentry SDK 無し) | §3-4 を訂正: Sentry 対応は不要と明記。Cloudflare ログ確認を確認コマンド・合格条件・停止条件付きで具体化 |
| (直接修正) §3-4 / §7 の行番号引用ズレ | Codex が直接修正済み (`worker.ts:576-603`、`tracking.js:364-380`) |

## 付録3: v3 → v4 の変更理由 (Codex 実装レビュー 1回目 = PR #29 head 10bbdae、REJECT)

| Finding (severity) | 対応 |
|---|---|
| [HIGH] Cookie 由来の被害者 vid を別テナントのイベントへ書き込める (same-site 兄弟サブドメインから攻撃者 site_id を顧客プロキシへ送信。Codex が実 handler で再現) | §3-1 step 3 第一者束縛を新設 (Sec-Fetch-Site: same-origin × X-Forwarded-Host == sites.url ホスト × 単一 site_id)。未束縛時はイベント不変・Set-Cookie なし。handler テストで攻撃を再現→遮断を固定。§2 プロキシ要件、§4 S-9、§7 残存リスク (同一オリジンスクリプト / ホスト一意性) を追加 |
| 7件の fix 確認 | 1・2・3・5・6・7 CONFIRMED、4 PARTIALLY (実機検証未了) — v4 で S-8 の論点自体を解消 (直叩きには Set-Cookie を返さない) |
| `is_first_visit` の整合 (mint 時に client 判定 false が残る) | §3-1 step 4: mint 時は true に補正 |
| (直接修正) worker.ts の「Sentry 自動計装」誤コメント / 設置画面の HTTPS 前提 / 設計書の参照行 | Codex の直接修正を取り込み (PR #29 に含める) |
| 未実施のまま: プロキシ・ブラウザ・Cloudflare ログの実機確認 | §5 手順0 (スパイクにヘッダ転送確認を追加)、§3-4、§6 に集約。デプロイ前ゲート |
