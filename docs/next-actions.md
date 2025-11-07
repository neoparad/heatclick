# 次のアクション - ClickInsight Pro

最終更新: 2025年1月25日

## 🎯 今すぐできること (Quick Wins)

### 1. データベース統合の実装
**所要時間**: 2-3時間
**優先度**: 高

**アクション:**
- [ ] ClickHouse接続の実装
- [ ] Redisキャッシュの設定
- [ ] データ永続化の実装
- [ ] 本番環境でのデータベース設定

**実装ファイル:**
- `lib/clickhouse.ts` - ClickHouse接続
- `lib/redis.ts` - Redis接続
- `app/api/track/route.ts` - データベース統合

---

### 2. 外部API連携の実装
**所要時間**: 3-4時間
**優先度**: 高

**アクション:**
- [ ] Google Search Console API連携
- [ ] Google Ads API連携
- [ ] Claude API統合
- [ ] 実際のデータ取得機能

**実装ファイル:**
- `lib/gsc.ts` - GSC API連携
- `lib/google-ads.ts` - Google Ads API連携
- `lib/claude.ts` - Claude API統合

---

### 3. 本番環境デプロイ
**所要時間**: 1-2時間
**優先度**: 高

**アクション:**
- [ ] Vercelプロジェクトの作成
- [ ] 環境変数の設定
- [ ] ドメインの設定
- [ ] 本番環境でのテスト

**コマンド:**
```bash
npm run dev
# http://localhost:3000 にアクセス
```

---

## 📅 今週のタスク (This Week)

### Week 1: プロジェクト基盤整備

#### Day 1-2: 環境構築
- [x] docsフォルダの作成
- [x] プロジェクト管理ドキュメント作成
- [ ] ClickHouseのローカル環境構築（Docker）
- [ ] Redisのローカル環境構築（Docker）
- [ ] 環境変数の設定

**参考コマンド:**
```bash
# Docker Composeでローカル環境構築
docker-compose up -d clickhouse redis
```

#### Day 3-4: コア機能実装開始
- [ ] トラッキングスクリプトの骨組み作成
- [ ] イベントデータモデルの定義
- [ ] API Routeの基本構造作成
  - `/api/track` - イベント受信
  - `/api/heatmap` - ヒートマップデータ取得

#### Day 5-7: UI/UX基礎
- [ ] ダッシュボードレイアウト作成
- [ ] ヒートマップ表示コンポーネント（基本）
- [ ] サイト選択UIの実装

---

## 🚀 今月のマイルストーン (This Month)

### マイルストーン 1: MVP開発開始準備完了
**期限**: 2025年11月10日

**タスク:**
- [ ] ローカル開発環境完全構築
- [ ] データベーススキーマ設計完了
- [ ] トラッキングスクリプト v0.1 完成
- [ ] 基本的なAPI Routes実装
- [ ] シンプルなダッシュボードUI

---

### マイルストーン 2: 基本機能実装
**期限**: 2025年11月30日

**タスク:**
- [ ] クリックヒートマップ表示機能
- [ ] スクロールヒートマップ表示機能
- [ ] イベントデータの保存と取得
- [ ] 基本的な認証機能

---

## 💡 アイデア・TODO

### 技術検証が必要な項目
- [ ] ClickHouseでの大量データ書き込みパフォーマンステスト
- [ ] heatmap.jsのカスタマイズ可能性調査
- [ ] Vercel Edge Functionsでのリアルタイム処理実験

### ドキュメント作成
- [ ] データベース設計書
- [ ] API仕様書（OpenAPI/Swagger）
- [ ] トラッキングスクリプト利用ガイド
- [ ] セキュリティ・プライバシーポリシー

### リサーチ項目
- [ ] 競合サービス（Clarity, Hotjar等）の機能調査
- [ ] ヒートマップの可視化手法のベストプラクティス
- [ ] GDPR/個人情報保護法対応の要件確認

---

## 🔧 開発環境セットアップ手順

### ステップ1: Docker環境構築

**docker-compose.yml 作成:**
```yaml
version: '3.8'
services:
  clickhouse:
    image: clickhouse/clickhouse-server:latest
    ports:
      - "8123:8123"
      - "9000:9000"
    volumes:
      - clickhouse_data:/var/lib/clickhouse
    environment:
      CLICKHOUSE_DB: clickinsight
      CLICKHOUSE_USER: admin
      CLICKHOUSE_PASSWORD: password

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  clickhouse_data:
  redis_data:
```

**実行コマンド:**
```bash
docker-compose up -d
docker-compose ps  # 起動確認
```

---

### ステップ2: ClickHouseスキーマ作成

**接続コマンド:**
```bash
docker exec -it clickhouse_container clickhouse-client
```

**初期スキーマ（例）:**
```sql
CREATE DATABASE IF NOT EXISTS clickinsight;

CREATE TABLE IF NOT EXISTS clickinsight.events (
    event_id UUID,
    site_id String,
    session_id String,
    user_id Nullable(String),
    event_type String,
    timestamp DateTime64(3),
    url String,
    element_selector Nullable(String),
    x Nullable(UInt16),
    y Nullable(UInt16),
    viewport_width UInt16,
    viewport_height UInt16,
    user_agent String,
    ip_address String,
    metadata String
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (site_id, timestamp);
```

---

### ステップ3: Next.js設定

**.env.local 設定例:**
```env
# Database
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=admin
CLICKHOUSE_PASSWORD=password
CLICKHOUSE_DATABASE=clickinsight

# Redis
REDIS_URL=redis://localhost:6379

# Claude API
CLAUDE_API_KEY=your_claude_api_key_here

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
NODE_ENV=development
```

---

## 📊 進捗トラッキング

### 今週の進捗（2025-10-21 〜 2025-10-27）
- ✅ docsフォルダ作成
- ✅ プロジェクト管理ドキュメント整備
- ⬜ ClickHouseローカル環境構築
- ⬜ トラッキングスクリプト実装開始

### 完了率
**全体**: 2/4 (50%)

---

## 🎯 次回レビュー予定

**日時**: 2025年11月1日
**レビュー項目:**
- プロジェクト進捗確認
- 課題の再評価
- 次月の計画策定

---

## 📝 メモ

### 2025-10-25
- プロジェクト管理ドキュメントを整備
- 課題管理システムを導入
- 次のアクションを明確化

### 今後追加予定のメモ
- 技術的な気づき
- 実装上の注意点
- 参考になったリソース
