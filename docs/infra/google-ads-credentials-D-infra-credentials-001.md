# D-infra-credentials-001 — Google Ads OAuth 認証情報配置 設計

**起票**: Infrastructure Engineer
**発行日**: 2026-05-17
**期限**: Sprint 1 着工 1 週間前 (= 2026-05-23 を目安、Director 2026-05-17 (朝) F-24b ESC-2 起票)
**起点**: linkscrawl/docs/fusion/team/decisions.md L55-L62 (Director F-24b ESC-2 (2-C) Infra エスカレ判断)
**読者**: Director / ML Programmer (F-24b topic_cluster_agent 担当) / Reviewer / Owner

---

## 1. 目的 / 範囲

F-24b「Topic Cluster Analysis Agent」prototype が **Google Ads Keyword Planner API** を Step 2 (Multi-source KW Expansion) で使う。同 API は OAuth 2.0 認証 + developer_token 保持が必須。**認証情報の中央管理 + 権限分離 + rotation 手順 + Sentry エラー検知 ルートを Infrastructure Engineer が確定する。**

### スコープ in

- 認証情報 (Service Account JSON / OAuth refresh token / developer_token) の **配置場所 + 読込経路**
- 環境変数命名規約 (`GOOGLE_APPLICATION_CREDENTIALS` 系)
- secret rotation 手順 (90 日毎、または流出疑い時)
- Sentry へ認証エラーを送信するルール (誤って token を含めない beforeSend)
- `~/.codex/` と同水準の権限分離 (chmod 600 / OS ACL)
- linkscrawl + mini-saas + ugokimap-saas 各リポジトリからの参照経路

### スコープ out (別 doc / 別 PR)

- Google Ads API クライアントの実装コード (ML Programmer 領域、`topic_cluster_agent.py` 内)
- Customer ID 主 / 副の運用切替判断 (Director / Owner 経営判断)
- linkscrawl 既存 Google Vision / Sheets / GA4 OAuth との統合 (別 doc、`skil_agent/credentials/README.md` で総覧予定)

---

## 2. 確定情報 (Director 2026-05-17 (朝) ESC-2 (2-C) より)

| 項目 | 値 | 出典 |
|---|---|---|
| customer_id 主 | `562-089-1601` | Director 起票、Owner 提供 |
| customer_id 副 | `901-901-3900` | 同上 |
| OAuth Google account | `hiroki101313@gmail.com` | 同上 |
| 配置先 (中央) | `skil_agent/credentials/` 配下 | Director 推奨配置 (mini-saas Director 推奨と整合) |
| env 参照規約 | `GOOGLE_APPLICATION_CREDENTIALS` + 用途別 env | 本書 §4 で詳述 |
| 期限 | Sprint 1 着工 1 週間前 (2026-05-23) | Director ESC-2 |

未確定 (本書発行時点):
- **developer_token**: Google Ads API console → API Center で発行、Owner / Marketer が取得 (~1-3 日)
- **OAuth client_id / client_secret**: Google Cloud Console → OAuth consent screen → desktop app タイプで Infra が発行 (~30 分)
- **refresh_token**: `gcloud auth application-default login` または `google-ads-python` 例コード経由で取得 (~5 分)

---

## 3. 認証情報の種類と分離

Google Ads API を Python から叩く場合、4 つの認証情報を持つ:

| # | 種類 | 値の性質 | リーク影響 |
|---|---|---|---|
| 1 | **developer_token** | 文字列 (固定、長期) | Google Ads API 全 customer_id 取得可、最高機密 |
| 2 | **client_id** | UUID 風 (固定、長期) | OAuth flow の入口、単独でリーク危険度は中 |
| 3 | **client_secret** | 文字列 (固定、長期) | client_id とセットでリーク → OAuth 偽装可 |
| 4 | **refresh_token** | 長文字列 (失効可、user 毎) | アクセストークン無制限取得 (24h ごと) → リーク = customer_id データ全取得可、最高機密 |

加えて linkscrawl 既存:
- Service Account JSON (Google Vision / Sheets) — `skil_agent/credentials/<project>-sa.json`
- → **本件と別ファイル / 別キー**、`GOOGLE_APPLICATION_CREDENTIALS` 切替で運用

---

## 4. 配置設計

### 4.1 ディレクトリレイアウト (skil_agent/credentials/ 配下)

```
skil_agent/credentials/
├── README.md                              # 認証情報インデックス (個別の用途 + env 変数名対応表、secrets は書かない)
├── .gitignore                             # *.json *.yaml *.env を全て deny (二重防御)
├── google-ads/
│   ├── client_secrets.json                # OAuth client (client_id + client_secret)
│   ├── refresh_token.json                 # {"refresh_token": "...", "user_email": "hiroki101313@gmail.com"}
│   └── developer_token.txt                # developer_token のみ 1 行 (改行 LF 終端)
├── google-vision/                         # 既存、本件は触らない
│   └── ...-sa.json
└── google-sheets/                         # 既存、本件は触らない
    └── ...-sa.json
```

**ファイル権限** (`~/.codex/` 同水準、本書 §6 で詳述):
- ディレクトリ: `chmod 700`
- ファイル: `chmod 600`
- Windows: NTFS ACL で `Users` group の Read/Execute を削除、所有者のみ Full Control

### 4.2 env 変数命名規約

`linkscrawl/.env` (Hetzner 配下) + `linkscrawl/.env.local` (開発機):

```ini
# ──────────────────────────────────────────────────
# Google Ads API (F-24b topic_cluster_agent, D-infra-credentials-001)
# ──────────────────────────────────────────────────
GOOGLE_ADS_DEVELOPER_TOKEN_FILE=~/skil_agent/credentials/google-ads/developer_token.txt
GOOGLE_ADS_CLIENT_SECRETS_FILE=~/skil_agent/credentials/google-ads/client_secrets.json
GOOGLE_ADS_REFRESH_TOKEN_FILE=~/skil_agent/credentials/google-ads/refresh_token.json

# Customer IDs (Owner 確定、Director ESC-2 起票)
GOOGLE_ADS_CUSTOMER_ID_PRIMARY=5620891601    # 主、ハイフン無し (API 期待形式)
GOOGLE_ADS_CUSTOMER_ID_SECONDARY=9019013900  # 副 (フェイルオーバー用、Phase 1 では未使用)
GOOGLE_ADS_USER_EMAIL=hiroki101313@gmail.com

# Provider switch (Phase 2 拡張で Ahrefs 等が加わった時のための抽象 layer)
KEYWORD_PROVIDER=google_ads,dataforseo       # 優先順序 (Step 2 ESC-2 設計 KeywordSourceClient interface)
```

**重要**: `GOOGLE_APPLICATION_CREDENTIALS` は **Vision / Sheets 専用** (既存運用) として残し、Google Ads は別 env 群で扱う。理由:
- `GOOGLE_APPLICATION_CREDENTIALS` は Service Account JSON 1 本のみ参照、OAuth Desktop の 3 ファイル構成と互換性なし
- linkscrawl 内で同時に Vision + Ads を叩くケースがあり、env を共有すると競合
- `google-ads-python` library は `ads.load_from_storage(path=...)` で個別 YAML を要求 → 別 env で渡すのが自然

### 4.3 ads.yaml (Python google-ads-python 用、生成方式)

`google-ads-python` library は `ads.yaml` を読む経路もある。本書は **個別 env 渡しを正** とし、ads.yaml は使わない:

```python
# OK (本書採用、env 経由):
from google.ads.googleads.client import GoogleAdsClient
client = GoogleAdsClient.load_from_dict({
    "developer_token": Path(os.environ["GOOGLE_ADS_DEVELOPER_TOKEN_FILE"]).read_text().strip(),
    "client_id":       json.load(open(os.environ["GOOGLE_ADS_CLIENT_SECRETS_FILE"]))["installed"]["client_id"],
    "client_secret":   json.load(open(os.environ["GOOGLE_ADS_CLIENT_SECRETS_FILE"]))["installed"]["client_secret"],
    "refresh_token":   json.load(open(os.environ["GOOGLE_ADS_REFRESH_TOKEN_FILE"]))["refresh_token"],
    "use_proto_plus":  True,
    "login_customer_id": os.environ["GOOGLE_ADS_CUSTOMER_ID_PRIMARY"],
})

# 不採用 (ads.yaml 経由):
client = GoogleAdsClient.load_from_storage(path="~/google-ads.yaml")
```

理由:
- 単一 YAML だと secret rotation 時に全項目を 1 ファイルで触る → diff レビューが面倒
- env 個別なら refresh_token のみ rotate して他は不変 → 監査ログ短い

---

## 5. Secret Rotation 手順

### 5.1 通常 rotation (90 日毎、定期)

Cron / リマインダ起動:

```bash
# 1. 新 refresh_token を取得
cd ~/skil_agent/credentials/google-ads/
python -m google_ads.oauth_get_refresh_token \
    --client-secrets-file client_secrets.json \
    --user-email hiroki101313@gmail.com \
    > refresh_token.new.json

# 2. 動作確認 (新 token で Customer 一覧取得)
GOOGLE_ADS_REFRESH_TOKEN_FILE=$(pwd)/refresh_token.new.json \
  python -c "from google.ads.googleads.client import GoogleAdsClient; ..."

# 3. 確認 OK → 旧 token を archive、新 token を本番に昇格
mv refresh_token.json refresh_token.archive-$(date +%Y%m%d).json
mv refresh_token.new.json refresh_token.json
chmod 600 refresh_token.json

# 4. 旧 token を Google OAuth Console で revoke (https://myaccount.google.com/permissions)

# 5. decisions.md [→Infra][→Director] タグで「Google Ads refresh_token rotation 完了 (YYYY-MM-DD)」追記
```

### 5.2 緊急 rotation (流出疑い時、即時)

1. **即時 revoke**: https://myaccount.google.com/permissions → "Google Ads API" を Remove access (旧 token 全失効)
2. linkscrawl / mini-saas の cron job を停止 (`systemctl stop topic-cluster-agent.timer` or 該当)
3. 新 refresh_token を §5.1 手順で発行 (動作確認なしで本番化)
4. Sentry / decisions.md / Owner に同時通知 ([→Owner][→Director][→Reviewer] タグ)
5. アクセスログ調査: Google Cloud Audit Logs → IAM Service Account Usage で 過去 30 日の API call 件数を確認、異常増があれば customer_id 副への切替判断
6. 流出経路特定: git 履歴 / commit / Sentry attachments / Slack DM 等を grep

### 5.3 client_id / client_secret rotation (年次 or 流出時)

OAuth Client 全体を rotate:
1. Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs → Add credentials
2. 新 client_secrets.json を発行、`skil_agent/credentials/google-ads/` に配置 (旧は archive)
3. 新 client で refresh_token を取得し直す (§5.1)
4. 旧 client を Delete

### 5.4 developer_token rotation (Google 側都合 + 流出時のみ)

developer_token は **基本不変** (Google が rotate を要請するケースは稀)。流出時のみ:
1. Google Ads API Center → API Access → Generate new developer token (旧は failed リクエスト時に Google support 経由で revoke 申請、self-service rotate 不可)
2. 完了まで 1-3 営業日 → その間 Phase 1 prototype 停止 (代替 DataForSEO のみで Step 2 を回す degraded mode を Director に提案)

---

## 6. 権限分離 (`~/.codex/` 同水準)

### 6.0 OAuth scope (F-1 Reviewer T1 dual 2026-05-17 (深夜) 指摘で追記)

**Google Ads API OAuth scope は `https://www.googleapis.com/auth/adwords` 1 件のみ** (read/write 一本、read-only scope は実在しない)。

出典: https://developers.google.com/google-ads/api/docs/oauth/internals (Google 公式)。

**Phase 1 運用ルール**:
- `oauth_get_refresh_token.py` の `SCOPES` 定数は `["https://www.googleapis.com/auth/adwords"]` 固定 (本書 §1.4 参照)
- Phase 1 prototype では **read 用途のみ使用** (Keyword Planner API の検索ボリューム / CPC 等の取得)
- **書込 API (CampaignService / AdGroupAdService 等) の呼出は禁止**
- ML Programmer 実装側 (`linkscrawl/ml/fusion/topic_cluster_agent.py` / `linkscrawl/serp/google_ads_client.py`) で **read-only assertion** を init 時に強制:

```python
# linkscrawl/serp/google_ads_client.py (Phase 1 で新規実装、本書時点では未着工)
READ_ONLY_SERVICES = {
    "KeywordPlanIdeaService",      # キーワード提案
    "GoogleAdsService",            # GAQL SELECT のみ
    "CustomerService",             # 顧客情報読取
    # 書込系 (CampaignService / AdGroupAdService / AdService 等) は本リストに含めない
}

def _assert_read_only(service_name: str) -> None:
    """Phase 1 で書込 API 誤呼出を防ぐ assertion。違反は ValueError で即停止"""
    if service_name not in READ_ONLY_SERVICES:
        raise ValueError(
            f"Phase 1 では書込 API {service_name} の呼出は禁止。"
            f"Phase 2 で運用設計再検討後に解禁。"
            f"許可サービス: {sorted(READ_ONLY_SERVICES)}"
        )

class GoogleAdsClientWrapper:
    def get_service(self, service_name: str):
        _assert_read_only(service_name)   # 書込誤呼出を init 時に拒否
        return self._client.get_service(service_name)
```

**Sprint 2 解禁後の F-24b 実装で本 wrapper 経由を必須とし、`client.get_service` 直接呼出は禁止** (Reviewer T1 dual 投入対象に追加、Sprint 2-3 ML Programmer 着工時)。

### 6.1 OS 権限 (Hetzner Linux + Windows 開発機)

**Linux (Hetzner)**:
```bash
chmod 700 ~/skil_agent/credentials/                     # ディレクトリ
chmod 700 ~/skil_agent/credentials/google-ads/          # サブディレクトリ
chmod 600 ~/skil_agent/credentials/google-ads/*.json    # ファイル
chmod 600 ~/skil_agent/credentials/google-ads/*.txt
chown -R $USER:$USER ~/skil_agent/credentials/
```

確認:
```bash
namei -m ~/skil_agent/credentials/google-ads/refresh_token.json
# 全 path component が rwx------ または rw------- で所有者一致を確認
```

**Windows (開発機 + ローカルテスト)**:
- `~/skil_agent/credentials/` を NTFS で:
  - `Users` group の `Read & Execute` を削除
  - 所有者 (`M2603`) のみ Full Control
- 確認: PowerShell `Get-Acl ~/skil_agent/credentials/google-ads/refresh_token.json | Format-List`

### 6.2 アプリケーション権限分離

linkscrawl プロセスは Hetzner 上で `linkscrawl` ユーザーで動作。`skil_agent/credentials/` の owner は同一 (`linkscrawl`) にする:

```bash
# Hetzner 上 (root で 1 回)
useradd -m skil_agent
mkdir -p /home/skil_agent/credentials
# linkscrawl ユーザーから読めるよう symlink
ln -s /home/skil_agent/credentials /home/linkscrawl/skil_agent_credentials
chown -h linkscrawl:linkscrawl /home/linkscrawl/skil_agent_credentials
```

または、より単純: `skil_agent` ユーザーは作らず、`linkscrawl` ユーザーの `~/skil_agent/credentials/` 配下に直接配置 (Phase 1 の単一サービスなら簡素化可)。

### 6.3 git 二重防御

`skil_agent/credentials/.gitignore`:
```
# Deny by default
*

# Allow only README.md and .gitignore itself
!README.md
!.gitignore
```

`linkscrawl/.gitignore` + `ugokimap-saas/.gitignore` + `mini-saas/.gitignore` に追加:
```
# Google Ads credentials (D-infra-credentials-001)
**/skil_agent/credentials/**
*ads.yaml
google-ads*.json
```

pre-commit hook (Sprint 1 で配備予定): `secretlint` で `private_key` / `refresh_token` / `client_secret` を全 PR で検査。

---

## 7. Sentry 認証エラー検知ルール

### 7.1 送信ルール

Google Ads API のエラーは Sentry に送るが、**認証情報を含めない**:

```python
# linkscrawl/serp/google_ads_client.py (Phase 1 で新規実装、本書時点では未着工)
import sentry_sdk
from google.ads.googleads.errors import GoogleAdsException

try:
    response = service.search(customer_id=customer_id, query=gaql_query)
except GoogleAdsException as ex:
    # Sentry に送る (ただし token は絶対に含めない)
    sentry_sdk.set_context("google_ads", {
        "customer_id": customer_id,      # PII ではない、Owner 共有済
        "request_id": ex.request_id,
        "error_code": ex.failure.errors[0].error_code if ex.failure else None,
        "error_message": ex.failure.errors[0].message[:200] if ex.failure else None,
        # ❌ NEVER: developer_token / refresh_token / client_secret
    })
    sentry_sdk.capture_exception(ex)
    raise
```

### 7.2 sentry beforeSend ガード (二重防御)

linkscrawl / ugokimap-saas の sentry.{client,server,edge}.config.ts (既に Infra §3.2.4 で配備済):

```typescript
// 本書追加分: Google Ads credentials が誤って event に混入した場合の最終フィルタ
beforeSend(event) {
  const SECRET_PATTERNS = [
    /refresh_token/i,
    /developer_token/i,
    /client_secret/i,
    /access_token/i,
    /-----BEGIN\s+PRIVATE\s+KEY-----/,
    /AIza[0-9A-Za-z-_]{35}/,             // Google API key 風文字列
    /1\/\/0[0-9A-Za-z-_]{60,}/,          // Google refresh_token 風
  ]
  const json = JSON.stringify(event)
  if (SECRET_PATTERNS.some((re) => re.test(json))) {
    // Sentry には送らない、代わりに alert 送信
    console.error('[SECRET-LEAK-GUARD] Sentry event contained secret-like pattern, suppressed')
    return null   // event 破棄
  }
  // ... 既存 PII REDACT ロジック ...
  return event
}
```

ugokimap-saas/sentry.{client,server,edge}.config.ts を本書受領後に Infra が更新。

### 7.3 Sentry 認証エラー alert ルール

Sentry UI / Settings → Alerts → New Alert Rule:
- **Condition**: `event.exception.values[0].type` contains `GoogleAdsAuthenticationError` OR `RefreshError`
- **Notification**: Slack `#infra-alerts` (頻度 throttle: 1 件/15 分)
- **Tag filter**: `release` starts with `ugokimap-saas@` または `linkscrawl@`

---

## 8. 完了基準

| # | 項目 | 検証方法 | 期限 |
|---|---|---|---|
| 1 | Owner / Marketer が developer_token を取得 | console.cloud.google.com で発行確認、`developer_token.txt` 配置 | Sprint 1 着工 1 週間前 (2026-05-23) |
| 2 | Infra が OAuth client_secrets.json を発行 + 配置 | Google Cloud Console で client 登録、`client_secrets.json` 配置 | 同上 |
| 3 | refresh_token を取得 + 配置 | OAuth flow 実行、`refresh_token.json` 配置 + 動作確認 (`GoogleAdsClient.load_from_dict` で Customer 一覧取得 1 回成功) | 同上 |
| 4 | `skil_agent/credentials/` 全 chmod 600 / 700 適用、.gitignore 配備 | `find skil_agent/credentials -perm /077` → 0 件、`git status` 上で credentials/ 内ファイル untracked であること | 同上 |
| 5 | linkscrawl/.env + Sentry beforeSend SECRET ガード配備 | env var 4 件追加、sentry.config.ts に SECRET_PATTERNS ガード追記 | 同上 |
| 6 | Sentry alert ルール設定 | Sentry UI で Alert Rule 1 件作成、test event で Slack 通知到達確認 | 同上 |
| 7 | linkscrawl/docs/fusion/team/decisions.md [→Director][→ML Programmer] タグで完了報告 | 「D-infra-credentials-001 完了、ML Programmer F-24b 着工可能」を起票 | 同上 |

---

## 9. リスクと未決事項

| # | リスク | 緩和 |
|---|---|---|
| R1 | refresh_token が期限切れ (Google が 6 ヶ月間使われないと revoke) | cron で月次に Customer 一覧取得 dry-run、§5.1 rotation を 90 日に短縮 |
| R2 | developer_token 流出時の self-service rotate 不可 | §5.4、流出時は DataForSEO 単独で degraded mode、Google support 申請を並行 |
| R3 | Hetzner OS user 構成変更時に chmod が消える | `~/skil_agent/credentials/restore_permissions.sh` (idempotent) を配備、systemd timer で日次実行 |
| R4 | Sentry beforeSend のパターンが新形式 secret に追従できない / leaked token canary 監視なし (F-1 Reviewer T1 dual 2026-05-17 (深夜) 指摘で具体化) | 多層防御: <br> **(a) Sprint 3 配備**: `secretlint` rules を `sentry.shared.ts` SECRET_PATTERNS と統一 (SSOT 化)、pre-commit で誤コミット捕捉 <br> **(b) Sprint 3 配備**: Google Cloud Audit Logs alert (`google.ads.googleads.v17.services.GoogleAdsService.SearchStream` 等の異常 API usage 監視)、Slack `#infra-alerts` に throttle 1 件/30 分で通知。設定先 = Google Cloud Console → Logging → Logs-based Metrics → Alerting Policy。alert 条件: <br>   - 1 時間あたり API call 件数が直近 7 日平均 × 3 倍超 <br>   - 401 / 403 / `PERMISSION_DENIED` エラー連続 5 件超 <br>   - 想定外 customer_id (5620891601 / 9019013900 以外) 検出 <br> **(c) Phase 2 配備**: Sentry alert ルール (本書 §7.3) と GCP Audit Logs alert を Slack 共通チャンネルで観測、運用 SOP 化 (incident response playbook) |
| R5 | mini-saas / linkscrawl / ugokimap-saas で env 命名が分かれて運用混乱 | 本書を SSOT、3 リポジトリの `.env.example` に同 env 群を必ず列挙 (PR で同期確認) |

---

## 10. 改訂履歴

| ver | date | author | 概要 |
|---|---|---|---|
| 0.1 | 2026-05-17 | Infrastructure Engineer | 初版起票 (Director F-24b ESC-2 (2-C) 起点、Sprint 1 着工 1 週間前期限) |
