# Developer Guide — ugokimap-saas

新規開発者 (Claude Code セッション or 人間エンジニア) のためのオンボーディングガイド。

---

## 起動手順 (新規セッション)

```powershell
cd C:\Users\M2603\ugokimap-saas

# 1. 親 SSOT を読む
# C:\Users\M2603\linkscrawl\docs\fusion\strategy\19_grand_v1.md
# 特に: Part 0+I (Vision) / Part II §2.1 (機能) / Part III §3.6 (Serve) / Part VI §6.3 (Sprint 0)

# 2. このプロジェクトの README + CLAUDE.md を読む
cat README.md
cat CLAUDE.md

# 3. 並列ストリーム状態を確認
# C:\Users\M2603\linkscrawl\docs\fusion\team\PARALLEL_STREAMS.md

# 4. 現在の Sprint タスクを確認 (親 SSOT §6.3-§6.7)

# 5. 開発開始
npm install      # 初回のみ
cp .env.example .env.local  # secrets を埋める
npm run dev      # http://localhost:3000
```

---

## 開発 Flow

### 新機能実装の Standard Flow

```
1. 親 SSOT で機能要件 (F-XX) を確認
2. mockup (v17) を確認
3. feature branch 作成: git checkout -b feature/sprint-X-FXX-shortname
4. 実装
5. unit test 追加
6. npm run type-check + npm run lint
7. Codex dual review 依頼 (T1 該当時)
8. PR 作成 (develop へ)
9. Reviewer 承認後 merge
10. Vercel preview で動作確認
11. main merge → 本番 deploy
```

### Codex dual review が必須なファイル (T1)

- `middleware.ts`
- `lib/auth.ts` / `lib/jwt.ts` / `lib/tenant.ts`
- `app/api/auth/*`
- `app/api/billing/*` (Stripe webhook)
- `app/api/account/delete-request/*`
- `migrations/*.sql`
- `workers/event-ingest/src/worker.ts`
- LLM プロンプト (`lib/claude.ts`, `lib/llm/*`)
- ML パイプライン関連

---

## ディレクトリ別の責務

### `app/(saas-shell)/`
サインアップ / 認証 / オンボーディング。tenant に縛られない。

### `app/(proof)/`
ICP-1/3/5 向け UI。Free / Starter / Growth プラン専用。
- middleware で plan != Agency/Enterprise のみアクセス可

### `app/(agency)/`
ICP-2/4 向け UI。Agency / Enterprise プラン専用。
- middleware で plan in Agency/Enterprise のみアクセス可
- multi-client workspace switcher を必ず表示

### `app/api/`
REST API endpoints. 全 endpoint で:
- tenant_id を `requireTenantContext()` で取得
- ClickHouse query に必ず `tenantWhereClause()` を含める
- audit_events に書き込む (非同期、middleware で実施)

### `components/ui/`
shadcn/ui コンポーネント。`npx shadcn-ui add <component>` で追加。

### `components/charts/`
recharts ラッパー。v17 design token を使ったカラーリングに揃える。

### `components/heatmap/`
heatmap.js + 分割描画 (旧 ugokimap のバグ修正案を新実装、§6.4 S1-04)。

### `lib/`
クライアント / ユーティリティ。各ファイルは単一責務に。

### `migrations/`
ClickHouse / PostgreSQL DDL ファイル。日付順命名 (`YYYY-MM-DD-description.sql`)。
**Infrastructure Engineer のみが Hetzner に適用**。アプリケーションコードから直接実行しない。

### `workers/event-ingest/`
Cloudflare Workers ingest endpoint。ugokimap から流用 + tenant_id 拡張。
`wrangler deploy` で本番デプロイ。

### `public/v2/`
tracking.js v2.3.0 配信。ugokimap から copy。

---

## テスト

```powershell
# Unit
npm test
npm test -- --watch

# Type check
npm run type-check

# Lint
npm run lint

# E2E (Playwright)
npm run test:e2e
npm run test:e2e:ui  # interactive mode

# Coverage
npm test -- --coverage
```

### Coverage 目標
- Phase 1 末 (Sprint 5): 80%+
- Unit: 全 `lib/` + `app/api/` ロジック
- E2E: critical user flow 5 つ (sign-in / dashboard / heatmap / billing / delete-request)

---

## デプロイ

```powershell
# Preview deploy (PR ごとに自動)
git push origin feature/...

# Production deploy
git checkout main
git merge develop
git push origin main
# → Vercel が自動で本番 deploy
```

**禁止**: worktree からデプロイ (mini-saas/CLAUDE.md ルール継承)

---

## 環境変数 (.env.local)

`.env.example` をコピーして、各値を本番 secret に置き換え。
**git にコミットしない**。

Vercel 本番では Vercel dashboard の Environment Variables で設定。

---

## 親 SSOT との整合性チェック

新機能追加 / 設計変更時、以下を必ず確認:

| 確認項目 | 親 SSOT 場所 |
|---|---|
| §1.7 Anti-Features に違反していないか | §1.7 + §1.7.1 |
| Evidence Level バッジ付与しているか | §1.6 原則 2 / §1.8.2 / D-07 |
| tenant isolation 3 層防御済か | §3.8.1 |
| PII REDACT (ingest 段階) | §3.8.2 |
| 削除 API 対応 (14 日以内) | §3.8.3 |
| プラン上限 (sites / events / AI Insight / KW) 遵守 | §2.4.3 |
| Cost guard (利用量超過時の通知 / 制限 / 課金) | §2.3 |

違反候補は親 `decisions.md` に起票し Director 承認を得てから実装。

---

## 緊急時

| 状況 | 即連絡先 |
|---|---|
| tenant cross-access 検出 | Director + Reviewer (即停止) |
| Stripe 誤課金 | CFO + Director |
| ClickHouse データ破損 | Infrastructure Engineer + Director |
| secret 漏洩疑い | 全停止 + secret rotation |
| 本番 deploy 失敗 | Infrastructure Engineer + Director |
| 法的請求 (削除請求対応失敗等) | CFO + 顧問弁護士 + Director |
