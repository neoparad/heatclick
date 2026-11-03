# ヒートマップ 10-12秒 — 中核要因の最終見解 (Claude × Codex 統合)

> 作成: 2026-07-19
> 経緯: Claude 初案 → 4-agent 自己検証で REFUTED 3 (v2) → Codex Desktop 独立調査 (判定 ADJUST) → 本書で統合
> 入力: `HEATMAP_SPEED_ROOT_CAUSE_v2_2026-07-19.md` (Claude) + `CODEX_ANALYSIS_heatmap_speed_2026-07-19.md` (Codex)

---

## 1. Codex 指摘の採否 (Claude 判定)

| Codex 指摘 | 採否 | 理由 |
|---|---|---|
| 視覚完成は A+B+C+D の直列合算でなく **A+B+max(C,D)** | **採用** | tiles と screenshot は mount 後に並列発火 (`heatmap-page.tsx:126-146`, `heatmap-canvas.tsx:370-418`)。v2 §2 の「8-13s で 10-12s と整合」は過大合算だった — **撤回** |
| 全UI完了は A+B+max(C,D,E) | 採用 | elements はサイドパネル。オーナーの「表示されるまで」が全UI体感なら E も効く |
| CH SELECT は 8本でなく **9本** (SSR pages を含む) | 採用 | 数え方の統一。latency 経路上 9本 |
| 10-12s は現証拠では区間帰属できない (どれが支配的か未確定) | 採用 | query_log に heatmap クエリの識別子が無く実測不能。~3s コメントも現在値未検証 |
| Tunnel RTT 中央値 ~248.5ms (調査PC発、Vercel 発は未測) | 採用 (注記付き) | elements 5直列の通信下限 ~1.24s+ が実数化された |
| SSR streaming 化は「実データ表示を必ず短くする施策ではない」(P2) | **部分採用** | HTML 先出しで chunk DL が A の CH クエリと**重なる** (現状 A→B 直列)。短縮上限 min(A,B) の実利あり。P2 のままだが効果評価を訂正 |
| cold 対策は「warm 仮説とは別の長尾対策」(P2) | **部分採用** | 分離は正しい。ただし Claude 検証の「SWR background 再撮影が Vercel で完了しない疑い + CAPTURE_VERSION bump + L1 FIFO 60」により、**D が実は warm でない頻度**が高い可能性がある。「warm か cold か」自体が計測項目 |

## 2. 合意された表示モデルと帰属の現状

```
視覚完成   ≈ A (SSR gate) + B (chunk/mount) + max(C: tiles, D: screenshot) + decode
全UI完了   ≈ A + B + max(C, D, E: elements 5直列)
```

**重要な帰結**: warm 前提の構造コストは A+B+max(C,D) ≈ **3〜8秒**にしかならず、
**観測されている 10-12秒には 3〜7秒の未説明残差がある**。残差の候補は3つ:
1. **C の長尾**: tiles 2パスクエリの実所要が ~3s コメントより悪化している (データ増・毎行 regex・2回スキャン)
2. **D が warm でない**: SWR 再撮影の未完了 (Next 14.2 detached promise) / CAPTURE_VERSION v12 bump / L1 FIFO thrash により、実際は stale→cold 頻発
3. **A+B が想定超**: Vercel→Tunnel の実 RTT / 5分 cache miss 率 / 628KB chunk の実 parse 時間

どれかは**計測でしか確定できない** — これが両者の一致点。

## 3. 中核要因 Top 3 (両者合意、確度付き)

| 順位 | 要因 | 確度 | 根拠 |
|---|---|---|---|
| 1 | **C: tiles 2パス click クエリ** (同一 WHERE で events 2回スキャン + 毎行 regex 正規化 + サーバ側キャッシュ無効) | 構造=高 / 時間=未計測 | `route.ts:470-490`, `canonical-url.ts:38-40`, `cached:false` ハードコード |
| 2 | **D: screenshot 鎖の「実効 warm 率」**(warm でも CH ownership+MB級 非CDN 配信、そして warm でない疑い) | 構造=高 / 頻度=未計測 | `screenshot/route.ts:145-163`, `r2-screenshot-cache.ts:592-607` (再撮影未完了疑い), v12 bump 履歴 |
| 3 | **A+B: SSR 直列 gate + 628KB chunk** (fetch 開始が A+B 完了まで一切始まらない) | 構造=高 / 時間=未計測 | `page.tsx:21-24, 59-62`, `.next` manifest 実測 628,641 bytes |
| 次点 | E: elements 5直列 (RTT 下限 ~1.24s、全UI完了に効く。最安改修) | 高 | `elements/route.ts:148-317`, RTT 実測 248.5ms |

## 4. 実行順 (合意版)

### P0 — 計測 (すべての前提。~1日)
1. **Server-Timing** を 5 route に: SSR pages / tiles (handler・CH・rows/bytes) / page-stats / screenshot (ownership・R2 tier・capture 種別・image bytes) / elements (各クエリ+合計)
2. **CH クエリに識別子**: `log_comment` or query_id 付与 → query_log で p50/p95 追跡可能に (query_log 権限は default 拡大でなく**限定 observability role** — Codex 提案採用)
3. **client marks**: mount / 各 fetch 開始・終了 / image decode 完了
4. **オーナー協力 1 点**: 認証済みブラウザで 1 回計測 (DevTools で Server-Timing が見える)。cold/warm/再訪の3シナリオ
5. 判定基準: 残差 3〜7秒 の帰属先を C / D / A+B のいずれかに確定

### P1 — 計測で確定した犯人から (効果順は計測後に確定)
- C なら: 短TTL サーバキャッシュ + canonical pathname 事前正規化列 + 2パス再設計
- D なら: R2 実サイズ確認 → CDN 化 (custom domain / edge cache) + 再撮影完了保証 + degrade 時 base64 inline 排除
- 並行して **E: elements Promise.all 化** (canvas 非依存・低リスク・計測を待つ必要なし)

### P2 — 構造
- ownership 短TTL cache (tenant/site/url をキーに、cross-tenant reuse 防止)
- SSR streaming 化 (A∥B 化、短縮上限 min(A,B))
- cold dedupe lock + Plan C (事前生成) — **2秒要件の必要条件** (cold の構造的排除)

## 5. 「2秒」到達性の更新判定

max() モデルで修正後 floor を再計算:
```
A' 0.2-0.4 + B' 0.2-0.5 + max(C' 0.3-1.0, D' 0.5-1.5) ≈ 0.9-2.4s
```
- **2秒要件は引き続き到達圏内** (並列モデルにより v2 判定よりむしろ改善)
- 条件は不変: (i) Plan C で cold を排除、(ii) P0 計測で帰属確定後に P1 着手、(iii) Clarity を「超える」には画像方式の限界 (MB転送) が残る — 同等圏止まり

## 6. 未解決の計測ギャップ (次に埋めるもの)

| ギャップ | 必要なもの |
|---|---|
| heatmap CH クエリの p50/p95/rows/bytes | log_comment 付与 + observability role |
| R2 画像実サイズ・転送時間 | R2 credentials or Cloudflare metrics |
| Vercel→Tunnel 実 RTT | Server-Timing (P0-1 で自動的に取れる) |
| 認証済み本番の実測 | オーナーのブラウザ 1 セッション |
| 10-12s の「常時 vs 長尾」判別 | 3シナリオ×複数回の計測プロトコル |
