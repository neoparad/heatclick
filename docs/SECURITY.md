# UGOKI MAP - セキュリティ・プライバシー対応状況

最終更新: 2026-03-17

## 対応済み

### プライバシー保護
| 対策 | 実装 | 内容 |
|------|------|------|
| IP匿名化 | `lib/privacy.ts` | IPv4末尾オクテット→0、IPv6末尾64bit→0 |
| PII自動マスク | `tracking.js sanitizePII()` | メール→[EMAIL]、カード番号→[CARD]、電話→[PHONE]、郵便番号→[ZIP] |
| URL内機密パラメータ除去 | `tracking.js sanitizeUrl()` | email, token, password, card等のパラメータを[REDACTED]に置換 |
| フォーム入力値の非収集 | `tracking.js` | field_filled(0/1)のみ記録、入力値自体は収集しない |
| セッション録画のinputマスク | `recording.js` | `maskAllInputs: true`で全input要素をマスク |
| 録画ブロック指定 | `recording.js` | `data-no-record`属性、`rr-block`クラスで除外可能 |
| オプトアウト | `tracking.js` | `localStorage: clickinsight_optout=true`で全トラッキング停止 |
| Cookie同意対応 | `tracking.js` | `requireConsent`設定時、同意なしではトラッキングしない |

### セキュリティ対策
| 対策 | 実装 | 内容 |
|------|------|------|
| SSRF防御 | `/api/proxy-page` | プロトコル制限(http/https) + プライベートIP・メタデータサーバーのブロック |
| 情報漏洩防止 | `/api/health` | DB接続情報・環境変数・デバッグ情報を全て削除 |
| DB初期化の認証 | `/api/init-database` | INIT_SECRET環境変数によるBearer認証（開発環境のみスキップ） |
| レート制限 | `/api/track`, `/api/recordings` | IP匿名化済み、100リクエスト/15分 |
| 録画データサイズ制限 | `/api/recordings` | 1バッチ5MB上限 |
| CORS | `/api/track` 等 | Originヘッダー反映、Credentials対応 |

## 残存リスク

### P0 - 認証基盤（高優先度）
| リスク | 内容 | 対応方針 |
|--------|------|----------|
| クライアントサイド認証のみ | sessionStorageを書き換えるだけでログイン偽装可能 | JWT + サーバーサイドセッション検証の実装 |
| マルチテナント未実装 | 全サイトデータが全ユーザーに見える | 全APIにuser_id/org_idフィルタ追加 |

### P1 - アクセス制御（中優先度）
| リスク | 内容 | 対応方針 |
|--------|------|----------|
| 一部APIにレート制限なし | /api/heatmap, /api/sites等に未適用 | 全公開エンドポイントに適用 |
| /api/sitesの認可なし | 全サイト一覧が認証なしで取得可能 | 認証必須化 + org_idフィルタ |

### P2 - GDPR準拠（将来対応）
| リスク | 内容 | 対応方針 |
|--------|------|----------|
| データ削除機能なし | ユーザーの「忘れられる権利」に未対応 | user_id指定の全データ削除API |
| データエクスポート機能なし | ユーザーのデータポータビリティ権に未対応 | user_id指定のデータエクスポートAPI |
| 自動データ保持期限なし | 古いデータが無期限に残る | ClickHouse TTL設定（例: 2年） |
| データ処理契約(DPA)テンプレートなし | クライアント提供時に必要 | 法務と連携してDPA作成 |
