# Phase 2 分析軸追加 & ペルソナ自動生成

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `lib/analysis-axes.ts` | 12軸追加（TOP10 + ペルソナ2軸）、categoryに `seo` / `cognitive` / `meta` を追加 |
| `lib/integrations/ga4.ts` | 新規作成。GA4 Data API連携（BigQuery不要） |
| `mcp-server.ts` | `ugokimap_generate_personas` ツール追加、GA4データ統合 |

---

## 追加した分析軸（12軸）

### TOP 10 新規分析軸

| # | ID | category | cost | 依存 | 概要 |
|---|---|---|---|---|---|
| 1 | `cannibalization_behavior` | seo | heavy | GSC L1 | 同一クエリで複数ページがランクインし、ユーザーがページ間を往復する行動を検出。ページ統合/差別化の判断材料 |
| 2 | `cognitive_load_score` | cognitive | heavy | 純CH | スクロール速度の不安定度 + rage/dead click密度 + 上下往復率 → ページごとの認知負荷を0-100でスコア化 |
| 3 | `attention_competition` | engagement | medium | 純CH | 同一画面内で同時に可視だった複数要素のうち、どちらがクリックされたかの勝敗マトリクス |
| 4 | `query_intent_page_match` | seo | heavy | GSC L1 | GSCクエリを4分類（transactional/comparison/informational/navigational）し、ページ行動との適合度を0-100スコア化 |
| 5 | `session_replay_priority` | meta | medium | 純CH | rage click + confusion scrolling + CV直前離脱 + フォーム放棄 → セッション録画の優先度0-100 |
| 6 | `engagement_decay_curve` | content | medium | 純CH | 100px区切りでエンゲージメント強度をプロットし、急落ポイント（コンテンツの壁）を検出 |
| 7 | `internal_link_effectiveness` | seo | medium | 純CH | 内部リンクのクリック率 × 遷移先でのCV率。内部リンクのROI可視化 |
| 8 | `zero_click_content_audit` | seo | heavy | GSC L1 | クリックゼロ×熟読で離脱するページを検出し、GSCクエリ意図と照合して「情報提供成功」か「CV導線失敗」かを判定 |
| 9 | `exit_intent_pattern` | friction | heavy | 純CH | 離脱前5アクションを4パターン分類（rapid_scroll_up / friction_exit / shallow_bounce / slow_fade） |
| 10 | `price_sensitivity_signal` | conversion | medium | 純CH | 料金セクションの滞在比率・再訪回数・摩擦度 → price_hesitation_score 0-100 |

### ペルソナ自動生成（2軸）

| # | ID | category | cost | 概要 |
|---|---|---|---|---|
| 11 | `persona_behavior_profile` | persona | heavy | セッション単位で行動特徴量を抽出し、10タイプに自動分類 |
| 12 | `persona_query_intent` | persona | medium | ページ別GSCクエリ意図分布。ペルソナの流入経路に検索意図を紐付ける補助データ |

#### 行動タイプ10分類（persona_behavior_profile）

| タイプ | 条件 |
|---|---|
| `quick_converter` | CV済み、120秒以内、5クリック以下 |
| `deep_reader_converter` | CV済み、熟読30秒超 |
| `standard_converter` | CV済み、上記以外 |
| `engaged_non_converter` | スクロール80%超、熟読20秒超、CV無し |
| `skimmer` | 高速スクロール(500+px/s)、熟読5秒未満 |
| `confused_navigator` | 上下往復率30%超 |
| `frustrated_user` | rage/dead click 2回以上 |
| `bouncer` | スクロール25%未満、15秒未満 |
| `passive_reader` | 熟読30秒超、クリック3回未満 |
| `standard_visitor` | 上記いずれにも該当しない |

---

## GA4 Data API 連携（`lib/integrations/ga4.ts`）

### 認証方式
- サービスアカウントのJWT認証（GSC連携と同じパターン）
- 顧客の操作: GA4プロパティにサービスアカウントのメアドを閲覧者として追加するだけ
- BigQuery不要、OAuth不要

### 環境変数

```env
GA4_CLIENT_EMAIL=your-sa@project.iam.gserviceaccount.com  # GSC_CLIENT_EMAILと共用可
GA4_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."         # GSC_PRIVATE_KEYと共用可
GA4_PROPERTY_ID=123456789                                   # GA4プロパティID（数字のみ）
```

### 提供関数

| 関数 | 戻り値 | 用途 |
|---|---|---|
| `fetchGA4DemographicSegments` | 年代×性別×デバイス×セッション数×CVR×滞在時間 | ペルソナへのデモグラ統計マッチング |
| `fetchGA4PageDemographics` | ページ別×年代×性別×セッション数×滞在時間 | ペルソナのLP年代分布裏付け |
| `fetchGA4AgeSourceCV` | 年代×流入元×CVR | 広告ターゲティング最適化 |
| `fetchGA4InterestSegments` | 興味関心カテゴリ×セッション数×CVR | ペルソナの興味関心付与 |
| `fetchGA4PersonaData` | 上記を全部並列取得 | MCPペルソナ生成用 |

### GA4 APIの制約
- ユーザー単位のデモグラは取得不可（集計データのみ）
- 年代・性別データのカバー率は40-60%（Googleの推定値）
- ClickHouseの行動データとはga_client_idでの直接JOINは不可
- → 統計的マッチング（セッション時間・CVRの類似度）でペルソナにデモグラを推定紐付け

---

## MCPツール追加（`mcp-server.ts`）

### `ugokimap_generate_personas`

行動ベースペルソナ自動生成ツール。3つのデータソースを統合してAIに渡す。

```
入力: { site_id: string }

出力:
  site_summary        — 全体統計（セッション数、CVR等）
  behavior_profiles   — 10タイプ別の行動統計（← persona_behavior_profile軸）
  query_intent_by_page — ページ別クエリ意図分布（← persona_query_intent軸）
  ga4_demographics    — GA4年代×性別×デバイスの行動指標（設定時のみ）
  ga4_page_demographics — ページ別年代分布（設定時のみ）
  ga4_interests       — 興味関心カテゴリ（設定時のみ）
  ai_instruction      — AIへのペルソナ生成指示
  _generation_guide   — 出力フォーマット指定
```

GA4が未設定の場合もClickHouse + GSCデータだけでペルソナ生成が動作する（デモグラ推定が「デバイス・流入元・時間帯」のみになる）。

---

## 軸数の推移

| 状態 | 軸数 |
|---|---|
| Phase 1（既存） | 20軸 |
| Phase 2（今回追加） | +12軸 |
| **現在のコード** | **32軸** |
| 設計済み未実装 | +12軸（BigQuery系4、広告系3、その他5） |
| 最終拡張時 | 44軸 |
