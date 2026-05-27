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

実 deploy は Owner が Cloudflare account に SSH-equivalent (wrangler CLI) で実行。本セクションは
Owner が実行する手順を記録する。

> **重要 (続 99 §1 で確定)**: Cloudflare Workers の仕様上、**secret は worker 登録後にしか put できない**。
> よって順序は **Step A 初回 deploy → Step B secret put → Step C 再 deploy (secret 反映)**。
> 旧版 README は「Step 1 KV → Step 2 secret → Step 3 deploy」の順で書いていたが実手順と乖離していたため修正済。

### Step 1 — KV namespace 作成 (初回のみ、既に作成済なら skip)

```powershell
# 既に作成済か確認
npx wrangler kv namespace list

# 未作成の場合のみ実行 (binding 名は wrangler.toml と一致必須)
npx wrangler kv namespace create RULE_BUNDLES_KV
npx wrangler kv namespace create RULE_BUNDLES_KV --preview
npx wrangler kv namespace create MEMBER_ATTRIBUTES_KV
npx wrangler kv namespace create MEMBER_ATTRIBUTES_KV --preview
```

出力された 4 つの `id` / `preview_id` を `wrangler.toml` L18/L19/L23/L24 の `REPLACE_WITH_*` 部分に置換し、commit する。
**続 99 §2 配備時点 (2026-05-30) で既に 4 KV namespace 作成済**、id は wrangler.toml に投入済 (`ugokimap-saas 472b31f`)。新規 deploy 環境を立ち上げる場合のみ本 Step 1 が必要。

### Step A — 初回 preview deploy (worker 登録、secret なしでも動作)

```powershell
cd C:\Users\M2603\ugokimap-saas\workers\banner-runtime
npx wrangler deploy --name ugokimap-banner-runtime-preview
```

期待出力:

```
Total Upload: ~25-35 KiB / gzip: ~8-12 KiB    ← PRD §2 F3 perf budget gzip ≤ 20KiB
Uploaded ugokimap-banner-runtime-preview
Deployed ugokimap-banner-runtime-preview triggers
  https://ugokimap-banner-runtime-preview.linkth.workers.dev
Current Version ID: <uuid>
```

この時点で worker は登録されており、`/health` および `/v1/decision` が応答する (audit_events INSERT は env.CLICKHOUSE_URL 未設定で skip、それ以外は動作)。

### Step B — Secret 投入 (worker 登録後)

```powershell
# CLICKHOUSE_URL のみ (Phase 2A 必須、event-ingest worker と同値)
npx wrangler secret put CLICKHOUSE_URL --name ugokimap-banner-runtime-preview
# プロンプトで http://default:<password>@<clickhouse-host>:8123 を貼り付け
```

> **MAGIC_LINK_SECRET は Phase 2A 不要**。worker.ts は未設定なら JWT 経路 skip → query string `tenant_id` 経路で動く。
> wakegai tracking.js v2.4.0+ は `tenant_id=linkth_internal` を query string で送出するため Phase 2A の preview / production deploy で MAGIC_LINK_SECRET は不要。
> Phase 2B (Sprint 4 W1) の B-to-B JWT 経路有効化時に追加。

### Step C — secret 反映のための再 deploy

```powershell
npx wrangler deploy --name ugokimap-banner-runtime-preview
```

`Current Version ID:` が Step A と異なる新 UUID になっていれば secret 反映成功。

### Step D — smoke 確認

```powershell
# /health
curl.exe -i "https://ugokimap-banner-runtime-preview.linkth.workers.dev/health"
# → 200 OK + {"status":"ok","worker":"ugokimap-banner-runtime"}

# /v1/decision (KV bundle 投入前、fallback 期待)
curl.exe -i "https://ugokimap-banner-runtime-preview.linkth.workers.dev/v1/decision?site_id=11111111-2222-3333-4444-555555555555&tenant_id=linkth_internal&cid=test_001"
# → 200 OK + status=fallback + decision.nonce / X-Banner-Nonce header 同値配信
```

続 99 §3-§4 で smoke verification 全項 GREEN 確認済 (本ターミナル Director curl 実施)。

### Step E — wakegai bundle YAML 投入 (dispatch-09 + publish job 経由)

publish job は `linkscrawl/scripts/banner_publish/` (続 91 配備)。Cloudflare HTTP API 経由で KV write するため `CLOUDFLARE_API_TOKEN` (KV:Edit 権限) が必要。

#### E-1: token 発行 (初回のみ、5 分)

1. https://dash.cloudflare.com/profile/api-tokens
2. Create Token → Custom token
3. Permissions: `Account` → `Workers KV Storage` → `Edit`
4. Account Resources: 当該 account のみ
5. Create → token を控える (`.env` に保存推奨、AI に渡さない)

#### E-2: dry-run validation (実 KV write なし)

```powershell
cd C:\Users\M2603\linkscrawl\scripts\banner_publish
$env:CLOUDFLARE_API_TOKEN = "<貼り付け>"
$env:CLOUDFLARE_ACCOUNT_ID = "76c9d366fabdcc59d4bc9008c7936584"

python -m banner_publish.cli publish `
  --bundle bundles/wakegai_phase2a_bundle.yaml `
  --kv-namespace 05b491cb09264be19fc9363876a8c60e `
  --dry-run
# → "✓ Bundle valid, would PUT rules/linkth_internal/.../<version>"
```

#### E-3: preview namespace に本投入 (dry-run green 確認後)

```powershell
python -m banner_publish.cli publish `
  --bundle bundles/wakegai_phase2a_bundle.yaml `
  --kv-namespace 05b491cb09264be19fc9363876a8c60e
```

> 本番 namespace `e956e76f...` へは production promote (Step 7) と並走で投入。

#### E-4: 再 smoke (status 変化確認)

```powershell
# wakegai 想定 site_id (Marketer 続 94 配備の YAML で確認)
$WAKEGAI_SITE = "<bundles/wakegai_phase2a_bundle.yaml の site_id>"
curl.exe -i "https://ugokimap-banner-runtime-preview.linkth.workers.dev/v1/decision?site_id=$WAKEGAI_SITE&tenant_id=linkth_internal&cid=test_001"
# → status: fallback → no_match / consent_denied / ok に変化 (bundle 投入成功)
```

### Step F — 24h staging 観測 (続 99 §6 監視 plan)

- Cloudflare Analytics で P50 < 20ms / P95 < 80ms / 5xx 0% を確認 (目標 PRD §1.2 O1 = P95 ≤ 100ms)
- audit_events table で `banner.serve` / `no_match` / `consent_denied` / `fallback` / `sensitive_category_blocked` の record 件数確認 (`banner.*` prefix 統一、続 97 §5)
- audit_events で `banner.cross_tenant_blocked` = **0 件** (D-4 担保確認、>0 で immediate CRITICAL)
- KV miss rate < 5% (続 91 §5 + Phase 2A.1 で write rate metric 追加予定)
- Operator が 5/30 朝 + 5/31 朝の 2 回 dashboard snapshot を続 100+ に貼付

### Step G — dispatch-10 Playwright E2E (Frontend、6/01 朝)

preview URL `https://ugokimap-banner-runtime-preview.linkth.workers.dev` を Playwright spec の base URL に投入、CLS 0 / TBT ≤ 50ms / gzip ≤ 20KiB の perf budget verify。
**CSP enforcement test は Phase 2B 移管** (続 97 §2)、Phase 2A E2E は **nonce 配信 + perf budget のみ**。

### Step 7 — Production promote (6/02 EOD)

```powershell
# preview と同一 KV namespace + secrets を維持
# wrangler.toml の name = 'ugokimap-banner-runtime' (本番 alias) に deploy
cd C:\Users\M2603\ugokimap-saas\workers\banner-runtime
npx wrangler deploy
# → https://ugokimap-banner-runtime.linkth.workers.dev に payload (preview と別 URL)
```

gate 条件 (本番 promote 前必須):
- Step F 24h staging green
- dispatch-10 Playwright E2E green
- Reviewer T1 dual green (続 98 Codex 15 で発行済)
- Owner approval

#### 本番 namespace への bundle 投入

production promote 直後または並走で:

```powershell
cd C:\Users\M2603\linkscrawl\scripts\banner_publish
python -m banner_publish.cli publish `
  --bundle bundles/wakegai_phase2a_bundle.yaml `
  --kv-namespace e956e76f604b4e6d803cbaf80d86fc75
# 本番 namespace に同 bundle を投入
```

### Step 8 — Custom domain (任意、Sprint 4 W1+)

Cloudflare Dashboard で `banner.ugokimap.com` を Routes に追加。`wrangler.toml` の `[[routes]]` block をコメントアウト解除。

---

## ロールバック手順

1. **Preview promote 直後の問題**: Cloudflare Dashboard → Workers → ugokimap-banner-runtime → Deployments → 前 version の "Rollback" ボタン
2. **広範囲な障害**: Worker を完全停止 (Dashboard → Disable Worker) → tracking.js 側は worker 応答無しを fail-closed で no banner 描画 → 顧客サイト UX への影響ゼロ
3. **KV 汚染**: `wrangler kv:key delete --binding RULE_BUNDLES_KV 'rules/{tenant_id}/{site_id}/active'` → Worker は `active_missing` で fallback 動作

---

## audit action 記録 (続 97 §5 で `banner.*` prefix 統一)

| audit action | 発火条件 | 担当 |
|---|---|---|
| `banner.serve` | audience match + consent ok + 配信決定 | worker |
| `banner.no_match` | audience 不適合または schedule 範囲外 | worker |
| `banner.consent_denied` | bundle/member の consent_flags でブロック (reason: `personalization_not_opted_in` / `ads_not_opted_in` / `consent_flags_missing`) | worker |
| `banner.fallback` | KV miss / parse_error / stale / schema_mismatch | worker |
| `banner.error` | nonce 生成失敗等の hard error | worker |
| `banner.cross_tenant_blocked` | D-4 違反検知 (HTTP 403) | worker |
| `banner.sensitive_category_blocked` | excluded=false かつ evidence_level=inferred で skip (続 97 §3) | worker |
| `banner.member_tombstone` | publish job 経由 P-21 削除 cid の KV tombstone 書込 (続 91 + 続 97 §5 統一) | publish job |
| `banner.tenant_purge` | publish job 経由 tenant 全削除 (続 91 + 続 97 §5 統一) | publish job |
| `banner.publish` | publish job 経由 bundle PUT 完了 | publish job |

audit_events INSERT は `ctx.waitUntil` で fire-and-forget、Worker latency に影響なし (event-ingest worker と同じ pattern)。横断 grep `banner.*` 一発で worker + publish job 両方集約可。

---

## ファイル構成

```
workers/banner-runtime/
├── src/
│   ├── worker.ts         # main fetch handler + decision pipeline (~855 行)
│   └── contracts-types.ts # local re-export from ugokimap-contracts
├── test/
│   └── worker.test.ts    # node --test + tsx (62 tests、続 88+ 続 97 hotfix 反映)
├── package.json
├── tsconfig.json
├── wrangler.toml         # KV namespace IDs 投入済 (続 99 §1)
└── README.md (本書、続 99 §1 で deploy 順序修正)
```

---

## 関連 worker

- `workers/event-ingest/` — tracking event 受信 worker (続 26 / 35 / 82 運用中)。本 worker は別 deploy、ただし `MAGIC_LINK_SECRET` / `CLICKHOUSE_URL` / `audit_events` テーブルを共有

---

## 改訂履歴

- 2026-05-26 (続 86): dispatch-05 配備完了、選択肢 B (新規 worker) 採用、37 件テスト green、tsc --noEmit green。Owner deploy 待ち
- 2026-05-28 (続 97): dispatch-11 §1 + §3 + §5 hotfix (Codex 14 CRITICAL A-C1 + WARN C-W1/D-W2 解消)、62 件テスト green。`ugokimap-saas c59d5aa`
- 2026-05-29 (続 98): Codex 15 hotfix verification 🟢 GO (CRITICAL 0 / WARN 3 / INFO 4)、Owner preview deploy approval 発行
- 2026-05-30 (続 99): Owner preview deploy 完走 (Step A→B→C) + Director smoke verification 全項 GREEN (/health + /v1/decision + T1 sanity 7 件)。README runbook の deploy 順序を実手順 (Step A 初回 deploy → Step B secret put → Step C 再 deploy) に修正、audit action 一覧を続 97 §5 `banner.*` 統一に整合化、Step E に publish job 経由 wakegai bundle YAML 投入手順追加
