# ヒートマップ アーキテクチャ SSOT (Single Source of Truth)

> このドキュメントは、ヒートマップ機能の設計契約・既知の罠・完了定義(DoD)を1枚に集約する。
> **変更は必ずこのSSOTを先に更新してから実装する。** コード内の `続N` 連番パッチコメントは禁止。
> 経緯: 数十回の局所パッチ(旧コメント 続116→続133)で連鎖崩壊したため、Claude/Codex/Gemini
> 3者の council レビュー(2026-06-18)で根本原因を分析し、本SSOTを新設した。

最終更新: 2026-06-18 / 作成根拠: council 三者レビュー(根本原因分析)

---

## 0. 根本原因(なぜ連鎖から抜け出せなかったか)

3者合意の結論。**①〜⑥は6個のバグではなく、2〜3個の構造欠陥が6通りに噴出していた。**

1. **silent fallback の多用** — `[]` / `null` / `dummy_lcg` / `MOCKUP_VIEW_MODEL` に黙って落ち、
   UIが「取得失敗」と「データ0」を区別できない。→「壊れている」が「データなし」に化け、
   green テストで完了誤認 → 実機でオーナーが初発見 → 真因が隠れた二次症状を報告 → 対症パッチ → 別の状態を破壊。
2. **座標系の実行時推測** — 制御できない外部スクショに、実ユーザーの document 座標を
   ピクセル単位で重ねようとし、`SOURCE_WIDTH=1280` 固定 + capture viewport 契約不足のまま
   provider 依存で推測。provider が変わるたびズレ(②)・切れ(③)・出ない(①)。
3. **実データ検証ループの欠如** — local が本番ClickHouseに繋がらず、実データで一度も確認せず merge。
4. **メンタルモデルの所有者不在** — 各セッションが context 圧縮で記憶を失い、ゼロから再理解し
   最小局所パッチに逃げる。→ このSSOTとゲートで断つ。

---

## 1. 中核の設計判断(council 決定)

### 1.1 精度契約を下げる(最重要パラダイム転換)
**「スクショにピクセル一致」という守れない約束を捨てる。** 代わりに **要素 / セクション帯レベルの
精度契約**にする。

- **下げない**: 分析データの精度(クリック数・視認率・セッション数・離脱率)。実データのまま。
- **下げる**: 「ヒート光点がスクショの何px目に乗るか」という描画の約束のみ。
- 根拠: 顧客が欲しいのは「どの要素に興味が集中したか」であって 1px 精度ではない(Gemini)。
  かつ製品の `§1.7 アンチフィーチャー`(DOMスナップ生成禁止)が業界標準解(DOM再生)を封じているため、
  スクショ依存から逃げられず、その上でのピクセル精密は二重拘束で破綻する(Claude)。

### 1.2 棄却した代替案と理由
- **iframe ライブDOM方式(Gemini提案)**: 棄却。他社サイトは `X-Frame-Options`/CSP で iframe 拒否。
- **トラッキング時 DOM bbox 収集(Claude案b)**: 棄却。PII・DOMドリフト・**§1.7 アンチフィーチャー違反**。

### 1.3 認証後ページの制約(残存リスク・製品宿題)
スクショ方式である限り、ログイン必須ページのヒートマップは撮れない。当面 **公開ページのみ対応**と
製品仕様で明示する。エンタープライズ展開時に再設計が必要。

---

## 2. ルーティング契約

| 項目 | 確定値 |
|---|---|
| canonical route | **`app/(proof)/heatmap/page.tsx`** (現行・新実装) |
| 削除対象(旧 clickinsight-pro 遺物) | `app/heatmap/page.tsx`(h337/iframe), `app/heatmap-test/page.tsx`, `components/heatmap/HeatmapCanvas.tsx`(`heatmap.js` import・package.json に依存無し) |
| サイドバーリンク | `components/layout/sidebar-nav.tsx` → `/heatmap` |
| 主要コンポーネント | `components/heatmap/heatmap-page.tsx` → `heatmap-canvas.tsx` |

---

## 3. 座標契約 (Phase 1 で実装、ここに確定値を追記する)

> 原則: **サーバが CoordinateContract を1つだけ返し、canvas は推測しない。**

- 当面の動作保証: **PC・固定viewport(1280)・固定DPR のみ**。SP/TAB は degraded 明示。
- 集計は **capture viewport と一致する event のみ**を使う(混在 viewport のズレを排除)。
- partial capture(劣化providerが1画面分のみ返す)は受領拒否ではなく
  「上部のみ・以深は中立帯」を **degraded として明示**(長大ページ運用を維持)。
- `SOURCE_WIDTH=1280` の分散定義(view-model.ts / heatmap-canvas.tsx / api/heatmap/route.ts /
  lib/api/heatmap-elements.ts)を1つの contract に集約する。

(詳細スキーマは Phase 1 着手時にここへ記載)

---

## 4. 失敗モード行列 (Failure-mode matrix)

UIは必ず以下を **峻別**する。「データ0」と「取得失敗」を同じ表示にしない。

| 状態 | 意味 | UI表示(契約) |
|---|---|---|
| `data` | 実データあり | ヒートマップ描画 |
| `empty` | query成功・0行 | 「このページのデータはまだありません」(observed, 0行) |
| `error` | ClickHouse/認可/network失敗 | 失敗理由(diagnostics)付きエラー。**dummy に落とさない** |
| `degraded` | 一部のみ取得(partial capture等) | 取得できた範囲を明示し、欠落を正直に表示 |
| `loading` / `loading-stale` | 取得中(stale=旧データ表示中) | ローディングバッジ |

- `dummy_lcg`(`app/api/heatmap/route.ts`) と `MOCKUP_VIEW_MODEL`(`lib/heatmap/view-model.ts`)は
  **本番経路から除外**し、`NODE_ENV!=='production'` + 明示フラグ時のみ。

---

## 5. 完了定義 (Definition of Done) — merge ゲート

すべての変更は以下を満たすまで merge しない:

1. `tsc` green + `jest` green。
2. **Playwright 回帰**: 固定fixture画像で (a)pixel bbox 整合 (b)ページ切替後の stale 排除
   (c)dummy/mock が本番モードで出ないこと (d)image hover overlay整合 (e)tab切替。
3. **実データ目視**(最後の1段のみ人間): 該当ページを実データで開き、スクショ+overlay+切替+hover を確認。
4. **コードレビュー**: `code-reviewer` 通過。CLAUDE.md T1(認証/tenant/migration/座標契約等)は **Codex dual review** 必須。
5. このSSOTを更新済み(設計変更を伴う場合)。

---

## 6. 改修フェーズ(council 確定順)

- **Phase0-A**: ルート1本化(旧 `app/heatmap` + `/heatmap-test` + 旧Canvas 削除)。← 低リスク先行掃除
- **Phase0-B**: dummy本番fallback → typed error+diagnostics。hook/UIを `data/empty/error/degraded` 分離。
- **Phase0-C**: `MOCKUP_VIEW_MODEL` を dev/demo 限定に閉じ込め。
- **Phase1**: 座標契約を §3 に集約、PC固定viewportで1本化。(T1 → Codex dual review)
- **Phase2**: page list(limit/期間/検索/canonicalization)修正 + 張り子UI(④「感情推論ML準備中」等)パージ。
- **横断**: 本SSOT維持 + Playwright回帰ゲート構築。

---

## 7. このSSOTの使い方(運用ルール)

- ヒートマップを触る前に **必ず本SSOTを読む**。
- 設計を変えるなら **SSOTを先に更新 → 実装** の順。逆は禁止。
- コードに `続N` 連番パッチコメントを書かない。背景は本SSOTに集約する。
