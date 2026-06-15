# M Agent ターゲティング × GA4 / BigQuery 連携プラン (草案 v0.1)

> 起票: 2026-06-07 / 状態: **設計のみ、実装は別 Sprint**
> 関連: T-1 (自然言語 → 条件 AST) + T-2 (dry-run preview) は実装済。
> 親 SSOT: `linkscrawl/docs/fusion/team/m-director/{prd.md, data-model.md, dsl-spec.md}`

## 0. これは何か (一言)
**「自社 ClickHouse events table だけだと届かないユーザ理解 — 例えば 30 日以上前の訪問履歴 / GA4 が拾っている広告計測 / 別ドメインの行動 — を、scenario のターゲット条件で使えるようにする」** ための、GA4 / BigQuery 取り込み方針を整理する。

実装は Phase 2.2 以降。本ドキュメントは「**取り込み方法の選択肢と trade-off**」「**コスト / 法的論点**」「**順序提案**」をまとめ、Owner 判断材料を 1 ページにする。

## 1. 何のために連携するのか (目的を 3 つに絞る)
| # | やりたいこと | 自社 events で足りる? | GA4/BQ で何が新しいか |
|---|---|---|---|
| G1 | **広告流入のセグメント精度を上げる** | ❌ utm_* は粗い | GA4 が拾う `session_source_medium`, `default_channel_group`, `campaign_id`, `gclid/gbraid` |
| G2 | **長期記憶ターゲティング**: 「過去 90 日内に CV 1 回以上したリピーター」 | ❌ events は 365 日 TTL だが session 集約は重い | BQ で event_intraday_/event_ ✕ user_pseudo_id で軽い集計 |
| G3 | **GA4 audience の再利用**: マーケがすでに GA4 で作った audience (例「カート放棄者」) | ❌ 別途定義要 | GA4 Admin API で audience 定義を import、毎日メンバーリストを export |

これ以外 (例: GA4 で見られる「ページタイトル」「country」) は自社 events に同等列があるか、追加列で取れる。**広告精度 + 長期 + audience の 3 つ**に集中する。

## 2. 取り込み 4 方式の比較

| 方式 | 何を持ってくるか | リアルタイム性 | 月コスト概算 | 実装規模 | 法的 / 利用規約面 |
|------|---|---|---|---|---|
| **A. GA4 → BQ Export 経由 (Daily Streaming)** | event_intraday_YYYYMMDD (1h 遅延) + event_YYYYMMDD (前日確定) | 1h 遅延 | BQ 取込 + Storage、~$50-200/月 (中規模サイト) | 中 (cron + load job) | GA4→BQ Link が必要 (有料 GA360 不要、無償 GA4 でも可、ただし Link 必須) |
| **B. GA4 Data API (Reporting)** | 既存 GA4 レポート + audience | リアルタイム可だが quota | API は無料、quota 10K req/day | 小 (API 直叩き) | quota 制限あり、metric 1 日 50 回まで等 |
| **C. GA4 → BQ → ClickHouse ELT** | A の BQ export を更に CH に taking、events と同じ取扱 | 1h+ | A + CH ストレージ +50% | 大 (ETL/dbt) | A と同じ |
| **D. Server-side import (BQ ↔ CH 直結 query)** | C なしで preview だけ BQ を叩く | リアルタイム | BQ クエリ課金 ($5/TB scanned) | 中 (federated query 等) | A と同じ |

### 推奨段階
| Phase | 方式 | 想定期間 |
|-------|------|---------|
| **2.2** | **B (Data API)** で GA4 audience を import するだけ。dry-run preview で「GA4 audience X に居る人」を場合分けできる | ~1 週間 |
| **2.3** | **A (GA4→BQ Export)** を Owner が設定 → 自社 cron で日次集計を ClickHouse の補助テーブル `clickinsight.ga4_user_state` に積む。長期記憶 (G2) を解禁 | ~2 週間 |
| **2.4** | **D (BQ federated query)** で audience の即時マッチも実装 (Vercel Function から bigquery-client、scenario 評価時に on-the-fly) | ~1 週間 |

C は **作らない** (CH と BQ の two-write は同期事故源)。

## 3. アーキテクチャ図 (Phase 2.3 完成後)

```
                    ┌──────────────────┐
                    │  GA4 (web/app)   │
                    └────────┬─────────┘
                             │ (1) daily BQ export
                             ▼
                    ┌──────────────────┐         ┌─────────────────────┐
                    │  BigQuery        │ ←(2)──  │ Vercel Function     │
                    │  events_*        │         │ (federated query    │
                    │  user_pseudo_id  │         │  for dry-run preview)│
                    └────────┬─────────┘         └────────┬────────────┘
                             │ (3) daily cron                │ (4) preview API
                             ▼                                ▼
        ┌────────────────────────────────────┐    ┌───────────────────────┐
        │ ClickHouse                          │    │ Scenario AST evaluator │
        │ clickinsight.events (自社 SDK)      │←(5)│                        │
        │ clickinsight.ga4_user_state (新規)  │    │  GA4-augmented ctx に  │
        │   - user_pseudo_id                  │    │  audience_ids field 等 │
        │   - audience_ids[]                  │    │  を加える              │
        │   - last_cv_at                      │    └───────────────────────┘
        │   - cv_30d / cv_90d                 │
        │   - channel_group_30d_top           │
        └────────────────────────────────────┘
```

## 4. 条件 DSL への影響

新規追加 **field** 候補 (`ALLOWED_FIELDS` 拡張):

| field | 由来 | 型 | 例値 |
|---|---|---|---|
| `ga4_audience_ids` | Phase 2.2 (GA4 Data API) | string[] | `["cart_abandoners","high_value"]` |
| `ga4_channel_group` | Phase 2.3 (BQ export) | string | `"Organic Search"`, `"Paid Search"` |
| `ga4_gclid` | Phase 2.3 | string | (clid) |
| `cv_30d` | Phase 2.3 (ga4_user_state) | number | `0..n` |
| `last_cv_at` | Phase 2.3 | string (ISO date) | |
| `predicted_ltv` | Phase 2.4 (BQ ML 推定) | number | `5000..` |

これらは `EvaluationContext` に追加し、scenario-runtime.js は **クライアントで evaluable な静的値** に限り採用 (gclid 等)。動的な audience match は **server-side preview と server-side gate** で対応 (browser には漏らさない)。

## 5. プライバシー / 法的論点 (D-14 DPIA と整合)

| 論点 | 影響 | 対応案 |
|------|------|------|
| user_pseudo_id ↔ tenant の cross-ID 結合 | 個人特定リスク (BQ で他 dataset と join 可能) | tenant_id で BQ dataset を分離、SA は per-tenant、export 期限 13ヶ月 |
| 海外データ移転 | GA4 = Google の米国インフラ、BQ も同 | DPA (Data Processing Addendum) が GA4 + BQ で揃っていることを Owner / 法務確認 |
| ICCPA / GDPR consent gate | scenario 配信側の consent gate (`clickinsight_optout`) は既存 | GA4 同意モード (consent_mode v2) を tracking.js と同期する必要 (Phase 2.3 同時着工) |
| 端末 finger printing 禁止 | iOS 17+ で Safari は user_pseudo_id 揺らぎ | 「`is_first_visit` は揺らぐ」前提で confidence 補正、UI で警告 |

**結論: GA4 → BQ export は無償 GA4 でも可だが、DPA / consent mode v2 / 13 ヶ月 export 期限 を Owner が承認する前提**。承認なしには Phase 2.3 に着手しない。

## 6. コスト試算 (中規模サイト=月 100 万 events 想定)

| 項目 | Phase 2.2 (B) | Phase 2.3 (A+B) | Phase 2.4 (A+B+D) |
|---|---|---|---|
| GA4 Data API | 無料 (quota 内) | 無料 | 無料 |
| BQ Storage (13ヶ月分) | — | $20-50 | 同上 |
| BQ query (federated) | — | — | $10-30 (preview 経由 100 GB/月想定) |
| Vercel Function 実行時間 | +微 | +5% | +15% |
| **月合計** | **〜$0** | **〜$30-70** | **〜$50-120** |

LP/CV 単価が ¥1000+/CV のサイトなら 1 CV 増加で半月 reach。コスト面は問題なし。

## 7. 実装スコープ (Phase 2.2 着手の DOR)

### 2.2 で作るもの (最小)
1. `lib/integrations/ga4-data-api.ts`: Google Data API クライアント (Service Account 認証)
2. POST `/api/integrations/ga4/audiences/sync` (Owner 操作): GA4 audience 一覧 + 直近 7 日のメンバー pseudo_id を fetch して `clickinsight.ga4_audience_membership` (新規テーブル) に upsert
3. ALLOWED_FIELDS に `ga4_audience_ids` 追加 (string[])、IN/NOT_IN op 対応
4. dry-run preview の `runDryRunPreview` で events JOIN ga4_audience_membership USING (visitor_id) を追加 (visitor_id ↔ pseudo_id mapping は GA4 SDK 側で同期する別 work)
5. scenario-new-view の visual builder で audience selector (combo box)
6. UI Evidence Level バッジに「GA4 audience に依存」表示

### 2.2 で作らないもの
- BQ export → CH 取込 (2.3)
- federated query (2.4)
- audience の新規作成 / 編集 (GA4 UI で行う前提)
- cookieless 統合 (別 backlog)

### 2.2 DOR チェックリスト
- [ ] Owner が GA4 property ID + Service Account 鍵を `.env.local` に投入 (`GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT_JSON`)
- [ ] DPA + consent mode v2 法務確認済
- [ ] `clickinsight.ga4_audience_membership` テーブル DDL (Infra Owner 適用、tenant_id 必須)
- [ ] tracking.js v2.5 で `user_id` (GA4 user_pseudo_id 互換) を ClickInsight visitor_id にマップ (2.3 で安全に運用するため)

## 8. オープン課題 (Owner 判断待ち)
| # | 課題 | 判断軸 |
|---|---|---|
| Q1 | Phase 2.2 で着手するか / 全部後回しか | dogfood (bihadashop) で GA4 audience が運用上 critical か |
| Q2 | BQ 取込 (2.3) を内製するか dbt / Fivetran 等 SaaS に委ねるか | 月コスト vs エンジニア工数 |
| Q3 | DPA / consent mode v2 の法務レビュー期間 | 想定 2-4 週間、2.3 着手は法務 GO 後 |
| Q4 | GA4 を持っていないテナントへの fallback | tenant ごとに `has_ga4_integration` フラグを持ち、未連携テナントは ga4_* field 利用不可とする |

## 9. 採否方針 (これだけ守れば走れる)
1. **GA4 連携は「機能を 1 つ増やす」ではなく「DPA / consent mode v2 / per-tenant 分離」のセットで」**
2. **CH と BQ を two-write 同期しない** (C 方式は不採用、taking は cron で daily 1 方向)
3. **新 field は ALLOWED_FIELDS に追加するが、scenario-runtime.js (browser) に出すのは静的値のみ** (audience match は server-side)
4. **コストガード**: BQ scanned bytes を週次でモニタ、想定の 2 倍を超えたら自動アラート + scenario 取込 pause
5. **Owner が GA4 を解約しても scenario が壊れない**: `has_ga4_integration=false` ですべての ga4_* leaf を「常に false」扱いに fallback

## 10. 関連
- `linkscrawl/docs/fusion/team/m-director/dsl-spec.md` (ALLOWED_FIELDS / LEAF_OPERATORS の SSOT)
- `linkscrawl/docs/fusion/team/security-backlog-2026-06-07.md` (SB-2 DSN redactor は GA4 SDK 接続にも適用)
- `lib/scenarios/dry-run-preview.ts:UNSUPPORTED_FIELDS` (新規 field 追加時に SUPPORTED 側へ移動)
