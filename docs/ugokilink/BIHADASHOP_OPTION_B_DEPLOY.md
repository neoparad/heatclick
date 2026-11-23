# UGOKI LINK v2 — `bihadashop.jp` & `link-th.co.jp` Option B（既存 ClickHouse 別 DB `ugoki_link_v2`）並行配備手順書

既存の稼働環境（旧 `clickinsight` DB・旧 `workers/event-ingest`・各サイトの旧タグ）を一切止めずに、**既存 ClickHouse 上の別データベース `ugoki_link_v2`** を使って、まず **`bihadashop.jp`** で疎通し、続けて **`link-th.co.jp`** でもテスト稼働させる手順です（2 サイト分の鍵とタグを 1 コマンドで同時生成します）。

> 後日、専用の 8 GiB ClickHouse ノード（Option A）へ切り替える際は、環境変数 `UGK_CLICKHOUSE_V2_URL`（および `ugokilink-loader-jp` の `CLICKHOUSE_URL`）を新ノードへ向けるだけで移行できます。

---

## Step 0: 事前保全（推奨・5 分）
1. `https://app.inngest.com` で旧外部アプリ `heatmap-clickinsight` (`I-5`) を **Pause**（既存 4.54 GiB ClickHouse のメモリ余裕を確保）。
2. `bihadashop.jp` の Search Console 一括書き出しとアクセスログ保全を有効化。

---

## Step 1: 既存 ClickHouse に別 DB `ugoki_link_v2` を作成し DDL を適用
既存 `clickinsight` DB には一切触れず、新規 DB `ugoki_link_v2` にのみ [001_clickhouse_v2.sql](../../migrations/link/001_clickhouse_v2.sql) を適用します：

```bash
# ClickHouse クライアント（SSH トンネルまたは許可ネットワークから）
clickhouse-client --query "CREATE DATABASE IF NOT EXISTS ugoki_link_v2;"
clickhouse-client --database ugoki_link_v2 --multiquery < migrations/link/001_clickhouse_v2.sql
```

Postgres（既存 Supabase / Postgres）へ [002_postgres_v2.sql](../../migrations/link/002_postgres_v2.sql) を適用します：

```bash
psql "$DATABASE_URL" -f migrations/link/002_postgres_v2.sql
```

---

## Step 2: Cloudflare R2 バケット & Queues 作成（JP リージョン固定）

```powershell
# R2 バケット（APAC / JP リージョンヒント）
npx wrangler r2 bucket create ugk-wal-jp --location apac
npx wrangler r2 bucket create ugk-spill-jp --location apac
npx wrangler r2 bucket create ugk-hold-jp --location apac
npx wrangler r2 bucket create ugk-quarantine-jp --location apac

# Cloudflare Queues
npx wrangler queues create ugk-ingest-main-jp
npx wrangler queues create ugk-ingest-custom-jp
npx wrangler queues create ugk-deletion-jp
```

---

## Step 3: `bihadashop.jp` & `link-th.co.jp` 用キーとスニペットをまとめて生成

```powershell
node scripts/link/bootstrap-bihadashop.mjs --collector-url "https://ugokilink-collector-jp.<your-subdomain>.workers.dev"
```

既定で **`bihadashop` (`bihadashop.jp`)** と **`link-th` (`link-th.co.jp`)** の 2 サイト分をまとめて含む `SITE_KEYS_JSON` / `UGK_SITES_BOOTSTRAP_JSON` と、サイト別の並行 HTML スニペット 2 本が出力されます（シークレットはコミット禁止）。

---

## Step 4: 新規 4 Workers を Cloudflare へデプロイ

```powershell
# 1. Collector
cd workers/link-collector
npx wrangler secret put SITE_KEYS_JSON
npx wrangler secret put CONTINUITY_TOKEN_SECRET
npx wrangler secret put LAB_MARKER_SECRET
npx wrangler deploy

# 2. WAL Writer
cd ../link-wal
npx wrangler secret put QUARANTINE_ENCRYPTION_MASTER_KEY
npx wrangler deploy

# 3. Shard Loader (1分ごと Cron で R2 WAL -> ClickHouse ugoki_link_v2 へ投入)
cd ../link-loader
npx wrangler secret put CLICKHOUSE_URL
npx wrangler secret put CLICKHOUSE_USERNAME
npx wrangler secret put CLICKHOUSE_PASSWORD
npx wrangler deploy

# 4. Live 30分 Durable Object
cd ../link-live
npx wrangler deploy
```

---

## Step 5: Vercel へ `feat/ugokilink-v2` をデプロイ

1. Vercel の Project Settings → Environment Variables に以下を追加：
   - `UGK_ENABLE_V2_PROD_WIRING=true`
   - `UGK_CLICKHOUSE_V2_DB=ugoki_link_v2`
   - `UGOKILINK_KEY_PEPPER=<Step 3 の出力>`
   - `UGK_SITES_BOOTSTRAP_JSON=<Step 3 の出力>`
   - （※既存 `CLICKHOUSE_URL` / `CLICKHOUSE_RO_USERNAME` / `CLICKHOUSE_RO_PASSWORD` をそのまま流用可能。専用 8 GiB ノード移行時は `UGK_CLICKHOUSE_V2_URL` を追加）
2. ブランチ `feat/ugokilink-v2` を `git push` し、Vercel で Preview または Production デプロイを実行。

---

## Step 6: 並行タグを貼付して疎通確認（まず `bihadashop.jp` → 続けて `link-th.co.jp`）

1. まず **`bihadashop.jp`** の既存旧タグを残したまま、Step 3 で出力された `[1/2] bihadashop.jp` 用スニペットを追加設置します。
2. ブラウザで `bihadashop.jp` を 1 ページ開き、DevTools の Network タブで `ugokilink-collector-jp` への `POST /v1/collect/events` が HTTP `200` になることを確認します。
3. 同様に **`link-th.co.jp`** にも `[2/2] link-th.co.jp` 用スニペットを追加設置して 1 ページ開きます（Workers 側の再デプロイは不要 — Step 3 で既に 2 サイト分登録済み）。
4. 1〜2 分後に ClickHouse で 2 サイトそれぞれの行が入ったことを確認します：
   ```sql
   SELECT site_id, count(), max(updated_at)
   FROM ugoki_link_v2.pv_state
   WHERE site_id IN ('bihadashop', 'link-th')
   GROUP BY site_id;
   ```
5. `/api/v1/sites/bihadashop/metrics` および `/api/v1/sites/link-th/metrics` に Bearer キーで疎通し、実データが返ることを確認して運用開始します。
