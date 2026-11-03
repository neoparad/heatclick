# 経路探索機能 — 訂正済み結論 v2 (オーナー案1/案2 評価 + 系統整理)

> 作成: 2026-07-17 / v2: 2026-07-18 sol レビュー (PATH_CONCLUSION_REVIEW_sol_2026-07-17.md, 判定: 条件付き支持) を反映
> 発端: オーナー質問「パス爆発が理由なら、①同パターンを集合的に表示すればよいのでは、②特定ページ経由の経路照会という画期的な仕組みを作ればよいのでは」
> 検証履歴: Claude 初回回答 → 自己敵対検証 (4-agent, REFUTED 3/PARTIALLY_WRONG 6) → v1 → sol レビュー (BLOCKER 3/HIGH 11) → 本 v2

---

## 1. 確定事実 (sol レビュー後の確定版)

### F-1. オーナー案2 (経由点照会) のエンジンは実装・チャット配線済み
- `lib/llm/hybrid-query.ts:3798-3875` `executeJourneysQuery` — groupArray + arraySort + 連続重複折りたたみ + 経路文字列 GROUP BY + top-N
- `:3819` start_url / `:3822-3824` `has(dedup, {contains_url})` = 経由点照会 (**ただし生URL照合。pathname 正規化なし**)
- `lib/llm/analytics-tools.ts:1078-1085` chat ツール `analytics_journeys`、`orchestrator.ts:399` はツール選択の指示 (決定的ルーターではない)
- ⚠ v2訂正: 「本番稼働」はコードから証明できるのは「実装+配線」まで。実呼出の有無は telemetry で別途確認
- → 案2 は「新機能の発明」ではなく「**既存エンジンの UI 昇格 + 品質ゲート整備**」

### F-2. 経路系実装は5系統以上に分裂している (v2訂正: 4→5+)
| 系統 | 方式 | 状態 |
|---|---|---|
| ① cv-journey UI | 固定ファネル windowFunnel | UI稼働。**ECテンプレ後半 (カート/購入) がゼロ**。ランディング/流入は非ゼロ (v2訂正:「全ゼロ」は誤り) |
| ② paths UI | ユーザー定義経路セット windowFunnel (`lib/paths/stats-query.ts:177-190`) | **API は 4-B 結線済みだが `/paths/[id]` 画面は KV 直読みで stats API 未接続** (`app/(proof)/paths/[id]/page.tsx:32-40,76-88`) — 新規セットは「未分析」、POC はダミーのまま |
| ③ analytics_journeys | groupArray 経路文字列集計 | chat 配線済み (F-1) |
| ④ analytics_path | single-hop 遷移集計 (`hybrid-query.ts:2218-2226`) | chat 配線済み (v1 で見落とし) |
| ⑤ analytics_funnel | 順序付き funnel (`hybrid-query.ts:2488-2529`) | chat 配線済み (v1 で見落とし) |
| (案) 新経路探索UI | 未実装 | 系統数に数えない (v2訂正) |

### F-3. 品質ゲートの乖離 (sol CONFIRMED + 範囲拡大)
- `session_id != ''` ガード欠落は **journeys だけでなく paths / analytics_path / analytics_funnel にも無い** (`lib/paths/stats-query.ts:113-125`, `hybrid-query.ts:2241-2248,2523-2529,3844-3851`)。修正は個別でなく**共通 scope への強制**で行う。cv-journey のみ修正済み (`lib/cv-journey/query.ts:68-76`)
- pathname 正規化は **exact/prefix のみ** (`lib/paths/url-match.ts:50-61`)。conversions の contains と cv-journey 固定 step は生URL部分一致 (v2 で限定)
- journeys は `pageview` のみ、CV定義は `('pageview','virtual_pageview')` — SPA 経路欠落の不一致
- 空 session 合算の主リスクは「偽経路・メモリ・tail汚染」(sessions 値は1になるため top-N 浮上とは断定しない — v2 訂正)
- **journeys は生URLを LLM へ送る** — query/path 内 PII マスクが未整備 (`hybrid-query.ts:3862-3868`、対照: `lib/cv-journey/pii-mask.ts`)

### F-4. モック04 の実体 (証拠所在の注記付き)
- `C:\Users\M2603\linkscrawl\docs\fusion\mockups\04_cv_journey.html` (52,975 bytes, 2026-05-23) — **別リポジトリに実在** (2026-07-18 ls で再確認済み)。本 repo 内から検証不能のため、確定事実として扱うには repo へのコピー+commit hash 添付が必要 (sol BLOCKER の妥当な部分)
- 内容: 固定5ステップ + 流入元 top-N 集約 (「無加工の全経路 Sankey」ではない)
- `docs/cv-journey-implementation-plan.md:88` に「見せ方が変わるためオーナー確認が望ましい」と記載のまま、承認ログなし

### F-5. 競合の実状 (sol CONFIRMED)
- GA4: 始点/終点は排他、via 指定なし (2ビュー迂回+セグメント近似は可能 = 「迂遠」)
- Mixpanel Flows: 任意アンカーの N steps before/after を単一ビュー提供 + Heatmaps (2025-07)
- PostHog: start+end 同時指定可 (中間折りたたみ)。Clarity: funnel→heatmap/recording 連携あり
- 「UI が存在しない」系の断定は公式資料で確認できた範囲に限定する (v2)

### F-6. データ規模 (v2 で指標差し替え)
- ~~0.49 clicks/session~~ は分母 (7日外挿) と分子 (90日実数) の期間が混在した無効な指標 — 撤回
- 正: `docs/ai-chat-deep-research-design.md:22-30` — **28,374 sessions/90日、平均 PV/session 1.47**。回遊は浅く、1ページ セッションが支配的である推定は維持
- 仕様必須: 期間は data-readiness 方式 (30日で coverage 不足なら90日へ延長) / min-count は **サーバ側で (parent,depth) 毎に Other 集約** (client fold では Other 総数と privacy suppression が成立しない — v2 訂正) / depth 上限 2-3 + `truncated`/`coverage` メタデータ

## 2. 結論 v2

1. **オーナー案1・案2 は現実的**。案1 は業界標準解、案2 はエンジン実装済み。問いは「作るか」ではなく「**5系統の整理**」
2. **アーキテクチャは「1エンジン統合」ではなく「2エンジン + 共通プリミティブ」** (v2 訂正、sol 指摘):
   - **発見エンジン** (discovery): `executeJourneysQuery` を `lib/llm` から `lib/paths/journey-query.ts` 等へ移設。AIチャット・新探索UIの canonical backend
   - **順序付き funnel エンジン**: cv-journey の session guard + CV定義和集合を核に共有 `funnel-query` として抽出。cv-journey / paths / analytics_funnel が利用
   - 共通プリミティブ: scope (tenant/site/is_agent/session/period 一体) / URL契約 (`url-match.ts` を canonical 化 + host境界・動的ID route-template・PIIマスク) / CV述語 (`buildCvPredicate`)
   - cv-journey UI = 「固定CVファネル+摩擦+heatmap handoff」に役割限定して維持。paths UI = 「保存済み経路セットの監視・比較」に限定して維持。新探索UIは discovery エンジンの consumer (新エンジンにしない)。旧 `/api/cv-paths`・`/api/funnel` は利用確認後 deprecate
3. **差別化仮説** は「ヒートマップ上の任意ページから前後経路を即時生成」に限定し、競合実機比較で検証してから看板にする
4. **着手順序** (v2 で分離): discovery 品質改善 (session guard / 正規化 / PII) は **C1 と独立に実施可能**。CV連携UIのみ C2 契約完了後
5. **「AIチャットデモ先行」は「専用UIなしの低コスト probe」に改称** (ゼロコストではない)。現行チャットのままでは検証にならない — 前提修正5点: (a) session/URL/PII/SPA/tie-break 修正、(b) `minSteps=1` + 1ページ離脱の明示集計 + total/coverage/Other メタデータ、(c) 選択期間の tool 入力への強制結線 (`periodDays`→`dateRange` 未結線が現存)、(d) 90日SQLの性能・再現性検証、(e) live 監査。その後にオーナーデモ → 専用UI要否決定
6. **工数の倍率見積り (1-1.5倍/2-3倍) は撤回**。要件別 WBS を積み上げてから再見積り (sol 指摘: discovery と funnel は意味論が異なり倍率比較不能)

## 3. 検証プロセスの記録 (再現性)

| ラウンド | 手法 | 結果 |
|---|---|---|
| 初回回答 | Claude 単独 | REFUTED 3 / PARTIALLY_WRONG 6 を含む (後に判明) |
| 自己敵対検証 | 4-agent 並列 (一次文書/実コード/競合/規模) | 主要な虚偽 (新機能扱い・groupArray誤帰属・Mixpanel見落とし) を検出 |
| sol レビュー | codex exec gpt-5.6-sol high | BLOCKER 3 / HIGH 11。方向性 (重複整理・集約表示・probe先行) は支持、前提の粗さを訂正 |

数値・断定は SQL/出典/実行日時を保存しないと再現不能になる — F-6 の教訓として、今後の実測主張にはクエリと結果 hash を添付する。
