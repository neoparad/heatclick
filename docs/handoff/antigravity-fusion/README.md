# 融合SaaS 引き継ぎ書（Antigravity 向け入口）

作成: 2026-11-03（Claude Code・監督役）／ 状態: 下書き。オーナー確認待ち。

## 3行で

1. ugokimap（人の行動）・linkscrawl（ページ構造・SEO）・AIreceipt（AIのアクセス記録）を、**1つのSaaSに融合**する。
2. 母体は **ugokimap-saas**（このリポジトリ）。ログイン・顧客ごとの分離・本番公開・テストが既に揃っているため。aiseo/web の画面はここへ移す。
3. 最初の工事は画面ではなく、**3つのプロダクトの「サイト」と「URL」を同じものとして扱える対応表**を作ること。今は呼び名がバラバラでつながらない。

## 何をする製品か

1ページ（1URL）について、次の4つを同じ画面で並べて見せる。

| 見るもの | 出どころ | 今の状態 |
|---|---|---|
| 人がどう動いたか（ヒートマップ・CV導線） | ugokimap-saas | 本番稼働 |
| ページの構造・SEOの問題 | linkscrawl | 本番稼働（crawler.link-th.co.jp） |
| 検索からの流入（GSC） | aiseo/web | 一部稼働（bihadashop.jp のみ） |
| AIが来たか・何を読んだか | AIreceipt collector | 記録は本番稼働、画面は aiseo/web に試作 |

## 文書一覧

| ファイル | 中身 |
|---|---|
| [STATE_2026-11-03.md](STATE_2026-11-03.md) | 4フォルダの実測（何が動いていて、何が仮データか） |
| [PLAN.md](PLAN.md) | 融合後の形・工事の順番・オーナーが決めること |

## 役割（linkscrawl の Antigravity 引き継ぎと同じ）

- **Antigravity**: 本線。設計・実装・テスト・統合。
- **Codex**: レビューとセキュリティ監視。コードは書かない。
- **Claude Code**: 監督（相談役・レッドチーム）。コードは書かず、マージも承認しない。
- **オーナー**: 判断する。本番に触る操作は必ずオーナー確認。

正本は linkscrawl 側 `docs/handoff/antigravity/ROLES.md`（※現在は worktree `claude-e-d05-m08` にのみ存在。本体ブランチ未統合）。

## 移さないもの

- `aiseo/web` 直下の GCP サービスアカウント鍵（`link-th-*.json`）。**絶対にリポジトリへ入れない。** 鍵は環境変数で渡す。
- aiseo/web の Supabase 認証（ugokimap-saas の認証に一本化する。PLAN.md 参照）。
- AIreceipt collector 本体（Cloudflare Worker のまま独立運用。融合SaaSは「読む側」）。
- AIreceipt `docs/10`（能動監査 WS-F）は**保留中（HELD）**。着手しない。
