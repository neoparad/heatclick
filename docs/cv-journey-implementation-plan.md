# CV経路分析ページ 実装計画

> 出所: `/council`（Claude → Codex(GPT-5.5) → Gemini(3.5-flash) → 統合）の合意 + 実コードベース grounding。
> モック: `linkscrawl/docs/fusion/mockups/04_cv_journey.html`

## Context（なぜ作るか）

GA4 探索ファネルは「経路を描けるが次の打ち手に繋がらない」。UGOKI MAP は **ヒートマップ・rage_click/dead_click 等の摩擦データ**を既に持つ。これを経路ファネルの「離脱エリア」に結び付け、「どこで・なぜ離脱したか → その場のヒートマップへワンクリック」を実現するのが差別化。流入メディアを起点(step0)に置ける点も訴求（既存 `clickinsight.sessions` の utm 属性で実現可能）。

モックの自由 Sankey を直訳しない。実データのパス爆発で読めなくなるため、**固定列ファネル + 離脱エリア主役 + heatmap handoff** に転換する。

## 確定した前提（実コード確認済み）

| 項目 | 事実 | 出典 |
|------|------|------|
| 認証 | `getAuthContext(request)` + `verifySiteAccess(request, siteId, ch)`。後者が `clickinsight.sites` の所有権で membership check | `lib/api-utils.ts:84,100` |
| ClickHouse | `getClickHouseClientAsync()` | `lib/clickhouse.ts` |
| イベント | `clickinsight.events`: `event_type`('pageview'/'conversion'/'click'/'scroll'/'rage_click'/'dead_click'…), `url`, `session_id`, `user_id`, `utm_source/medium/campaign`, `conversion_type`, `conversion_value`, `device_type`, `timestamp`, `tenant_id` | `cv-paths/route.ts`, migrations |
| セッション集約 | `clickinsight.sessions`: session単位で `utm_source/medium/referrer_type/conversion_type/landing_page/exit_page/device_type/page_views/total_revenue` が materialize 済み | `lib/session-aggregator.ts:4` |
| 既存類似API | `/api/cv-paths`(+`format=sankey`), `/api/funnel`。**N+1/tenant条件欠如あり→流用せず再構築**。Sankey構築ロジックのみ参考 | `cv-paths/route.ts`, `funnel/route.ts` |
| 再利用UI | `kpi-card.tsx`, `evidence-badge.tsx`, `ui/segment-chip.tsx`, `layout/sidebar-nav.tsx`, heatmap の `keepPreviousData` fetch | Explore |
| Evidence型 | `types/evidence.ts`(5階層: proven_exact/observed_exact/observed_approx/inferred/planned) | Explore |

## 設計原則（3者合意）

1. **実データ整合**: モックのGA4風イベント名でなく実 `event_type`/`conversion_type`/URLパスで定義。
2. **既存資産活用**: 流入属性は `sessions` テーブル、離脱の摩擦は events の rage_click/dead_click、遷移先は `/heatmap` へ handoff。
3. **D-07準拠**: 実数(到達/離脱)は `observed_exact`。感情・離脱主因(LLM)は `inferred` で断定%禁止・推定レンジ + `evidence-badge` 必須。後フェーズに分離。
4. **PII安全**: URL/referrer の query から `email/token/code/tel` 等を API層で正規表現マスクしてから返す。
5. **tenant isolation**: 全クエリで `site_id` 所有権検証(verifySiteAccess) + 可能な箇所で `tenant_id` 条件も付与(CLAUDE.md §3.8.1)。
6. **段階実装**: 確実な観測値から。推測/AIは後フェーズ。

---

## フェーズ計画

### Phase 0 — Query Spike（コード骨格前・実データ検証）
目的: 計画の前提を実 ClickHouse で潰す。**実装せず SQL 検証のみ**。
- **到達数(funnel)**: `windowFunnel({window_sec:UInt32})(timestamp, cond1…condN)` をセッション単位 → 外側 `countIf(reached>=n)`。ステップ条件は pageview+path / event_type='conversion'+conversion_type で表現。
- **遷移(links)**: セッションごとに `groupArray((timestamp,url))` → `arraySort` → 隣接ペア。**ループ/逸脱は「Other」に丸め、セッション内ユニーク遷移化**（パス爆発対策）。
- **流入(step0)**: `clickinsight.sessions` の `utm_medium/utm_source/referrer_type` を first-touch として集計（UIに「セッション流入」と明示）。欠損で direct に偏らないか spot check。
- **品質確認**: `is_agent=0`(bot除外)・session境界・CVR分母(全/流入あり/step1到達)の定義を確定し meta 化。
- 受け入れ: 5ステップの到達数とリンク数が現実的に出る／step0 が direct に偏りすぎない。
- **不可だった場合の分岐**: 流入属性が貧弱 → step0 を「coming soon」表示にして残り先行。

### Phase 1 — MVP（観測値のみ・inferred を出さない）
**ルート/コンポーネント**
- `app/(proof)/cv-journey/page.tsx` — Server Component。サイト一覧取得(cached, heatmap踏襲)。
- `components/cv-journey/cv-journey-page.tsx` — Client。フィルタ状態(range/device/segment/source)管理。
- `components/cv-journey/funnel-flow.tsx` — **固定列レイアウト**のデータ駆動 SVG。列内 value 降順・上位N+その他集約。リンク太さ = `link.value/columnTotal`（最小/最大幅・小流量丸め）。**ステップ間離脱エリアを clickable**に。
- `hooks/use-cv-journey-data.ts` — heatmap の `keepPreviousData` パターン流用（単発集計のためページネーション不要）。
- `lib/api/cv-journey.ts` — fetch クライアント（envelope パース）。

**API**
- `app/api/cv-journey/route.ts` — `getAuthContext` + `verifySiteAccess`。`getClickHouseClientAsync`。
  - 返却: `{ success, data: { steps, nodes, links, totals, meta }, meta: { data_source } }`。
    - `nodes`: `{ id, label, step_index, kind:'source'|'page'|'action'|'conversion'|'dropoff', sessions, evidence_level }`
    - `links`: `{ source, target, sessions, rate, dropoff_after_source }`
    - `totals`/`meta`: CVR分母を明示、完走率はCVRに統合(重複KPI削除)。
  - PII マスク・tenant_id条件・ユニーク遷移化を内包。

**定義層**
- `lib/cv-journey/funnel-config.ts` — 各ステップを **Zod スキーマ**で宣言: `{ label, match: { event_type:'pageview'|'conversion'|'click', path?, conversion_type?, selector?, element_text? } }`。サーバ側 allowlist でのみ SQL 展開（**自由 SQL 禁止**）。SPA(virtual pageview)方針を定義。デフォルトはサイト共通の標準ファネル、将来サイト別設定。

**UI 流用**
- KPI strip = `kpi-card.tsx`（sessions / CV / CVR / 最大ボトルネック）。フィルタ = `segment-chip.tsx`。
- 右ドロワー(MVP) = **observed 限定**。到達/進行/離脱の実数+率、そのステップ間の **rage_click/dead_click/scroll到達率急落**(実イベント=observed)を `evidence-badge` 付きで提示。「**この離脱エリアのヒートマップを見る**」→ 該当URL/要素フィルタ済みの `/heatmap` へ遷移。

**sidebar**: `cv-journey → /cv-journey` を active 化（現在 placeholder）。

### Phase 2 — Node detail 拡張
関連リソース、ステップ別詳細パネル（なお observed 中心）。

### Phase 3 — インサイト層（inferred）
- 感情内訳・離脱主因の LLM 分析: `evidence_level:'inferred'` + `confidence` + `evidence_data`、**断定%禁止/推定レンジ**。
- 「施策提案」= **摩擦データ trigger のルールベース Tips を主**、LLM は補助。出力は既存 **AI提案チケット(`13_action_tickets` 相当)へ handoff（実行はしない／anti-features §1.7.1）**。

---

## 移植時クリーンアップ（モック由来）
- 文字化け(mojibake)を全テキスト再入力（コピペ厳禁）。
- イベント名を実スキーマへ（`page_view`→`pageview`、`view_item/add_to_cart/purchase`→funnel-config の path/conversion_type/selector）。
- KPI の `neg`(赤) 誤用・完走率重複を是正。

## 残存リスク
1. **既存 `cv-paths`/`funnel` との重複**: 機能が一部被る。新 `cv-journey` に寄せ、旧2つは段階的に deprecate するか役割分担をオーナー確認。
2. **tenant_id 条件の一貫性**: 既存ルートは `site_id` 所有権検証のみで `tenant_id` を明示していない箇所あり。新規は CLAUDE.md 準拠で `tenant_id` も付与し、既存との整合をレビューで確認。
3. **固定列ファネルへの転換の合意**: モックは自由 Sankey 訴求。見せ方が変わるためオーナー確認が望ましい。

## 検証（E2E）
- Phase 0: 実 ClickHouse で 3 クエリを手動実行し数値妥当性を確認。
- Phase 1: `/cv-journey` を起動し、フィルタ切替→ファネル再描画、離脱エリアクリック→ドロワー→heatmap 遷移を Playwright で確認。tenant 越権(他サイトid)で 403 を確認。
- Unit: funnel-config の Zod 検証、PII マスク関数、リンク集計(ユニーク遷移/Other 丸め)。
