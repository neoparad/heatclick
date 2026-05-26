# ugokimap-banner-runtime — Cloudflare Worker (Phase 2A)

UGOKI MAP / LINKTH SaaS の **Banner Engine Phase 2A MVP** runtime。Cloudflare Workers edge で `GET /v1/decision` を受け、KV から rule_bundle を read → audience match → banner 配信決定を返す。

- **PRD**: `linkscrawl/docs/banner-engine/REQUIREMENTS.md` §2 F1 / F5
- **Privacy/CSP/Perf gate**: `linkscrawl/docs/banner-engine/privacy-csp-perf-gate.md`
- **dispatch**: `linkscrawl/docs/banner-engine/dispatch/dispatch-05-infra-banner-worker-runtime.md`
- **contracts SSOT**: `ugokimap-contracts/schemas/*.schema.json`

---

## Endpoint

```
GET  https://ugokimap-banner-runtime.linkth.workers.dev/v1/decision
       ?site_id=<uuid v4>
       &cid=<GA client_id, optional>
       &tenant_id=<lowercase alnum>  ← required (Bearer JWT 経路でも可)

GET  /health   → { status: 'ok', worker: '...' }
OPTIONS *       → 204 with CORS preflight
```

Response: `worker_response.schema.json` 準拠 JSON。`status ∈ {ok, no_match, consent_denied, fallback, error}`。

---

## 重要制約

| 制約 | source |
|---|---|
| ClickHouse 直接 read 禁止 | PRD §6 C3 / Codex 13 §9 |
| cross-tenant 配信絶対禁止 | PRD §3 D-4 |
| sensitive_category_excluded=true で LLM 由来 banner は skip | PRD §6 C7 |
| P95 latency ≤ 100ms (KV read 2 回で完結) | PRD §1.2 O1 |
| gzip ≤ 20KB / main thread ≤ 50ms / CLS 0 | PRD §2 F3 |

---

## ローカル開発

```bash
# 依存インストール
npm install

# 型チェック
npm run typecheck

# ユニットテスト (Node --test runner + tsx)
npm test
```

37 件のテストが走り、全 green を確認すること:
- normalizeTenantId × 6
- audienceMatches × 5
- passesHoldout × 4
- shouldSkipSensitive × 4
- evaluateConsent × 9 (analytics 非 blocking / personalization+ads 必須)
- combined matrix × 4
- KV key format × 2
- schedule boundary × 2
- __test_only__ exposure × 1

---

## デプロイ手順 (Owner runbook)

実 deploy は Owner SSH 経由で Cloudflare Workers アカウントから実行する。本セクションは
Owner が実行する手順を記録する。

### Step 1 — KV namespace 作成 (初回のみ)

```bash
# 本 worker 用の KV namespace を 2 つ作成
wrangler kv:namespace create RULE_BUNDLES_KV
wrangler kv:namespace create RULE_BUNDLES_KV --preview

wrangler kv:namespace create MEMBER_ATTRIBUTES_KV
wrangler kv:namespace create MEMBER_ATTRIBUTES_KV --preview
```

出力された `id` / `preview_id` を `wrangler.toml` の `REPLACE_WITH_*` 部分に置換。

### Step 2 — Secrets bootstrap (初回のみ)

```bash
# ClickHouse 接続 (audit_events INSERT 用、event-ingest worker と同値推奨)
wrangler secret put CLICKHOUSE_URL
# 入力: http://default:<password>@<host>:8123

# MAGIC_LINK_SECRET (HS256 shared、event-ingest worker と完全同値)
wrangler secret put MAGIC_LINK_SECRET
# 入力: 既存 ugokimap-saas/lib/auth/magic-link.ts と同じ値
```

### Step 3 — Preview deploy (staging 観測 24h)

```bash
# wrangler.toml の routes が未設定なので、workers.dev サブドメインに deploy される。
# まず preview 環境名で push (本番影響なし)
wrangler deploy --name ugokimap-banner-runtime-preview

# 初回 smoke
curl -i 'https://ugokimap-banner-runtime-preview.linkth.workers.dev/health'
# → { status: 'ok', worker: 'ugokimap-banner-runtime' }

# decision test (wakegai 想定、初回は KV 空なので fallback 期待)
curl -i 'https://ugokimap-banner-runtime-preview.linkth.workers.dev/v1/decision?site_id=<wakegai-uuid>&tenant_id=linkth_internal&cid=test_cid_001'
# → { status: 'fallback', tenant_id: 'linkth_internal', ... }
```

### Step 4 — dispatch-06 KV publish job で test bundle 投入

(dispatch-06 で `publish_rule_bundle.py` 実装後の手順)

```bash
cd C:/Users/M2603/linkscrawl
python scripts/publish_rule_bundle/cli.py \
  --tenant-id linkth_internal \
  --site-id <wakegai-uuid> \
  --bundle test/fixtures/wakegai_phase2a_bundle.json \
  --kv-namespace RULE_BUNDLES_KV
```

Preview worker で再度 decision 試験:

```bash
curl -i 'https://ugokimap-banner-runtime-preview.linkth.workers.dev/v1/decision?site_id=<wakegai-uuid>&tenant_id=linkth_internal&cid=test_cid_001'
# → { status: 'ok' or 'no_match' or 'consent_denied' }
```

### Step 5 — 24h staging 観測

- Cloudflare Analytics で P95 latency 確認 (目標 ≤ 100ms)
- audit_events table で `banner.serve` / `banner.no_match` / `banner.consent_denied` / `banner.fallback` の record 件数確認
- audit_events で `banner.cross_tenant_blocked` = 0 件 (D-4 担保確認)
- KV miss rate < 5% (続 44 §5 monitoring skeleton 経由)

### Step 6 — Production promote

```bash
# preview と同一 KV namespace + secrets を維持して production deploy
wrangler deploy
# (wrangler.toml の name = 'ugokimap-banner-runtime' に向く)
```

Reviewer T1 dual + Owner approval を取得してから実行。

### Step 7 — Custom domain (任意、Sprint 4 W1+)

Cloudflare Dashboard で `banner.ugokimap.com` を Routes に追加。`wrangler.toml` の `[[routes]]` block をコメントアウト解除。

---

## ロールバック手順

1. **Preview promote 直後の問題**: Cloudflare Dashboard → Workers → ugokimap-banner-runtime → Deployments → 前 version の "Rollback" ボタン
2. **広範囲な障害**: Worker を完全停止 (Dashboard → Disable Worker) → tracking.js 側は worker 応答無しを fail-closed で no banner 描画 → 顧客サイト UX への影響ゼロ
3. **KV 汚染**: `wrangler kv:key delete --binding RULE_BUNDLES_KV 'rules/{tenant_id}/{site_id}/active'` → Worker は `active_missing` で fallback 動作

---

## audit 4 種記録

| audit action | 発火条件 |
|---|---|
| `banner.serve` | audience match + consent ok + 配信決定 |
| `banner.no_match` | audience 不適合または schedule 範囲外 |
| `banner.consent_denied` | bundle/member の consent_flags でブロック |
| `banner.fallback` | KV miss / parse_error / stale / schema_mismatch |
| `banner.error` | tenant_id missing 等の hard error (HTTP 4xx) |
| `banner.cross_tenant_blocked` | D-4 違反検知 (HTTP 403) |
| `banner.deletion_processed` | (将来) 削除済 cid 経由の銀行確認 |

audit_events INSERT は `ctx.waitUntil` で fire-and-forget、Worker latency に影響なし (event-ingest worker と同じ pattern)。

---

## ファイル構成

```
workers/banner-runtime/
├── src/
│   ├── worker.ts         # main fetch handler + decision pipeline
│   └── contracts-types.ts # local re-export from ugokimap-contracts
├── test/
│   └── worker.test.ts    # node --test + tsx (37 tests)
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md (本書)
```

---

## 関連 worker

- `workers/event-ingest/` — tracking event 受信 worker (続 26 / 35 / 82 運用中)。本 worker は別 deploy、ただし `MAGIC_LINK_SECRET` / `CLICKHOUSE_URL` / `audit_events` テーブルを共有

---

## 改訂履歴

- 2026-05-26 (続 86): dispatch-05 配備完了、選択肢 B (新規 worker) 採用、37 件テスト green、tsc --noEmit green。Owner deploy 待ち
