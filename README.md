# ugokimap-saas

**UGOKI MAP / LINKTH 統合 SaaS** — 行動分析 + AISEO + カスタムBI を 1 つにまとめたマーケティングプラットフォーム。

- **作成日**: 2026-05-17 (Sprint 0 着工日)
- **親 SSOT**: [`C:\Users\M2603\linkscrawl\docs\fusion\strategy\19_grand_v1.md`](../linkscrawl/docs/fusion/strategy/19_grand_v1.md) (Part 0+I+II+III+VI 確定済)
- **再開エントリポイント**: [`C:\Users\M2603\linkscrawl\docs\fusion\team\PARALLEL_STREAMS.md`](../linkscrawl/docs/fusion/team/PARALLEL_STREAMS.md)
- **物理パス**: `C:\Users\M2603\ugokimap-saas\` (D-02 確定)
- **配置決定**: D-01 (旧 ugokimap には触らない) / D-02 (新規ディレクトリ独立) / D-03 (mini-saas 維持)

---

## ステータス

| 状態 | 内容 |
|---|---|
| ✅ Sprint 0 着工 | scaffold 作成完了 (2026-05-17) |
| ⏳ S0-01 〜 S0-13 | Sprint 0 タスク進行中 |
| ⏳ Week 0 W0-08/09 | 弁護士雛形戻り / tracking.js v2.3.0 main merge 並行 |

詳細: 親 SSOT §6.3 Sprint 0 を参照。

---

## ディレクトリ構成 (Phase 1 完了予定)

```
ugokimap-saas/
├── README.md
├── CLAUDE.md                    # プロジェクト固有 AI 指示
├── package.json                 # Next.js 14 + Tailwind + shadcn/ui + Stripe + Resend + Anthropic SDK
├── tsconfig.json
├── next.config.js
├── tailwind.config.ts           # v17 design tokens
├── postcss.config.js
├── .env.example
├── .gitignore
├── middleware.ts                # 認証 + tenant 分離 + audit log
├── instrumentation.ts           # Sentry
├── inngest.config.ts
├── app/
│   ├── layout.tsx
│   ├── globals.css              # v17 トークン
│   ├── (saas-shell)/            # サインアップ / 認証
│   │   ├── auth/sign-in/page.tsx
│   │   └── onboarding/install/page.tsx
│   ├── (proof)/                 # ICP-1/3/5 用 (Free/Starter/Growth)
│   │   ├── dashboard/page.tsx
│   │   ├── heatmap/page.tsx
│   │   ├── personas/page.tsx
│   │   ├── cv-journey/page.tsx
│   │   ├── pages/page.tsx
│   │   ├── performance/page.tsx
│   │   ├── insights/page.tsx
│   │   └── aiseo/{query,citation,sitemap,internal-links}/page.tsx
│   ├── (agency)/                # ICP-2/4 用 (Agency/Enterprise)
│   │   ├── dashboard/page.tsx
│   │   ├── clients/page.tsx
│   │   └── reports/page.tsx
│   └── api/                     # REST endpoints (ugokimap から流用 + tenant_id 拡張)
│       ├── auth/...
│       ├── track/route.ts
│       ├── heatmap/route.ts
│       ├── ai-insights/route.ts
│       ├── billing/...           # Stripe Webhook
│       └── account/delete-request/route.ts
├── components/
│   ├── ui/                      # shadcn/ui
│   ├── charts/                  # recharts ラッパー
│   ├── heatmap/                 # heatmap.js + 分割描画 (旧 ugokimap 修正案の新実装)
│   └── (各機能別)
├── lib/
│   ├── clickhouse/              # ugokimap から流用
│   ├── auth.ts + jwt.ts + tenant.ts  # ugokimap 流用 + tenant_id 拡張
│   ├── privacy.ts               # 流用
│   ├── rate-limit.ts            # プラン別 quota
│   ├── analysis-axes.ts         # 32 軸流用 + 8 軸追加
│   ├── claude.ts                # ugokimap 流用
│   ├── stripe.ts                # 新規
│   ├── resend.ts                # 新規
│   ├── mcp-client.ts            # MCP server 呼び出し
│   └── tenant.ts                # multi-tenant 分離
├── workers/
│   └── event-ingest/            # ugokimap から流用 (tenant_id 拡張)
├── public/
│   └── v2/                      # tracking.js v2.3.0 (ugokimap から流用)
├── migrations/                  # ClickHouse DDL
│   └── 2026-05-17-sprint0-tenant-isolation.sql  # Codex B-4 草案
├── tests/
│   ├── e2e/                     # Playwright
│   └── unit/
└── docs/
    ├── DEVELOPER_GUIDE.md       # 開発手順
    └── ARCHITECTURE.md          # 親 SSOT §3 から要約
```

---

## 開発開始手順

```powershell
cd C:\Users\M2603\ugokimap-saas

# 1. 依存パッケージインストール (Sprint 0 S0-01 で初回実行)
npm install

# 2. .env 設定
cp .env.example .env.local
# .env.local を編集して Anthropic / Google AI / DataForSEO / Resend / Stripe / Hetzner ClickHouse 接続情報を設定

# 3. 開発サーバー起動
npm run dev
# → http://localhost:3000 で起動

# 4. ClickHouse migration 実行 (S0-05)
# Infrastructure Engineer が SSH トンネル経由で
# migrations/2026-05-17-sprint0-tenant-isolation.sql を Hetzner に適用

# 5. 型チェック + ビルド
npm run type-check
npm run build

# 6. Playwright E2E テスト (S0-12)
npm run test:e2e
```

---

## Sprint 0 タスク (S0-01 〜 S0-13)

親 SSOT §6.3 に詳細あり。状態:

| # | タスク | 状態 |
|---|---|---|
| S0-01 | Next.js 14 scaffold | ⏳ 着手中 (このファイル作成中) |
| S0-02 | shadcn/ui + Tailwind + v17 tokens | ⏳ |
| S0-03 | lib/auth.ts + jwt.ts + tenant.ts | ⏳ |
| S0-04 | lib/clickhouse/ + analysis-axes.ts | ⏳ |
| S0-05 | ClickHouse migration (新規 5 テーブル + tenant_id 列追加) | ⏳ (SQL ファイル作成済、Infra が適用) |
| S0-06 | workers/event-ingest 流用 + tenant_id 拡張 | ⏳ |
| S0-07 | lib/stripe.ts + Webhook handler | ⏳ |
| S0-08 | lib/resend.ts + Email テンプレ 4 通 | ⏳ |
| S0-09 | middleware.ts (auth + tenant + audit) | ⏳ |
| S0-10 | inngest.config.ts | ⏳ |
| S0-11 | Sentry instrumentation | ⏳ |
| S0-12 | E2E テスト 1 本 (sign-in → dashboard → sign-out) | ⏳ |
| S0-13 | Owner #2 承認 (Sprint 0 完了) | ⏳ |

---

## ロール別開発担当

| ロール | 主担当 |
|---|---|
| Frontend Programmer | UI / Tailwind / shadcn/ui / Next.js routes |
| Infrastructure Engineer | ClickHouse migration / Workers / Vercel deploy / DNS |
| ML Programmer | (Sprint 2 から) ML パイプライン学習 |
| Reviewer | dual review (T1/T2/T3) |
| Operator | E2E テスト / Data Quality Gate |

再開プロンプトは [`C:\Users\M2603\linkscrawl\docs\fusion\team\RESUME_PROMPTS.md`](../linkscrawl/docs/fusion/team/RESUME_PROMPTS.md) 参照。

---

## デプロイ

- **本番**: Vercel (オーナー既契約)
- **ドメイン**: `ugokimap.com` (オーナー既保有) で Phase 1 稼働
- **バックエンド**: Hetzner Cloud (既存) — ClickHouse + PostgreSQL + Redis + Ollama
- **CDN**: Cloudflare (Workers + DNS、既存)

---

## 重要なルール

- 旧 ugokimap (`C:\Users\M2603\ugokimap\`) の `app/*` は**触らない** (D-01)
- 旧 ugokimap の `lib/` / `app/api/` / `workers/` / `public/tracking.js` を**流用** (新 SaaS から copy で利用)
- 既存 mini-saas (`C:\Users\M2603\mini-saas\project/*`) は**そのまま稼働継続** (D-03)
- 親 SSOT (`19_grand_v1.md`) の §1.7 Anti-Features / §3.8 Privacy / §6 Build Plan を必ず参照
