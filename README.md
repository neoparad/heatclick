# ClickInsight Pro

ヒートマップ＆クリック分析ツール - AIによる自動診断と改善提案を行う次世代SEO特化型ツール

## 🚀 概要

ClickInsight Proは、WordPressサイトを中心としたWebサイトのクリック行動とヒートマップを可視化・分析し、AI（Claude API）による自動診断と改善提案を行う次世代SEO特化型ヒートマップツールです。

## ✨ 主要機能

### 🎯 トラッキング機能
- 超軽量トラッキングスクリプト（≤5KB）
- 詳細イベント記録（クリック、スクロール、ホバー等）
- エラー追跡・分析

### 🔥 ヒートマップ機能
- クリックヒートマップ
- スクロールヒートマップ
- アテンションヒートマップ
- 独自ヒートマップ（コピー、エラー、CV比較等）

### 🤖 AI分析機能
- Claude API統合による自動分析
- 改善提案の自動生成
- リアルタイムアラート

### 🔗 外部連携
- Google Search Console API
- Google Ads API
- Google Analytics 4
- WordPress連携

## 🛠 技術スタック

### フロントエンド
- **Framework**: Next.js 14+ (React 18+)
- **UI Library**: shadcn/ui + Tailwind CSS
- **State Management**: Zustand
- **Charts**: Recharts
- **Heatmap**: heatmap.js
- **Deployment**: Vercel

### バックエンド
- **Runtime**: Node.js 20+
- **Framework**: Next.js API Routes + Hono
- **Database**: ClickHouse (Hetzner)
- **Cache**: Redis (Hetzner)
- **Queue**: BullMQ
- **WebSocket**: Socket.io

### インフラ
- **Frontend Hosting**: Vercel
- **Database Server**: Hetzner Cloud
- **Database**: ClickHouse
- **Cache**: Redis
- **CDN**: Vercel Edge Network
- **Storage**: Hetzner Object Storage

## 🚀 クイックスタート

### 1. リポジトリのクローン
```bash
git clone https://github.com/your-username/clickinsight-pro.git
cd clickinsight-pro
```

### 2. 依存関係のインストール
```bash
npm install
```

### 3. 環境変数の設定
```bash
cp env.example .env.local
```

`.env.local`ファイルを編集して、必要な環境変数を設定してください。

### 4. 開発サーバーの起動
```bash
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いてアプリケーションを確認してください。

## 📁 プロジェクト構造

```
clickinsight-pro/
├── app/                    # Next.js App Router
│   ├── api/               # API Routes
│   ├── globals.css        # グローバルスタイル
│   ├── layout.tsx         # ルートレイアウト
│   └── page.tsx           # ホームページ
├── components/            # 再利用可能コンポーネント
│   └── ui/               # shadcn/ui コンポーネント
├── lib/                   # ユーティリティ
├── docs/                  # ドキュメント
├── tests/                 # テスト
├── package.json
├── next.config.js
├── tailwind.config.js
└── tsconfig.json
```

## 🧪 テスト

### 単体テスト
```bash
npm run test
```

### E2Eテスト
```bash
npm run test:e2e
```

### テストUI
```bash
npm run test:e2e:ui
```

## 📊 料金プラン

| プラン | 月額 | PV/月 | サイト数 | 主な機能 |
|--------|------|-------|---------|---------|
| Free | ¥0 | 5,000 | 1 | 基本ヒートマップ |
| Starter | ¥4,980 | 50,000 | 3 | AI分析、GSC連携 |
| Professional | ¥9,800 | 500,000 | 10 | 全機能、API |
| Business | ¥24,800 | 2,000,000 | 50 | 無制限AI分析 |

## 🎯 差別化ポイント

1. **AI自動診断**: Claude APIによる実装可能な改善提案
2. **SEO完全連携**: GSC/Ads APIによるクエリ別ヒートマップ
3. **コスパ最強**: 競合の半額で高機能
4. **内部リンクSEO分析**: 独自のSEO特化機能
5. **高性能**: ClickHouseによる高速分析
6. **コスト効率**: Hetznerによる低コスト運用

## 🚀 デプロイ

### Vercel
```bash
vercel --prod
```

### 環境変数の設定
Vercelダッシュボードで以下の環境変数を設定してください：
- `DATABASE_URL`
- `CLICKHOUSE_URL`
- `REDIS_URL`
- `CLAUDE_API_KEY`
- `GSC_API_KEY`
- `GA4_API_KEY`

## 📚 ドキュメント

### コアドキュメント（必須・常に最新）
- [開発状況](./docs/STATUS.md) - 現在の開発状況と次のアクション
- [仕様書](./docs/SPECIFICATIONS.md) - 機能仕様と要件定義
- [システムアーキテクチャ](./docs/ARCHITECTURE.md) - アーキテクチャとデータフロー
- [実装サマリー](./docs/IMPLEMENTATION.md) - 実装済み機能とファイル一覧

### 参考ドキュメント
- [ドキュメント戦略](./docs/DOCUMENTATION_STRATEGY.md) - ドキュメント整理戦略
- [差別化設計書](./docs/differentiation-specification.md) - Heatmap.comとの比較
- [Inngestセットアップ手順](./docs/inngest-setup-instructions.md) - Inngest設定ガイド

## 🤝 コントリビューション

1. このリポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は [LICENSE](LICENSE) ファイルを参照してください。

## 📞 サポート

- **Email**: support@clickinsight.pro
- **Discord**: [ClickInsight Pro Community](https://discord.gg/clickinsight)
- **Twitter**: [@clickinsight_pro](https://twitter.com/clickinsight_pro)

---

**ClickInsight Pro** - 次世代SEO特化型ヒートマップツール

