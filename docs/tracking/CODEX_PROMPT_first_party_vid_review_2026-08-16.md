# Codex Desktop 用プロンプト: 第一者 Set-Cookie 設計書 (v2) の T1 レビュー

> 使い方: 以下の「---PROMPT---」以降を Codex Desktop にそのまま貼り付ける。
> 対象リポジトリ: `C:\Users\M2603\ugokimap-saas`

---PROMPT---

あなたは T1 (Critical) セキュリティレビュアーです。visitor_id Cookie の発行を
クライアント JS からサーバー Set-Cookie へ移す設計書をレビューしてください。
この変更は Cookie / CORS / tenant isolation に触れるため、このリポジトリの規約
(CLAUDE.md「Codex dual review」節) で Claude + Codex の dual review が必須とされており、
あなたはその Codex 側です。Claude 側の実装はまだ始まっていません — **設計段階での
レビュー**であり、ここで見落とすと実装がそのまま欠陥を継承します。

## レビュー対象

- **設計書 (主対象)**: `docs/tracking/FIRST_PARTY_VID_DESIGN_2026-08-16.md` (v2)
- 設計が前提にしている実コード (設計書の主張と現物の一致を必ず検証すること):
  - `public/v2/tracking.js` — vid 発行 (193-196行付近)、apiEndpoint 上書きフック (124行付近)、
    sendBeacon 送信 (400-415行付近)、fallback fetch (422行付近)
  - `workers/event-ingest/src/worker.ts` — corsHeaders (772-781行付近)、
    POST ハンドラ (826-915行付近)、resolveTenant / audit emission
  - `public/scenario-runtime.js` — document.cookie からの `__ugk_vid` 読取 (163行付近)
  - `workers/event-ingest/wrangler.toml` — ALLOWED_ORIGINS 等の設定

## 背景 (要点のみ、詳細は設計書 §0-§1)

- Safari ITP は JS 発行 Cookie を実質7日で消すため、Safari/iOS 訪問者の
  セッション横断アトリビューションが成立していない (全導入先共通)
- 対策: 顧客サイトのパスをリバースプロキシで ingest Worker へ向け (第一者化)、
  Worker が同名 Cookie を Set-Cookie で再発行して ITP 免除へ「昇格」させる
- v1 → v2 で既に2本の敵対的レビュー (red-team + ブラウザ挙動 fact-check、計15 findings)
  を反映済み。**反映内容は設計書末尾の「付録: v1 → v2 の変更理由」表にある。
  この表の項目を再指摘するのは時間の無駄なので、まず付録を読んでから本文に入ること。**

## 依頼内容 (2段構え)

### 第1段: 明白な問題はあなた自身が設計書を直接修正する

誤字・用語の不統一・実コードとの食い違い (行番号ズレ、関数名の誤記等)・
自己矛盾する記述を見つけたら、**設計書ファイルを直接編集して修正**してください。
修正した箇所は最後のレポートに一覧してください。

### 第2段: 設計判断への異議は findings として報告する (勝手に書き換えない)

以下の観点で攻撃的にレビューし、問題は severity (CRITICAL / HIGH / MEDIUM / LOW) 付きの
findings として報告してください。**設計判断そのものの変更はあなたの一存で行わない**こと
(トレードオフはオーナーが裁定します)。

重点観点 — 既存レビュー2本が見ていない/浅い可能性のある角度:

1. **D-2「同名 Cookie 昇格」の boundary condition**: 設計は「name/domain/path の完全一致で
   RFC 6265 の置換が起き、WebKit の set-in-JavaScript ビットが消える」に全面依存している。
   これが崩れる端ケースはないか — 例えば tracking.js の `_localSetCookie` が付ける属性
   (実コードを読んで確認) と Worker が返す属性の些細な差、Secure/SameSite 属性の不一致が
   置換ではなく共存を生むケース、ブラウザ実装差 (Firefox ETP / Chrome の将来挙動)。
2. **Worker 実装仕様の穴 (§3-1)**: vid 正準化の優先順・重複 Cookie 拒否・形式 regex は
   仕様として十分に閉じているか。攻撃者が「重複 Cookie 拒否 → payload フォールバック」を
   意図的に誘発して payload 側の任意値へ誘導する経路、`Path` 属性の異なる同名 Cookie を
   植えて拒否条件を突く経路、正準化がイベント順序/バッチ内で非決定になる経路。
3. **S-4 のリスク受容は妥当か**: 「XSS 前提なら payload 偽装と同等なので400日persistの
   増分のみ、受容」という論理に穴はないか。XSS を必要と*しない*経路 (例: 兄弟ポートの
   別サービス、http:// ダウングレード + Secure 属性の関係、プロキシ設定ミスで
   /ugoki/track が別者に proxy されるケース) で host-only Cookie を植えられないか。
4. **§3-2 CORS 撤回の副作用**: echo 分岐の削除 + '*' 固定化で、現在この echo 挙動に
   依存している呼び出し元が本当にゼロか (repo 全体 + 既知の導入先スニペットを確認)。
5. **ロールアウト順序 (§5)**: 手順1 (Worker デプロイ) の時点で、まだプロキシ未設定の
   既存顧客の workers.dev 直叩きに Set-Cookie が返り始める。設計は「第三者コンテキスト
   なので各ブラウザが保存拒否するだけで無害」(S-8) とするが、これをブラウザ別
   (Safari/Chrome/Firefox + ITP/ETP/3PC 段階的廃止の2026年時点の状態) に検証せよ。
   保存されてしまうブラウザがある場合、その Cookie は workers.dev スコープであり
   後続の第一者化と競合しないか。
6. **運用の抜け**: §3-4 (Sentry scrub / CF ログ) は「確認する」で止まっている。
   確認手順・失敗時の扱いが実装チケットに落ちる粒度になっているか。
7. その他、実コードを読んで気づいた設計書の見落とし全般。

## 出力形式

1. 第1段で直接修正した箇所の一覧 (ファイル/行/修正内容)
2. findings 一覧 (severity 順、各項目: 該当セクション / 問題 / 根拠となるコードやドキュメントの参照 / 提案)
3. 総合判定: APPROVE / APPROVE-WITH-CHANGES / REJECT
4. 判定理由 (3行以内)

見つからなかった観点は「問題なし」と明記してください (沈黙と見落としを区別するため)。
理論上の可能性だけで実コード・実挙動の裏付けがない指摘には、その旨を明記してください。
