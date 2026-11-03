# 融合計画

状態: 下書き（2026-11-03）。オーナー確認後に確定。数字・現状の根拠は [STATE_2026-11-03.md](STATE_2026-11-03.md)。

---

## 1. 融合後の形

```
                   ┌─────────────── ugokimap-saas（Next.js・Vercel）───────────────┐
  顧客 ── ログイン ─▶│ 認証・テナント（既存の Postgres JWT に一本化）                │
                   │ サイト台帳（新設）: 1サイト = ugokimap / linkscrawl / AIreceipt │
                   │ 画面: ヒートマップ・CV導線（既存）＋ AI訪問・SEO（aiseoから移植）│
                   └──────┬───────────────┬────────────────┬────────────────┬──────┘
                          │               │                │                │
                     ClickHouse      linkscrawl API    AIreceipt        GSC API
                   （人の行動・構造）  （/v1、APIキー）   collector       （サービス
                                                     （読み取り専用鍵）   アカウント）
```

**原則**

- 画面と認証は ugokimap-saas の1か所だけ。
- 各データの正本は元の場所に置いたまま。融合SaaSは「読む側」。特に AIreceipt の記録（証拠）を SaaS 側へコピーして正本扱いしない。
- 1URL の単位で、人の行動・構造・検索流入・AI訪問を並べられることがゴール。

---

## 2. 工事の順番

| 段階 | やること | 終わりの条件 |
|---|---|---|
| **P0 準備** | ①ugokimap-saas の未コミット25件をオーナーが区切る ②aiseo/web と AIreceipt を git 管理下に置く ③鍵ファイルを除外し、環境変数の一覧（`.env.example`）を作る | 3つとも git で差分が見える。鍵がリポジトリに無い |
| **P1 つなぎ目** | ①サイト台帳を作る（`tenant_sites` を拡張し、linkscrawl のホストと AIreceipt の site_id/install を紐づけ） ②共通の URL 正規化関数を1つ作り、TS と Python で同じ規則にする | 1サイトについて3製品のデータが同じキーで引ける。正規化のテストが緑 |
| **P2 AI訪問の画面** | aiseo の `/`・`/search-crawlers`・`/visit-risk`・`/journey` を移植。純粋ロジック（risk.js・confidence.js・journey.js・collector.js）は TypeScript にして `lib/aiseo/` へ | bihadashop.jp で実データ表示。既存テストと新規テストが緑 |
| **P3 SEOの画面** | `/seo/access`・`/seo/sitemap`・`/seo/internal-links` を移植。GSC テーブルを Postgres へ。linkscrawl はファイル読み込みをやめ `/v1` API に切り替え | GSC と linkscrawl が API 経由で表示される |
| **P4 融合ビュー** | 1URL の詳細画面に「人の行動・構造・検索流入・AI訪問」を並べる | 1ページで4種類が同じURLとして揃う |
| **P5 片付け** | aiseo/web を凍結（消さない）。AIreceipt `docs/09` を「母体＝ugokimap-saas」に書き換え | 移植元に新しい変更が入らない |

**並行して必要なもの（P2 より前に着手）**

- **`is_agent` の較正**（ugokimap）: `no_plugins` 単独判定の誤検知率を測る。人とAIを並べる製品なので、ここが狂っていると P4 の画面が嘘になる。
- **AIreceipt の読み取り専用鍵**（collector）: 今は install ごとの鍵でしか読めない。SaaS が複数顧客のデータを読む仕組みが要る（docs/09 の S3 に相当）。

aiseo の Stub 画面（AIO・LLMO・日次トラッキング等）も移植対象に含める。中身は今と同じく未実装のまま移し、外さない。

---

## 3. オーナーが決めること

推奨を先に書く。

| # | 決めること | 推奨 | 選ぶと何が起きるか |
|---|---|---|---|
| D1 | 母体 | ugokimap-saas | 認証・課金の作り直しが不要。aiseo の画面を移す手間だけが出る |
| D2 | aiseo/web の認証（Supabase） | 捨てて ugokimap-saas の認証に一本化 | ログインが1つになる。aiseo の organization は tenant に読み替える |
| D3 | AIreceipt の読み方 | SaaS 専用の読み取り専用鍵を collector に追加 | 顧客ごとに鍵を SaaS 側で保管しなくて済む。collector の改修が要る |
| D4 | 未コミット25件の扱い | 先にコミットして区切る | 融合工事と既存作業が混ざらない |
| D5 | Stripe（未使用） | 融合後のプラン設計で扱う。今は触らない | P0〜P4 の範囲が広がらない |

---

## 4. やってはいけないこと

- 本番（Vercel・Cloudflare Workers・crawler.link-th.co.jp）への反映を、オーナー確認なしに行う。
- 鍵・トークンをコードや文書に書く。
- AIreceipt の `docs/10`（能動監査）に着手する（保留中）。
- 「なりすまし確定」「違反」など、UA 1本の弱い根拠で断定する表示を増やす（`confidence.js` の確信度表示を必ず付ける）。
- `git add -A` / `git add .`（並行作業を巻き込む）。

---

## 5. 未確認のまま残っていること

- URL 正規化の違いで、実データがどれだけ取りこぼされているか。
- `is_agent` の誤検知率（`no_plugins` 単独）。
- `tracking.js` 本体の所在（`public/` 直下に無い。`/api/track` のコメントにだけ記載）。
- linkscrawl の Antigravity 引き継ぎ書が本体ブランチに統合されたか（2026-11-03 時点では worktree のみ）。
