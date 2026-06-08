# 設計書: マルチテナント / マルチユーザー認証 (B = tenant-per-client) (2026-06-08)

> T1（認証 / テナント隔離 / データ移行）。**実装前に Codex dual review + threat-modeler(STRIDE)** を通すこと。
> 決定: wakegai は外部クライアント → **独立テナント (B)**。多クライアント・多ユーザー前提で最初から設計。

## 1. ゴール / 非ゴール
- ゴール: 外部クライアント（wakegai 等）が**自社テナントでログインし、自社データだけ**を管理画面で見られる。クライアント/ユーザーを**運用作業で追加**できる。
- 非ゴール(本書): セルフサインアップ / Stripe 課金連携 / SSO（将来 P4）。

## 2. 現状（9割は完成済み・足りない1割）
| 要素 | 状態 |
|---|---|
| JWT（`sub`=user_id / `email` / `tenant_id` / `plan` / `site_ids[]`） | ✅ multi-tenant aware（`role` 追加が必要） |
| middleware（JWT検証＋テナント分離＋route ACL＋audit） | ✅ |
| `lib/tenant.ts`＋`canAccessSite()` / 全クエリ `tenant_id` 強制 | ✅ |
| magic-link メール認証 + owner-login + rate-limit + audit | ✅ |
| **user→tenant→site→role 登録簿** | 🔴 `lib/auth/dogfood-users.ts` に**ハードコード**（単一 `linkth_internal`+5 sites） |
| トランザクションDB | ⚠ **無し**（KV/Redis + ClickHouse のみ。Postgres は未導入） |

→ 足りないのは「**登録簿の永続化 + プロビジョニング**」。認証メカニズムは作り直さない。

## 3. 最初の分岐: 登録簿の保存先
| 案 | 内容 | 評価 |
|---|---|---|
| **(推奨) Managed Postgres** 導入（Neon/Supabase via Vercel Marketplace） | users/tenants/memberships/invitations を関係DBに | unique email・参照整合・トランザクション招待・関係クエリ・将来の課金/組織に最適。新インフラ1個 |
| KV-backed（scenarios と同じ） | KV キー設計＋手動 index | 新インフラ不要・一貫。だが unique制約/join/トランザクションを手で実装＝認証ドメインには脆い |

**推奨 = Postgres**（認証/組織/課金は関係データが本質。KV は rate-limit/session cache/scenarios の高頻度 ephemeral に残す）。Owner 承認事項。

## 4. データモデル（Postgres）
```sql
CREATE TABLE tenants (
  id            text PRIMARY KEY,         -- 'tnt_wakegai' 等
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'free',
  status        text NOT NULL DEFAULT 'active',  -- active/suspended
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_sites (
  tenant_id     text REFERENCES tenants(id) ON DELETE CASCADE,
  site_id       text NOT NULL,            -- ClickHouse の site_id (CIP_xxxx)
  PRIMARY KEY (tenant_id, site_id)
);
CREATE TABLE users (
  id            text PRIMARY KEY,         -- 'usr_xxx'
  email         citext UNIQUE NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  user_id       text REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     text REFERENCES tenants(id) ON DELETE CASCADE,
  role          text NOT NULL,            -- owner/admin/member/viewer
  PRIMARY KEY (user_id, tenant_id)
);
CREATE TABLE invitations (
  token_hash    text PRIMARY KEY,         -- 招待トークンの hash (生tokenは保存しない)
  email         citext NOT NULL,
  tenant_id     text REFERENCES tenants(id) ON DELETE CASCADE,
  role          text NOT NULL,
  invited_by    text REFERENCES users(id),
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz
);
```
- **1ユーザーが複数テナントに所属可**（agency が複数クライアント管理）。セッションは**1つの active tenant** にスコープ（tenant switcher）。

## 5. 認証フロー（既存を最小改修）
1. **magic-link verify**: email で magic-link → verify 時に **DB lookup**（users→memberships）。所属テナントを取得。複数なら最後に使った/既定の active tenant を選択。
2. **JWT 署名**: `tenant_id`(active) / `site_ids`(その tenant の tenant_sites) / **`role`(追加)** / sub / email を載せる（lib/jwt.ts に `role` 追加）。
3. **招待**: admin が email+tenant+role で `invitations` 発行 → 招待メール → 受諾で users+memberships 作成 → 以後 magic-link 成立。
4. **未招待 email**: magic-link は送るが verify で「所属なし」→ 案内ページ（情報漏洩しないエラー）。
5. **owner-login**: 既存維持（運用/障害時の back door、監査付き）。
6. **tenant 切替**: active tenant 変更 = JWT 再発行（`/api/auth/switch-tenant`、membership 検証必須）。

## 6. ロールとパーミッション
| role | 閲覧(dashboard/heatmap/fusion) | M-Agent介入/公開 | ユーザー招待/site管理 | 課金 |
|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | — |
| member | ✅ | ✅ | — | — |
| viewer | ✅ | — | — | — |
- middleware の route ACL に **role チェック追加**（例: viewer は scenarios publish 不可＝scenarios RBAC と整合）。JWT の `role` を参照。

## 7. テナント隔離（既存が効く・追加点のみ）
- 既に全 ClickHouse/KV クエリが `tenant_id` 強制＋middleware で cross-tenant を 403+audit。
- 追加: `canAccessSite()` は JWT の `site_ids` で判定済 → **DB の tenant_sites を JWT 発行時に反映**するだけ。
- DB（Postgres）クエリも全て `WHERE tenant_id=` を強制（新ドメインも §3.8.1 準拠）。

## 8. トラッカー / スニペット（多クライアントの肝）
- 各クライアントのサイトに置くスニペットは**そのテナントの tenant_id + site_id を送る**。
- 新規クライアントは**最初から正しいテナント**にデータが入る（再タグ不要）。
- プロビジョニング時に「テナント専用スニペット」を発行する画面/API（P2）。

## 9. wakegai 移行 runbook（P3・既存データの re-tenant）
1. `tenants` に `tnt_wakegai` ＋ `tenant_sites(tnt_wakegai, CIP_QWaPiks5krukJ6NM)`
2. **events 再タグ**（ClickHouse mutation・Owner/Infra 実行、AIはGRANT/破壊系外）:
   `ALTER TABLE events UPDATE tenant_id='tnt_wakegai' WHERE site_id='CIP_QWaPiks5krukJ6NM'`
   （`web_vitals` 等 site_id を持つ他表も同様に。`tenant_id` を持つ全表を棚卸し）
3. **融合5表 re-ingest**（新 tenant_id で build_crawl_export→ingest。私が一括実行可）＋旧 linkth_internal 分を削除 or 放置判断
4. **トラッカー snippet** を `tnt_wakegai` に更新（今後のデータが正しく入る）
5. wakegai 担当者を `users`＋`memberships(role=admin or viewer)` で招待
- ⚠ mutation 中は二重テナントで一時的に件数が割れる→**メンテ枠 or 低トラフィック時**に。順序厳守。

## 10. 後方互換 / 無停止移行
- P1 で **既存 dogfood-users を DB に seed**（linkth_internal + 5 sites + 既存 email）→ 現行ログインは無停止で DB 経路へ。
- `lib/auth/dogfood-users.ts` は **feature flag**（`USER_REGISTRY=db|hardcode`）で切替し、DB 経路を検証後にハードコード撤去。
- JWT `role` は**任意フィールド**で導入（未設定は member 相当）→ 旧 token も失効まで動く。

## 11. ロールバック
- USER_REGISTRY=hardcode に戻せば即旧挙動。
- events 再タグは**逆 mutation**で戻せる（`UPDATE tenant_id='linkth_internal' WHERE site_id=...`）。融合表は re-ingest で復元。
- Postgres 導入は additive（既存 KV/CH に影響なし）。

## 12. フェーズ
| P | 内容 | T |
|---|---|---|
| P1 | Postgres 導入 + スキーマ + magic-link DB化 + dogfood seed + JWT role | T1 |
| P2 | プロビジョニング（tenant作成/site割当/招待/スニペット発行）admin API+最小UI | T1 |
| P3 | wakegai を実テナント化（§9 runbook） | T1 |
| P4 | role別UI厳格化 + self-serve + Stripe 課金 + tenant switcher UI | T1/T2 |

## 13. セキュリティ（STRIDE-lite・threat-modeler で精査）
- **Spoofing**: magic-link token / invite token は hash 保存・短寿命・1回限り。JWT secret 厳格。
- **Tampering**: JWT 署名検証（既存）。tenant_id/role はサーバ署名のみ、client 改変不可。
- **Repudiation**: 招待/ログイン/tenant切替/role変更を audit_events に記録。
- **Info disclosure**: 未招待 email に所属を漏らさない。cross-tenant は 403。Postgres も tenant_id 強制。
- **DoS**: magic-link/invite に rate-limit（既存パターン流用）。
- **Elevation**: role 昇格は admin+ のみ・サーバ検証。membership 無いテナントの JWT 発行不可。

## 14. Owner 決定事項
1. **登録簿の保存先**: Postgres 導入で良いか（推奨）／ KV で通すか。
2. **wakegai 移行のメンテ枠**（events 再タグ実行タイミング）。
3. role の初期マトリクス（§6）で良いか。
4. P1 から着手して良いか（設計承認）。
