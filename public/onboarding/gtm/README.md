# GTM 設定ガイド資産 — Operator 撮影プラン

**起点**: decisions.md 2026-05-16 夕 FE-Q6 (Reviewer 撮り直し推奨採用)
**担当**: Operator
**期限**: Sprint 1 開始日
**引き渡し先**: Frontend Programmer (`/onboarding/install` ページ実装、P-02)

## 撮影プロトコル

### 環境準備（撮影前チェック）

- [ ] 新規 GTM テストアカウント作成（既存業務アカウント不使用、PII / 既存 site_id leak 防止）
- [ ] テスト用ドメイン: `gtm-onboarding-demo.example` (実 URL 表示しない)
- [ ] ブラウザ拡張 OFF（広告ブロッカー / clipboard manager / 業務アカウント自動ログイン）
- [ ] ブラウザ言語 = 日本語（UI 文言一致）
- [ ] OS 通知 / Slack / メールクライアント全閉鎖（録画混入防止）
- [ ] ディスプレイ解像度 1440×900 以上 (FE-Q6 要件: 出力 1200×800 以上)
- [ ] ダミー snippet: `<!-- UGOKI MAP tracking — example -->` 表記、本物の site_id / install_token 不使用

### 静止画キャプチャ (PNG)

| # | ファイル名 | 内容 | 解像度目標 |
|---|---|---|---|
| 1 | `01-create-account.png` | GTM ダッシュボード「アカウント作成」ボタン | 1200×800 |
| 2 | `02-container-setup.png` | コンテナ設定（ウェブ）画面 | 1200×800 |
| 3 | `03-install-code.png` | GTM コードスニペット表示画面（`<head>` / `<body>` 別） | 1400×900 |
| 4 | `04-new-tag-custom-html.png` | 新規タグ → カスタム HTML 選択画面 | 1200×800 |
| 5 | `05-paste-snippet.png` | UGOKI MAP tracking.js snippet 貼付（ダミー site_id） | 1400×900 |
| 6 | `06-trigger-all-pages.png` | トリガー: All Pages 選択 | 1200×800 |
| 7 | `07-preview-debug.png` | プレビュー / デバッグモード起動 | 1400×900 |
| 8 | `08-publish.png` | 公開（Submit）ボタン + バージョン名入力 | 1200×800 |
| 9 | `09-verify-tag-fired.png` | プレビューモードで Tag Fired 確認 | 1400×900 |

各 PNG は WebP 変換版も同名で `.webp` として併置 (Next.js Image 最適化向け、Frontend で `<picture>` 切替可能に)。

### 動画キャプチャ (install.mp4)

- 形式: MP4 (H.264 + AAC、`<video>` 直接埋込み可、Loom 公開リンク非依存)
- 長さ: 60-90 秒目安（カット編集で間引き、リアルタイム入力速度感は維持）
- 解像度: 1920×1080 / 30fps
- 音声: なし（字幕オーバーレイで操作説明、多言語対応容易）
- 字幕: 日本語ハードサブ（後で英語版差し替え用に `.srt` も同梱）
- 流れ:
  1. GTM コンテナ画面起動
  2. 新規タグ → カスタム HTML
  3. UGOKI snippet 貼付（ダミー site_id 強調）
  4. トリガー = All Pages
  5. プレビュー → Tag Fired 確認
  6. 公開

### 録画ツール候補

| ツール | 用途 | コスト | 採用判断 |
|---|---|---|---|
| Loom (free) | 録画 + ホスティング | 無料 | ホスティング依存。動画は MP4 ダウンロードしてリポジトリ同梱 |
| OBS Studio | 録画のみ | 無料 | 静的 MP4 出力に最適、字幕後付け |
| ShareX | 静止画 + GIF | 無料 (Windows) | キーボード強調表示 |
| ffmpeg | 編集 + 字幕焼付 | 無料 | OBS 出力に字幕埋込み |

**推奨**: OBS Studio で生録画 → ffmpeg で字幕焼付 + リサイズ → Loom はホスティングしないため不要。FE-Q6 「Loom 録画」は内部用語であり、最終成果物は MP4 ファイル本体を repo 同梱する解釈。

### PII / 機微情報排除チェック (撮影後)

- [ ] URL バーに本物のドメイン表示なし
- [ ] アカウントメニュー（右上アバター）の Google アカウント名 / メール非表示
- [ ] snippet 内 site_id / install_token はダミー文字列 (`xxxxxxxx-DEMO-xxxx`)
- [ ] ブラウザブックマークバー非表示
- [ ] 通知 / トースト混入なし

## 引き渡しチェックリスト

- [ ] PNG 9 枚 + WebP 9 枚 を `public/onboarding/gtm/` に格納
- [ ] `install.mp4` (字幕焼付済) を `public/onboarding/gtm/` に格納
- [ ] `install.srt` (日本語) を `public/onboarding/gtm/` に格納
- [ ] decisions.md に `[→Frontend]` タグで「GTM assets ready, file paths」を起票
- [ ] Frontend が `/onboarding/install` で `<Image>` / `<video>` 参照を完了したら `[→Director]` で Sprint 1 着工 OK 報告

## 改廃ポリシー

GTM UI は Google が予告なく変更するため：

- 撮影日付を `install.mp4` 末尾に焼付（例: 「撮影 2026-05-XX 時点の UI」）
- 各 PNG にも撮影日メタデータを記入（EXIF or サイドファイル `_meta.json`）
- 半年ごとに UI 差分確認、ズレが大きければ撮り直し起票（Operator 定例）

## 関連

- decisions.md 2026-05-16 夕 FE-Q6
- Grand v1 §5.4.1 `/onboarding/install` 行
- Grand v1 §6.4 S1-02 (Sprint 1 タスク)
- FE-Q6 採用根拠: Operator 既存導入失敗事例 + GTM UI 陳腐化リスク
