# 設計書: マルチテナント / マルチユーザー認証 (B = tenant-per-client) (2026-06-08)

> T1（認証 / テナント隔離 / データ移行）。**実装前に Codex dual review + threat-modeler(STRIDE)** を通すこと。
> 決定: wakegai は外部クライアント → **独立テナント (B)**。多クライアント・多ユーザー前提で最初から設計。

## 1. ゴール / 非ゴール
- ゴール: 外部クライアント（wakegai 等）が**自社テナントでログインし、自社データだけ**を管理画面で見られる。クライアント/ユーザーを**運用作業で追加**できる。
- 非ゴール(本書): セルフサインアップ / Stripe 課金連携 / SSO（将来 P4）。

## 2. 現状（9割は完成済み・足りない1割）
| 要素 | 状態 |
|---|---|
| JWT（`sub`=user_id / `email` / `tenant_id` / `plan` / `site_ids[]` / **`role`**） | ✅ multi-tenant aware。`role` は**既に実装済み**（`lib/jwt.ts:48` JWTPayload、verify route line 67 で発行、dogfood-users が保持）。**追加不要** |
| middleware（JWT検証＋テナント分離＋route ACL＋audit） | ✅ |
| `lib/tenant.ts`＋`canAccessSite()` / 全クエリ `tenant_id` 強制 | ✅ |
| magic-link メール認証 + owner-login + rate-limit + audit | ✅ |
| **user→tenant→site→role 登録簿** | 🔴 `lib/auth/dogfood-users.ts` に**ハードコード**（単一 `linkth_internal`+5 sites） |
| トランザクションDB | ⚠ **無し**（KV/Redis + ClickHouse のみ。Postgres は未導入） |
| **セッション寿命の一貫性** | 🔴 **不整合**: `verify/route.ts:77` は **4h** cookie、`lib/jwt.ts`/dev-login は **30d** (`SESSION_MAX_AGE_SECONDS`)。経路で寿命が割れている → `SESSION_MAX_AGE_SECONDS` に統一必須 |
| **セッション失効の手段** | 🔴 **無し**: 30d JWT + rolling refresh は失効パスが無い。role 剥奪/退会/テナント停止が**最大30日反映されない** |

→ 足りないのは「**登録簿の永続化 + プロビジョニング + セッション失効**」。認証メカニズムは作り直さない。

## 3. 最初の分岐: 登録簿の保存先
**決定 (2026-06-08 Owner)**: **Managed Postgres = Supabase**（Owner が既に利用・運用の慣れを優先）。
| 案 | 内容 | 評価 |
|---|---|---|
| **(採用) Managed Postgres = Supabase** | users/tenants/memberships/invitations を関係DBに。`citext` 拡張あり、将来 RLS で tenant 隔離を DB 層二重化可 | unique email・参照整合・トランザクション招待・関係クエリ・将来の課金/組織に最適。Owner 既存利用で学習コスト0 |
| KV-backed（scenarios と同じ） | KV キー設計＋手動 index | 新インフラ不要・一貫。だが unique制約/join/トランザクションを手で実装＝認証ドメインには脆い（不採用） |

### 3.1 Supabase 採用時の必須ガード（認証特有）
- **接続文字列の二系統**: アプリ(Vercel)→ **Pooler / Transaction mode (port 6543)**（サーバーレスは接続増減＝直結だと枯渇）。
  DDL/移行SQL → **Direct (port 5432)**。`lib/db` は pooler 前提で実装。
- **隔離**: 認証名簿は**専用 Supabase プロジェクト（or 専用スキーマ）**に置き爆発半径を分離。
- **常時稼働**: 無料枠の自動停止＝認証DB停止＝全ログイン不能（fail-closed）。wakegai 本番投入時は Pro 等で常時稼働。
- **secret**: `DATABASE_URL` は env のみ、コミット禁止（REQ-SEC-125）。接続失敗時 fail-closed。

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
1. **magic-link verify**: email で magic-link → verify 時に **DB lookup**（users→memberships）。所属テナントを取得。
   - 複数所属なら「最後に使った」hint は**クライアント値を信用せず**、サーバが membership を再検証して active tenant を確定（REQ-SEC-103）。
   - cookie 寿命は `SESSION_MAX_AGE_SECONDS` に**統一**（現状 4h → 30d。`verify/route.ts:77` の `maxAge` 修正）。
2. **JWT 署名**: `tenant_id`(active) / `site_ids`(その tenant の tenant_sites) / `role` / sub / email を載せる。**`role` は既に JWTPayload にあり追加不要**。新たに `session_version` / `membership_version` を載せて失効に使う（§13.5 REQ-SEC-101）。
3. **招待**: admin+ が email+tenant+role で `invitations` 発行 → 招待メール → 受諾で users+memberships 作成 → 以後 magic-link 成立。**招待 role ≤ 招待者 role**、owner 付与は owner のみ、招待者は対象テナントで admin+ 必須（REQ-SEC-106）。受諾は `invitations.email` と magic-link の email が**一致**する場合のみ（REQ-SEC-107）。
4. **未招待 email**: magic-link は送るが verify で「所属なし」→ 案内ページ（情報漏洩しないエラー）。
5. **owner-login**: 既存維持（運用/障害時の back door、監査付き）。
6. **tenant 切替**: active tenant 変更 = JWT 再発行（`/api/auth/switch-tenant`）。membership を**アトミックに検証**し、role/site_ids/plan を**切替先から再導出**（旧テナントの値を持ち越さない、REQ-SEC-115）。クライアント側の `sessionStorage`（`lib/auth.ts:25`）も切替時にクリア。

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

**順序が安全性を決める**。レビュー指摘により次の固定手順に統一（REQ-SEC-117 / -118 / -119）。

### 9.0 事前: tenant_id を持つ全表の棚卸し（REQ-SEC-119）
移行前に「`tenant_id` 列を持つ全 ClickHouse 表」を機械的に列挙（`system.columns WHERE name='tenant_id'`）。
**最低でも次を含む**（migrations から確認済み）:
- RUM/行動系: `events`, `sessions`, `behavior_signals`, `web_vitals`, `scroll_timeline`, `element_visibility_v2`, `image_visibility`, `form_interactions`, `video_events`
- 予測/ML系: `prediction_log`, `ml_session_outcome`, `user_outcomes`, `banner_decisions`, `persona_sessions`
- 融合5表: `crawl_runs`, `page_content_sections`, `page_performance`, `page_issues`, `section_behavior_summary`
- メタ/運用: `sites`, `audit_events`, `analysis_jobs`, `proposal_tickets`
- 棚卸し結果は移行チケットに添付。**1表でも漏らすと cross-tenant 残留**になる。

### 9.1 手順（順序厳守）
1. **アクセス遮断を先に**（REQ-SEC-117）: 旧 `linkth_internal` 側から当該 `site_id` への参照を**先に剥がす**
   （`tenant_sites` から該当 site を外す／seed を更新）。**mutation より前**に行い、移行中の二重所属＝
   cross-tenant 閲覧ウィンドウを作らない。
2. `tenants` に `tnt_wakegai` ＋ `tenant_sites(tnt_wakegai, CIP_QWaPiks5krukJ6NM)`
3. **全表 mutation**（ClickHouse・Owner/Infra 実行、AI は GRANT/破壊系外）。9.0 で棚卸しした
   **全表**に対し `site_id` 基準で `tenant_id` を更新:
   `ALTER TABLE <each> UPDATE tenant_id='tnt_wakegai' WHERE site_id='CIP_QWaPiks5krukJ6NM' SETTINGS mutations_sync=2`
4. **完了ゲート**（REQ-SEC-118）: `mutations_sync=2` で同期 or `system.mutations` を
   `is_done=1 AND latest_fail_reason=''` までポーリング。**全 mutation 完了を確認するまで次工程に進まない**。
   未完了のまま JWT を切替えると、行が二重テナントで見える。
5. **融合5表 re-ingest**（新 tenant_id で build_crawl_export→ingest。私が一括実行可）＋旧 linkth_internal 分を削除 or 放置判断
6. **トラッカー snippet** を `tnt_wakegai` に更新（今後のデータが正しく入る）
7. wakegai 担当者を `users`＋`memberships(role=admin or viewer)` で招待
- ⚠ mutation 中は二重テナントで一時的に件数が割れる→**メンテ枠 or 低トラフィック時**に。順序厳守。
- 検証: 移行後 `SELECT count() ... WHERE tenant_id='linkth_internal' AND site_id='CIP_QWaPiks5krukJ6NM'` が
  **全表で 0** であること（残留ゼロの証明）。

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

## 13.5 セキュリティ要件（受け入れ基準・dual review 統合）

> threat-modeler(STRIDE, 27脅威/6 CRITICAL) ＋ Codex review を統合した**ハード受け入れ基準**。
> P1〜P3 の各 PR は該当 REQ を満たすまでマージ不可（T1 dual review ゲート）。

### CRITICAL（実装前提・これが無いと「DB が真実」が虚構になる）
| ID | 要件 | 根拠/対象 |
|---|---|---|
| **REQ-SEC-101** | **セッション失効の確立**。JWT に `session_version`(user単位) ＋ `membership_version`(membership単位) を載せ、middleware が DB の現行 version と照合。role 剥奪/退会/テナント停止/パスワード相当イベントで version を増分 → 既存 JWT を即時無効化。30d JWT + rolling refresh のままでは失効不能（最大30日タイムラグ）。 | 30d JWT, lib/jwt.ts, middleware |
| **REQ-SEC-103** | **active tenant はサーバ検証**。verify/switch 時に「最後に使った」等クライアント hint を信用せず、membership を再検証して確定。 | verify route, switch-tenant |
| **REQ-SEC-106** | **招待の権限境界**。招待 role ≤ 招待者 role。owner 付与は owner のみ。招待者は対象テナントで admin+ 必須。サーバ検証。 | invitations API |
| **REQ-SEC-107** | **招待受諾の email 一致**。受諾時の認証 email が `invitations.email` と一致する場合のみ membership 作成。トークン奪取で別 email が昇格しない。 | invite accept |
| **REQ-SEC-115** | **テナント切替のアトミック再導出**。membership 検証と role/site_ids/plan の再導出を1トランザクションで。旧テナントの権限を**持ち越さない**。 | switch-tenant |
| **REQ-SEC-117** | **移行は遮断を先に**。wakegai 移行で旧 linkth_internal 側の site アクセスを mutation **前**に剥がす（cross-tenant 閲覧ウィンドウ防止）。 | §9.1 step1 |

### HIGH
| ID | 要件 | 根拠/対象 |
|---|---|---|
| **REQ-SEC-102** | `tenants.status='suspended'` を**認証時に強制**。停止テナントへの JWT 発行・既存 JWT 受理を拒否。 | verify, middleware |
| **REQ-SEC-104** | **Postgres も tenant スコープ強制**。auth ドメインの全クエリに `WHERE tenant_id=`（§3.8.1 を新ストアにも適用）。クロステナント read/write をコードで不能に。 | 新 Postgres 層 |
| **REQ-SEC-105** | **cookie 寿命の統一**。`verify/route.ts:77` の 4h を `SESSION_MAX_AGE_SECONDS` に統一。全発行経路（verify/dev-login/owner-login）で同一値。 | verify route |
| **REQ-SEC-112** | **role は検証済み JWT のみ由来**。`x-role` 等の注入ヘッダを信用しない。server-session.ts は tenant_id/user_id に加え **role も** 注入ヘッダ vs 検証 JWT を相互照合（現状 role 未照合）。 | server-session.ts:75 |
| **REQ-SEC-113** | **フェイルセーフな role 既定**。role 不明/解決失敗時は最小権限（viewer 相当）に倒す。未設定→owner のような昇格を作らない。 | jwt, route ACL |
| **REQ-SEC-116** | **owner-login back door の制限**。allowlist + 監査 + 短寿命。外部クライアント本番では env フラグで無効化可能に。 | owner-login |
| **REQ-SEC-118** | **移行完了ゲート**。`mutations_sync=2` or `system.mutations.is_done=1 AND latest_fail_reason=''` を確認するまで JWT 切替に進まない。 | §9.1 step4 |
| **REQ-SEC-119** | **tenant_id 全表棚卸し**。`system.columns WHERE name='tenant_id'` で機械列挙し移行対象を網羅（§9.0 リスト最低限）。 | §9.0 |
| **REQ-SEC-123** | **ハードコード default テナントの撤去**。外部クライアント投入前に保護パスの埋め込み default を除去: `app/api/scenarios/[id]/stats/route.ts:28`、AISEO fixtures、その他 `linkth_internal`/`wakegai`/`bihadashop` のフォールバック。seed のロールバック＝認可のロールバックである点を明記。 | scenarios stats, fixtures |

### MEDIUM
| ID | 要件 |
|---|---|
| **REQ-SEC-120** | invitations は token_hash 保存・短寿命・1回限り・use 時 DEL（magic-link と同パターン）。 |
| **REQ-SEC-121** | 招待/ログイン/tenant切替/role変更/移行 mutation を `audit_events` に記録（誰が・いつ・対象 tenant/user/role）。 |
| **REQ-SEC-122** | magic-link/invite に rate-limit（既存パターン流用）。email enumeration を返さない（未招待でも一律応答）。 |
| **REQ-SEC-124** | レジストリ抽象の統一。`dev-login` が `lookupDogfoodUser()` を直接呼ぶ経路を `USER_REGISTRY` 抽象に寄せ、DB 切替を1箇所に。 |
| **REQ-SEC-125** | Postgres 接続情報は env のみ（コミット禁止）。接続失敗時 fail-closed（認証を通さない）。 |

## 13.6 実装メモ: REQ-SEC-101 失効の二層化（middleware は edge 制約）

**制約**: `middleware.ts` は Next.js のデフォルト = **edge runtime**（`jose`/WebCrypto で JWT 署名検証）。
`pg`（TCP socket）は edge で動かない → **DB の version 照合を middleware に直書きできない**。

**P1 の決定（二層）**:
- **Layer 1（gate / edge / 既存）**: middleware は従来どおり JWT **署名＋exp** 検証＋tenant header inject。高速・無 DB。
- **Layer 2（authoritative / node）**: `getServerSession()`（node runtime）と verify/switch 経路で
  **DB の現行 `session_version`/`membership_version` と `tenants.status` を照合**。乖離/suspended は session を null（REQ-SEC-101/102）。

⚠ **Codex T1 で判明した限界（正確な現状）**: 失効が即時に効くのは **`getServerSession()` を呼ぶ経路だけ**。
実際には `lib/tenant.ts` 経由で **middleware 注入ヘッダ（x-tenant-id 等）から tenant context を取る
データ route（`app/api/pages`・`app/api/heatmap`・`app/api/chat` 等）が存在**し、これらは署名検証のみで
通過する＝**失効済み JWT でもデータを返しうる**。さらに middleware の rolling refresh は stale claim を
再署名して延命する。→ 「実データ層で即時に効く」は **getServerSession 経路に限る**（旧記述を訂正）。

実装フラグ: `USER_REGISTRY=hardcode|db`。`db` 時のみ Layer 2 の DB 照合を有効化。`hardcode` 既定で現行挙動を保持。

## 13.7 db モード本番投入ゲート（P1.5・Codex T1 で確定した必須前提）

P1 は **`USER_REGISTRY=hardcode` 既定＝本番無変更**でコミット済（Codex GO）。だが **`db` モードを本番で
有効化する前に**、以下を全て満たすこと（NO-GO 条件）。dogfood/ローカル検証は db モードで可。

| ID | ブロッカー | 状態 / 対応 |
|---|---|---|
| **REQ-SEC-126** | **header-route 失効バイパス**（最重要）: ヘッダ注入で tenant context を取る route が Layer 2 を通らない | ✅ **CLOSED (P1.5)**: `getTenantContext()`＋heatmap 3 route＋scenarios resolver を全て `getServerSession()` 経由に統一（Codex 検証済 CLOSED）。`getServerSession` に Bearer fallback も復元（operator curl 互換） |
| **REQ-SEC-127** | **middleware rolling refresh が stale claim を延命**（`middleware.ts`） | ✅ **CLOSED (P1.5)**: refresh を `USER_REGISTRY!=='db'` で gate＝db モードで無効化（Codex 検証済 CLOSED）。KV ミラー実装後（P2）に revalidation 付きで復活 |
| **REQ-SEC-128** | **旧トークン移行**: 切替時、version=0 の旧 JWT（古い site_ids/role 保持）が Layer 2 を通過 | ⏳ **cutover 手順**: `USER_REGISTRY=db` 切替と同時に **`JWT_SECRET` ローテーション**で全旧トークン失効（最も確実）。runbook 化 |
| **REQ-SEC-129** | **version bump 強制**: role/site 付与変更時に `membership_version` を必ず増分 | 🔧 **一部**: role 変更トリガ提供済（`...-p1b-version-triggers.sql`、cutover で適用）。site 付与変更（tenant_sites）時の当該テナント全 membership bump は **P2 admin API** で実装 |
| **REQ-SEC-130** | **TLS CA pin**: strict 検証で MITM 防御 | ✅ **CLOSED**: 公開 **Supabase Root 2021 CA** を `lib/db/supabase-ca.ts` に bundle し、`lib/db/postgres.ts` は既定で `rejectUnauthorized:true`＋CA pin（env 不要、実機で strict 接続 OK 確認済）。`AUTH_DATABASE_CA_CERT` は上書き用に残置 |

→ **P1.5 で REQ-SEC-126/127/130 を CLOSE**（コード対応完了）。残る **128（JWT_SECRET ローテ＝cutover 手順）/ 129-site（P2 admin API）**。
これらを満たして初めて `USER_REGISTRY=db` を本番投入。それまで本番は hardcode 固定（実害なし）。

## 14. Owner 決定事項
1. **登録簿の保存先**: ✅ **決定 = Supabase**（Owner 既存利用）。§3.1 の必須ガード（pooler/direct 二系統・専用プロジェクト隔離・常時稼働・secret env-only）を遵守。
2. **wakegai 移行のメンテ枠**（events 再タグ実行タイミング、§9 runbook）。低トラフィック枠で順序厳守。
3. role の初期マトリクス（§6）で良いか。
4. **P1 着手承認**。P1 の受け入れ基準に **REQ-SEC-101/103/105/112/113** を含める（セッション失効＋cookie統一＋role検証）。
5. **wakegai 本番投入の前提**として REQ-SEC-123（ハードコード default 撤去）を完了させる方針で良いか。

---
### 付録: dual review 統合サマリ（2026-06-08）
- **threat-modeler**: 27脅威（CRITICAL 6 = REQ-SEC-101/103/106/107/115/117）。キーストーン = 「30d JWT + rolling refresh は失効不能 → DB が真実という前提が虚構」。
- **Codex**: Postgres 採用は妥当（KV 前例の scenarios は手動スコープ・制約なしで認証には脆い）。**role は既に実装済**（doc §2/§5 の「追加が必要」は誤り→修正済）。cookie が verify=4h / jwt=30d で割れている→統一必須。session/membership version で失効を、移行は `mutations_sync=2`＋全表棚卸しで安全に。外部投入前にハードコード default を撤去。
