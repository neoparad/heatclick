# 経路探索 訂正済み結論 — sol レビュー (2026-07-17)

> 実行: codex exec (gpt-5.6-sol, reasoning=high) / 対象: PATH_FEATURES_CORRECTED_CONCLUSION_2026-07-17.md

## 1. 指摘一覧

| 深刻度 | 対象(F-x/結論N) | 指摘 | 根拠 | 修正案 |
|---|---|---|---|---|
| HIGH | F-1 | エンジン・tool配線は存在するが「本番稼働」はコードだけでは証明できない。また `orchestrator.ts:399` は決定的ルーターではなく、LLMへのtool選択指示である。`contains_url` も正規化されたページ照会ではなく、生URLの完全一致である。 | `lib/llm/hybrid-query.ts:3798-3857`; `lib/llm/analytics-tools.ts:1078-1085,1785-1798`; `lib/llm/orchestrator.ts:399`; `lib/llm/hybrid-query.ts:3817-3824` | 「エンジン実装・チャット配線済み。本番deployment・実呼出は別途telemetry確認」に訂正。`contains_pathname` をcanonical入力にする。 |
| BLOCKER | F-2 / 結論1 | 「既に4系統」は分類として誤り。④は未実装なのに数へ入れ、実装済みの `analytics_path` と `analytics_funnel` を落としている。実態は少なくとも5エンジン相当＋未実装UIである。 | 対象文書 `:17-23`; `lib/llm/analytics-tools.ts:971-990`; `lib/llm/hybrid-query.ts:2218-2226,2488-2529,3798-3858` | 「4つの製品概念」ではなく、discovery / ordered funnel / single-hop の実装トポロジーとして棚卸しし直す。 |
| BLOCKER | F-2 | `cv-journey` が bihadashop で「全ゼロ」は誤り。後半の `add_to_cart` / `purchase` は不一致だが、step1は全pageview、step2は `/p/` pageviewなので構造上ゼロではない。 | `lib/cv-journey/funnel-config.ts:62-73,111-120`; 到達集計 `lib/cv-journey/query.ts:152-170` | 「EC既定ファネル後半がゼロ。pageview到達・流入・総セッションは非ゼロになり得る」に訂正。 |
| HIGH | F-2 | pathsの「4-B結線済」はAPI限定。現在の `/paths/[id]` 画面はKVを直接読み、統計付きAPIを利用していないため、新規セットは未分析、POCだけダミー値のまま表示される。 | API結線 `app/api/paths/[id]/route.ts:97-105`; 画面の直接KV読取 `app/(proof)/paths/[id]/page.tsx:32-40,76-88`; POC `lib/paths/poc-pathset.ts:22-39` | 「detail API結線済み、画面結線未完」と明記するか、画面側も共有loader/API経由へ統一。 |
| HIGH | F-3 / 結論6 | sessionガード欠落はjourneysだけではない。paths、`analytics_path`、`analytics_funnel` にもない。journeysだけ直す方針は負債を残す。 | `lib/paths/stats-query.ts:113-125`; `lib/llm/hybrid-query.ts:2241-2248,2523-2529,3844-3851`; 対照 `lib/cv-journey/query.ts:68-76` | 全経路クエリが使う共通scopeに `session_id IS NOT NULL AND session_id != ''` を強制する。 |
| HIGH | F-3 | 「paths/conversionsは正規化済み」は過大。pathsおよびconversionsのexact/prefixは正規化されるが、conversionsのcontainsとcv-journey固定stepは生URL部分一致である。 | `lib/paths/url-match.ts:8-25,50-61`; `lib/conversions/predicate.ts:46-77`; `lib/cv-journey/funnel-config.ts:111-120` | 「exact/prefixのみ正規化済み、containsはraw」と限定。全経路出力・照会のpathname契約を別途統一。 |
| MEDIUM | F-3 | 空sessionが偽の巨大経路になる点は正しいが、「top-Nに浮上」の影響説明は強すぎる。外側の `sessions` はイベント数でなくsessionグループ数の `count()` なので、空ID巨大経路のsessions値は1になる。 | `lib/llm/hybrid-query.ts:3831-3834,3841-3855` | 主リスクを「偽経路・メモリ/実行時間・tail汚染」と記述。高頻度経路に見えるとは断定しない。 |
| BLOCKER | F-4 | 引用された `linkscrawl/docs/fusion/mockups/04_cv_journey.html` は現repositoryおよびGit履歴に存在せず、指定行を再検証できない。現存一次計画は逆に「モックの自由 Sankey」と記載している。 | 対象文書 `:30-32`; `docs/cv-journey-implementation-plan.md:10,88` | モックをrepositoryへ保存してcommit hashを付すまで、F-4を「確定事実」から外す。「オーナー確認未実施」も承認ログなしでは断定しない。 |
| MEDIUM | F-5 | 中核は概ね正しいが、「PostHogはvia展開不可」「ClarityにSankey型探索なし」は不存在の断定が強い。公式資料から確認できるのは、PostHogの両端指定時の中間省略と、Clarityのfunnel→heatmap/recording連携まで。 | [GA4公式](https://support.google.com/analytics/answer/9317498?hl=en); [Mixpanel Flows公式](https://docs.mixpanel.com/docs/reports/flows); [PostHog Paths公式](https://posthog.com/docs/product-analytics/paths); [Amplitude Journeys公式](https://amplitude.com/docs/analytics/charts/legacy-charts/legacy-charts-journeys); [Clarity公式](https://clarity.microsoft.com/blog/introducing-funnels-in-clarity/) | 「公式資料で確認できた範囲」に限定し、UI不存在は実機または明示的な公式制約がある場合だけ断定する。 |
| HIGH | F-6 | 2,149 sessions、13,458 clicks、depth2=count1の生SQL・出力が保存されておらず再現不能。さらに7日sessionsを90日外挿した分母と90日click実数を混ぜた0.49は「実測click/session」ではない。click/sessionもpageview経路深度の指標ではない。 | 対象文書 `:41-44`; 別の90日集計は `docs/ai-chat-deep-research-design.md:22-30` で28,374 sessions・平均PV/session 1.47 | SQL、期間、実行日時、結果hashを保存。回遊の浅さには同一期間のPV/session、1ページsession率、path coverageを使う。 |
| HIGH | 結論2 | 「各社とも経路分析は別画面」ゆえの差別化は未立証。PostHogは経路stepからrecording/funnelへ、Clarityはfunnel stepからheatmap/recordingへ連携済みである。 | [PostHog Paths公式](https://posthog.com/docs/product-analytics/paths); [Clarity Funnels公式](https://clarity.microsoft.com/blog/introducing-funnels-in-clarity/); [Amplitude Heatmaps公式](https://amplitude.com/docs/heatmaps) | 差別化仮説を「ヒートマップ上の任意ページから前後経路を即時生成」に限定し、競合実機比較で検証する。 |
| HIGH | 結論3 | 「C1完了後」は技術依存として広すぎる。一般pageview discoveryはC1と独立。CV定義との和集合結線は設計上C2の責務である。 | `docs/cv/CV_DEFINITIONS_DESIGN.md:242-243`; `lib/conversions/predicate.ts:192-218` | discovery品質改善は今実施可能。CV連携UIのみC2契約完了後、と作業を分離する。 |
| HIGH | 結論4 | 現行AIチャットでは選択 `periodDays` がjourneysの必須 `dateRange` に結線されず、事後evidenceにだけ記録される。実クエリ期間と根拠表示が不一致になり得る。 | `lib/llm/orchestrator.ts:355-369,428-432,629-639`; schema `lib/llm/analytics-tools.ts:614-617,676-682` | server側で選択期間をtool入力へ強制し、evidenceはtool結果の `periodStart/End` から生成する。 |
| HIGH | 結論4 | 現行toolは1ページ離脱を全除外するため、F-6の「大半がLP→離脱」を検証不能。またtotal、全経路数、coverage、Otherがなくtop12だけを見る選択バイアスがある。 | `lib/llm/analytics-tools.ts:676-682`; `lib/llm/hybrid-query.ts:3781-3795,3817,3853,3864-3874` | `minSteps=1`、single-page/dropoff、`total_sessions`、`unique_paths`、`coverage`、`other_sessions` を追加してからデモする。 |
| HIGH | 結論4 / 結論6 | journeysはraw URLをLLMへ送る。pathname正規化だけでなく、query/path内PIIマスクがAIデモ前の必須条件である。 | `lib/llm/hybrid-query.ts:3837-3848,3862-3868`; `lib/llm/freeform-tools.ts:52-57,74-86`; 対照 `lib/cv-journey/pii-mask.ts:1-10,25-57` | 集計前にcanonical pathへ変換し、動的ID・email・tokenをmask/route-template化。raw URLをモデルへ渡さない。 |
| HIGH | 結論5 | 「固定ファネルの1〜1.5倍／2〜3倍」は見積根拠がない。journeys discoveryと固定funnelは意味論・返却構造・privacy処理が異なり、単純倍率比較できない。 | 対象文書 `:52`; discovery `lib/llm/hybrid-query.ts:3827-3857`; prescribed funnel `lib/paths/stats-query.ts:57-110,152-190` | 要件別WBS、性能検証、UI状態数、migration、テストを積み上げて再見積り。 |
| HIGH | 結論6 | journeysとpathsを「同一エンジン」にする案は誤設計。前者は全経路発見、後者はユーザー指定DSLの順序付きfunnelで、答える問いが違う。 | `lib/llm/hybrid-query.ts:3827-3857`; `lib/paths/stats-query.ts:57-110,152-190`; [PostHogもpathsとfunnelsの差を明記](https://posthog.com/docs/product-analytics/paths) | エンジンを2本に分け、scope/session/period/URL/CV predicateだけを共通primitive化する。 |

反証できず、**CONFIRMED** とする部分:

- F-1の集計実装そのもの――時系列配列化、連続重複除去、経路GROUP BY、top-N、始点・経由点filterは存在する。`lib/llm/hybrid-query.ts:3798-3857`
- F-3の主要不整合――journeysのsessionガード欠落、生URL集計、pageview-onlyと`virtual_pageview`対応の不一致は事実。`lib/llm/hybrid-query.ts:3844-3851`; `lib/conversions/predicate.ts:203-207`
- F-5の競合中核――GA4のstart/end排他、Mixpanelの複数anchor＋前後step＋Other、PostHogのstart/end指定、Amplitude Journeys/Heatmaps、Clarityのfunnel連携は公式資料で確認できる。
- 「専用UIより先に低コストprobeを行う」という戦略自体は合理的。ただし現行toolをそのままデモすることは支持しない。

## 2. 4系統整理の推奨 (どれを canonical 昇格、どれを deprecate、根拠)

「1エンジン＋4UI」ではなく、次の2エンジンをcanonicalにすべきです。

| 対象 | 推奨 |
|---|---|
| 経路発見エンジン | 現 `executeJourneysQuery` を `lib/llm` から `lib/paths/journey-query.ts` 等へ移設。AIチャットと新探索UIのcanonical backendにする。 |
| 順序付きfunnelエンジン | `cv-journey` のsession guard・CV定義和集合を核に、共有 `funnel-query` として抽出。cv-journey、paths、`analytics_funnel` が利用する。 |
| URL契約 | `lib/paths/url-match.ts` をcanonicalへ。ただしhost保持、percent encoding、大小文字、動的ID、PIIの方針を追加する。 |
| cv-journey UI | 維持。役割を「固定CVファネル＋摩擦＋heatmap handoff」に限定。 |
| paths UI | 維持。役割を「保存済み経路セットの監視・比較」に限定。SQL実装は共有funnelへ移行。 |
| `analytics_journeys/path/funnel` | tool名は互換adapterとして維持。`hybrid-query.ts` 内の重複SQLは段階的にdeprecate。 |
| 新経路探索UI | 新しい第4エンジンにしない。canonical discovery engineのconsumerとして実装。 |
| 旧 `/api/cv-paths`・`/api/funnel` | 利用状況確認後にdeprecate。既存計画も重複を認識している。`docs/cv-journey-implementation-plan.md:85-87` |

## 3. 最小要件 (90日既定/min-count/depth上限/pathname正規化/session_idガード) の過不足

提示5点は必要ですが、十分ではありません。

- **90日既定**: 疎なサイト用の既定としては妥当。ただし全サイト固定は過剰です。30日でcoverage不足なら90日に延長するdata-readiness方式がよいです。現在もcv-journeyは7日、pathsは30日で不統一です。`components/cv-journey/cv-journey-page.tsx:25-26,42-48`; `lib/paths/types.ts:126-132`
- **期間契約**: timezone、当日を含むか、start-inclusive/end-exclusiveを共通Period型で固定すべきです。paths・AI・cv-journeyは現在意味論が異なります。`lib/paths/stats-query.ts:113-125`; `lib/llm/hybrid-query.ts:3845-3851`; `lib/cv-journey/query.ts:77-83`
- **min-count**: `n<5` は妥当な初期値ですが、サーバ/SQL側で `(parent, depth)` ごとにOtherへ集約する必要があります。LIMIT後のclient foldでは正しいOther総数もprivacy suppressionも実現できません。
- **depth上限**: 2–3を表示既定にし、展開可能にするのが妥当です。`maxDepth`、`truncated`、`continued_sessions` が必要です。現在の `minSteps` は下限であってdepth上限ではありません。`lib/llm/analytics-tools.ts:676-681`
- **pathname正規化**: query/hash/末尾slash除去だけでは不足。host境界、動的numeric ID/UUIDのroute-template化、PIIマスク、最大label長、高cardinality制限も必要です。
- **session_idガード**: journeysだけでなく、paths・`analytics_path`・`analytics_funnel`を含む全経路クエリへ適用すべきです。

追加必須要件:

1. `minSteps=1` と1ページ離脱の明示集計
2. total sessions、unique paths、top-N coverage、Other/hidden sessions
3. 同一timestamp時の決定的tie-break。現在はtimestampだけで並べている。`lib/llm/hybrid-query.ts:2257-2259,3842-3843`
4. `pageview` / `virtual_pageview` の統一方針
5. tenant/site/is_agent/session/periodを一体化した共通scope
6. pathsのCV条件をC2和集合述語へ移行。現状は生`conversion_type`のみ。`lib/paths/stats-query.ts:77-87`
7. 90日クエリのcache、timeout、走査量上限
8. raw URLをブラウザ・LLMへ渡さないPII境界

## 4. 「AIチャットデモ先行」順序への評価

**条件付き支持**です。専用UIを作る前に実データprobeを行う考え方は正しいですが、現在のチャットをそのまま使う順序は不支持です。

現状には次の穴があります。

- 既定は7日で期間chipは編集不能。`app/(proof)/chat/page.tsx:33-42`; `components/chat/chat-input.tsx:93-102`
- UIの `periodDays` がfreeform toolの `dateRange` に強制結線されていない。
- `minSteps>=2` により最大母集団とされるLP→離脱を除外する。
- raw URLがLLMへ送られる。
- session、pathname、SPA、min-count、depth、coverageの品質ゲートが未充足。
- providerが`ai-gateway`でなければfreeformはstubへ落ちる。`lib/llm/orchestrator.ts:325-352`

推奨順序は次です。

1. session/URL/PII/SPA/決定的順序を修正
2. `minSteps=1`、min-count/Other、depth、coverage metadataを実装
3. 選択期間をserver側でtool入力へ強制
4. Phase 0として90日SQLの性能・数値・再現性を直接検証
5. live環境で固定プロンプトを実行し、実tool call・期間・providerを監査
6. その結果をオーナーへデモ
7. 専用UIの要否・既定値を決定

「ゼロコスト」ではなく、**「専用UIなしの低コストprobe」**と呼ぶのが正確です。

## 5. 総合判定: 条件付き支持

方向性――重複整理、集約表示、専用UI前のprobe――は支持する。ただし「4系統」「全ゼロ」「F-4確定」「F-6実測」「現行AIで薄さを検証可能」という前提は崩れており、現状の文書を意思決定根拠としてそのまま採用することは支持しない。
