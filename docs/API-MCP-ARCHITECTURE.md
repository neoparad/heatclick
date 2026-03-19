# UGOKI MAP — API / MCP アーキテクチャ設計書

**作成日**: 2026-03-19
**バージョン**: 1.0
**ステータス**: 設計完了 / 実装Phase 1完了

---

## 1. 概要

UGOKI MAPは、Webサイト上のユーザー行動データを**要素レベル**で収集し、コンバージョン（CV）との因果関係を分析するプラットフォームである。

本ドキュメントは、収集したデータを**API**および**MCP（Model Context Protocol）** 経由で外部システム・AIに提供するアーキテクチャを定義する。

### 提供形態

| 形態 | 対象 | ユースケース |
|---|---|---|
| **SaaS** | エンドユーザー | ダッシュボードでヒートマップ・分析を閲覧 |
| **REST API** | 開発者・代理店 | 自社システムにUGOKI MAPデータを統合 |
| **MCP Server** | AIエージェント | Claude/ChatGPT等がリアルタイムでUX分析を実行 |

---

## 2. データパイプライン

```
[ユーザーのブラウザ]
    │  tracking.js (コア 6.88KB + 拡張6本)
    │  クリック / スクロール / 熟読 / 画像視認 / 動画 / フォーム / 要素可視性
    │  + GA4 client_id 自動取得
    ▼
[/api/track]  ← 公開API、認証不要
    │  バリデーション → Redis RPUSH（即レスポンス返却）
    ▼
[Redis バッファ]
    │  event_buffer:pending
    ▼
[Inngest flushEventBuffer]  ← 毎分cron
    │  LRANGE + LTRIM → テーブル別バッチINSERT
    │  失敗 → retry buffer → 5分後再試行 → 2回失敗で破棄+ログ
    ▼
[ClickHouse]
    ├── events            ← 全イベント（コアテーブル）
    ├── image_visibility  ← 画像視認データ
    ├── video_events      ← 動画視聴データ
    ├── form_interactions ← フォーム操作データ
    ├── element_visibility← CTA/バナー可視性
    ├── sessions          ← セッション集約
    └── heatmap_daily_summary ← 日次集約（Inngest aggregateDaily）
```

### データ量の目安

| 規模 | 月間PV | events行数/月 | ストレージ |
|---|---|---|---|
| 小規模サイト | 5,000 | ~50,000 | ~50MB |
| 中規模サイト | 50,000 | ~500,000 | ~500MB |
| 大規模サイト | 500,000 | ~5,000,000 | ~5GB |

---

## 3. eventsテーブル スキーマ

```sql
CREATE TABLE clickinsight.events (
  id String,
  site_id String,
  session_id String,
  user_id Nullable(String),
  ga_client_id Nullable(String),        -- GA4 BigQuery連携用
  event_type String,                     -- pageview, click, scroll, read_area, rage_click, dead_click, scroll_depth, ...
  timestamp DateTime,
  url String,
  referrer Nullable(String),
  user_agent String,
  viewport_width UInt16,
  viewport_height UInt16,
  element_tag_name Nullable(String),
  element_id Nullable(String),
  element_class_name Nullable(String),
  element_text Nullable(String),
  element_href Nullable(String),
  click_x UInt16,
  click_y UInt16,
  scroll_y UInt16,
  scroll_percentage UInt8,
  read_y UInt16 DEFAULT 0,
  read_duration Float32 DEFAULT 0,
  event_revenue Decimal(10, 2) DEFAULT 0,
  utm_source Nullable(String),
  utm_medium Nullable(String),
  utm_campaign Nullable(String),
  utm_term Nullable(String),
  utm_content Nullable(String),
  gclid Nullable(String),
  fbclid Nullable(String),
  conversion_type Nullable(String),
  conversion_value Decimal(10, 2) DEFAULT 0,
  search_query Nullable(String),
  device_type Nullable(String),
  received_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, timestamp)
PARTITION BY toYYYYMM(timestamp)
```

---

## 4. 分析エンジン — 20軸レジストリ

### 4.1 設計思想

**問題**: ClickHouseに数百万行のイベントデータがあるが、そのまま返すのは不可能。
**解決**: 「生データ」ではなく「分析軸ごとに集約済みのインサイト」を返す。

各分析軸は以下で構成される：

```typescript
interface AnalysisAxis {
  id: string            // 一意識別子
  name: string          // 人間向けの名前
  description: string   // 説明
  category: string      // conversion | engagement | friction | persona | traffic | demographic
  query: string         // ClickHouse SQLテンプレート（パラメータ化）
  requiredParams: string[]  // 必須パラメータ
  aiPromptHint: string  // AIがこの結果をどう解釈すべきかのヒント
}
```

### 4.2 実装済み20軸

#### Conversion（4軸）

| ID | 名前 | 出力 |
|---|---|---|
| `cv_behavior_diff` | CV vs 非CV 行動差分 | セッション別の行動シーケンス、熟読時間、画像閲覧数、スクロール深度、摩擦クリック数 |
| `element_cv_contribution` | 要素レベルCV寄与度 | CVした人がクリックした要素TOP30 |
| `multi_session_cv` | マルチセッションCV | 何回目の訪問でCVに至るかの分布 |
| `lp_source_cv` | LP×流入元×CV | ランディングページ×流入元の組み合わせ別CVR・売上 |

#### Engagement（6軸）

| ID | 名前 | 出力 |
|---|---|---|
| `image_cv_correlation` | 画像視認×CV | 画像ごとの、CV者/非CV者の平均視認時間差 |
| `video_cv_correlation` | 動画視聴×CV | 動画マイルストーン到達別CVR |
| `reading_area_cv` | 熟読エリア×CV | ページY座標帯ごとのCV者/非CV者の熟読時間差 |
| `content_type_effectiveness` | コンテンツタイプ別効果 | テキスト/画像/動画のCV寄与度比較 |
| `cta_visibility_clickrate` | CTA可視性×クリック率 | 表示時間が長いのにクリックされていない要素 |
| `atf_vs_btf` | ATF vs BTF | ファーストビュー/ビロウザフォールドの滞在時間比率 |

#### Friction（4軸）

| ID | 名前 | 出力 |
|---|---|---|
| `form_friction` | フォーム離脱摩擦 | フィールド別の離脱率・平均入力時間 |
| `rage_dead_clicks` | rage/dead clickマップ | UI摩擦が集中しているY座標帯と要素 |
| `confusion_scrolling` | 迷い行動検出 | 上下スクロール往復が多いページ |
| `cta_hesitation` | CTAクリック迷い時間 | ページ到着からCTAクリックまでの平均時間 |

#### Persona / Segments（3軸）

| ID | 名前 | 出力 |
|---|---|---|
| `new_vs_returning` | 新規 vs リピーター | 行動差分（PV数、スクロール、滞在時間、CVR） |
| `scroll_speed_persona` | スクロール速度ペルソナ | skimmer/normal/careful_readerの3群×CVR |
| `page_journey` | ページ遷移ジャーニー | CV者の典型的なページ遷移パターンTOP30 |

#### Traffic（3軸）

| ID | 名前 | 出力 |
|---|---|---|
| `source_behavior_cv` | 流入元×行動×CV | UTM別のスクロール、滞在、クリック、CVR |
| `hourly_pattern` | 時間帯パターン | 時間帯別セッション数・CVR |
| `weekday_device_cv` | 曜日×デバイス×CV | 曜日×デバイスの組み合わせ別CVR |

### 4.3 軸の追加方法

```typescript
import { analysisAxes } from '@/lib/analysis-axes'

analysisAxes.set('my_new_axis', {
  id: 'my_new_axis',
  name: '新しい分析軸',
  description: '説明',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'AIへの解釈指示',
  query: `SELECT ... FROM clickinsight.events WHERE site_id = {site_id:String} ...`,
})
```

**1軸追加 = 1回のMap.set()呼び出し。** APIルート、MCP定義、UIの変更は不要。

---

## 5. REST API 設計

### 5.1 認証

```
Authorization: Bearer <JWT>
Cookie: ugokimap_token=<JWT>
```

全APIルート（`/api/track`、`/api/health`除く）はmiddleware.tsでJWT検証済み。
`x-user-id`ヘッダがAPIハンドラに自動注入される。

### 5.2 エンドポイント

#### Layer 1: サマリー（軽量、即レスポンス）

```
GET /api/v1/insights/{site_id}/summary
```

レスポンス:
```json
{
  "site_id": "xxx",
  "period": { "start": "2026-03-01", "end": "2026-03-19" },
  "summary": {
    "total_sessions": 12450,
    "cvr": 3.2,
    "avg_scroll_depth": 62,
    "avg_session_duration_sec": 187,
    "top_friction_pages": [...],
    "top_converting_pages": [...]
  }
}
```

#### Layer 2: 分析軸（中量、数秒）

```
GET /api/v1/insights/{site_id}/axis/{axis_id}
    ?start_date=2026-03-01
    &end_date=2026-03-19
```

レスポンス:
```json
{
  "axis": {
    "id": "image_cv_correlation",
    "name": "画像視認×CV相関",
    "category": "engagement"
  },
  "data": [
    { "image_src": "/hero.jpg", "cv_avg_ms": 8200, "noncv_avg_ms": 1100, "cv_sessions": 45, "noncv_sessions": 320 },
    ...
  ],
  "ai_prompt_hint": "CVとの相関が強い画像を特定し..."
}
```

```
GET /api/v1/insights/{site_id}/axes
```
→ 利用可能な全軸の一覧を返す

```
POST /api/v1/insights/{site_id}/multi-axis
Body: { "axes": ["cv_behavior_diff", "image_cv_correlation", "form_friction"] }
```
→ 複数軸を一括実行（AI診断用）

#### Layer 3: AI診断（重量、非同期）

```
POST /api/v1/insights/{site_id}/ai-diagnosis
Body: {
  "axes": ["all"],  // or specific axis IDs
  "model": "claude",  // or "openai"
  "output": "json"   // or "markdown"
}
```

レスポンス（非同期 → ポーリングまたはWebhook）:
```json
{
  "job_id": "diag-xxx",
  "status": "processing",
  "poll_url": "/api/v1/insights/{site_id}/ai-diagnosis/diag-xxx"
}
```

完了時:
```json
{
  "status": "completed",
  "diagnosis": {
    "personas": [
      {
        "name": "即決型",
        "percentage": 22,
        "characteristics": "商品画像を8秒以上注視、FAQ未読、CTA即クリック",
        "journey": ["LP", "商品詳細", "CTA", "CV"],
        "recommendations": ["ファーストビューに価格を明示", "即決向けLPバリアント作成"]
      },
      ...
    ],
    "top_improvements": [
      { "priority": 1, "action": "商品画像Bをファーストビューに移動", "expected_impact": "+12% CVR", "evidence": "画像視認×CV: cv_avg_ms=8200, noncv_avg_ms=1100" },
      ...
    ],
    "friction_map": [...],
    "content_strategy": [...]
  }
}
```

---

## 6. MCP Server 設計

### 6.1 MCP概要

MCP (Model Context Protocol) は、AIエージェントが外部ツールにアクセスするための標準プロトコル。
UGOKI MAPをMCPサーバーとして提供することで、Claude/ChatGPT等のAIが直接UX分析データを取得・分析できる。

### 6.2 MCP Tool定義

```typescript
// MCP Server が公開するツール一覧

tools: [
  {
    name: "ugokimap_list_sites",
    description: "ユーザーが管理しているサイトの一覧を取得",
    inputSchema: {},
  },
  {
    name: "ugokimap_site_summary",
    description: "サイトのアクセス概要（セッション数、CVR、平均滞在時間、スクロール深度）を取得",
    inputSchema: {
      site_id: { type: "string", required: true },
      start_date: { type: "string" },
      end_date: { type: "string" },
    },
  },
  {
    name: "ugokimap_analyze",
    description: "指定した分析軸でサイトのユーザー行動を分析。20軸から選択可能。軸の一覧はugokimap_list_axesで取得。",
    inputSchema: {
      site_id: { type: "string", required: true },
      axis_id: { type: "string", required: true, description: "分析軸ID（例: image_cv_correlation, form_friction, page_journey）" },
      start_date: { type: "string" },
      end_date: { type: "string" },
    },
  },
  {
    name: "ugokimap_list_axes",
    description: "利用可能な分析軸の一覧を取得（ID、名前、説明、カテゴリ）",
    inputSchema: {},
  },
  {
    name: "ugokimap_multi_analyze",
    description: "複数の分析軸を一括実行し、総合的なUX診断の材料を取得",
    inputSchema: {
      site_id: { type: "string", required: true },
      axes: { type: "array", items: { type: "string" }, description: "軸IDの配列。省略時は全軸実行" },
    },
  },
  {
    name: "ugokimap_heatmap_data",
    description: "指定ページのヒートマップデータ（クリック座標、スクロール深度、熟読エリア）を取得",
    inputSchema: {
      site_id: { type: "string", required: true },
      page_url: { type: "string", required: true },
      heatmap_type: { type: "string", enum: ["click", "scroll", "read"], default: "click" },
      device_type: { type: "string", enum: ["all", "desktop", "tablet", "mobile"], default: "all" },
    },
  },
  {
    name: "ugokimap_page_friction",
    description: "指定ページのUX摩擦ポイント（rage click、dead click、迷い行動、フォーム離脱）をまとめて取得",
    inputSchema: {
      site_id: { type: "string", required: true },
      page_url: { type: "string", required: true },
    },
  },
]
```

### 6.3 MCPの利用例（Claude Desktop/Claude Codeから）

```
ユーザー: 「このサイトのCVRが低い原因を分析して」

Claude:
  1. ugokimap_list_sites → サイト一覧取得
  2. ugokimap_site_summary → 概要確認（CVR 1.8%）
  3. ugokimap_multi_analyze(axes: ["cv_behavior_diff", "image_cv_correlation", "form_friction", "cta_hesitation"]) → 4軸分析
  4. 結果を統合して回答:

  「CVRが低い主な原因は3つです:
   1. フォームの電話番号フィールドで68%が離脱（form_friction）
   2. メイン商品画像の視認時間がCV者で8.2秒、非CV者で1.1秒 — ファーストビューに配置されていない（image_cv_correlation）
   3. CTAボタンまで平均47秒迷っている。直前に安心材料がない（cta_hesitation）

   推奨改善:
   - 電話番号フィールドを任意化（期待CVR +15%）
   - 商品画像をファーストビューに移動（期待CVR +12%）
   - CTA直前に「30日間返金保証」バッジを配置（期待CVR +8%）」
```

### 6.4 MCPのデータ量制御

| ツール | 返却データ量 | レイテンシ |
|---|---|---|
| `site_summary` | ~1KB | <500ms |
| `analyze`（1軸） | ~5-50KB（30-1000行） | 1-5秒 |
| `multi_analyze`（全軸） | ~100-500KB | 10-30秒 |
| `heatmap_data` | ~50-200KB（最大1000座標点） | 1-3秒 |
| `page_friction` | ~10-50KB | 2-5秒 |

**全軸一括でも500KB以下。** MCPのコンテキストウィンドウに十分収まる。
各軸のクエリがLIMIT付きで最大30-1000行に制限されているため、データ爆発しない。

---

## 7. GA4 / BigQuery 連携

### 7.1 現在の実装

- tracking.jsが`_ga`クッキーからGA4 client_idを自動読み取り
- eventsテーブルの`ga_client_id`カラムに保存
- **追加コストゼロで全イベントにGA4 client_idが付与される**

### 7.2 BigQuery連携時に使えるデモグラフィック軸

GA4 → BigQueryエクスポート（無料）を有効化すると、以下のJOINが可能になる：

```sql
SELECT
  ga.user_properties.age_bracket,     -- 年齢帯
  ga.user_properties.gender,          -- 性別
  ga.geo.country,                     -- 国
  ga.geo.region,                      -- 地域
  ga.device.category,                 -- デバイス（GA4側）
  -- UGOKI MAP側
  avg(um.read_duration) as avg_read_ms,
  max(um.scroll_percentage) as max_scroll,
  count(CASE WHEN um.event_type = 'click' THEN 1 END) as clicks,
  max(um.conversion_type IS NOT NULL) as converted
FROM clickinsight.events um
JOIN bigquery_ga4.events ga
  ON um.ga_client_id = ga.user_pseudo_id
  AND toDate(um.timestamp) = toDate(ga.event_timestamp)
WHERE um.site_id = {site_id}
GROUP BY age_bracket, gender, country, region, ga.device.category
```

### 7.3 デモグラフィック軸（将来追加）

| 軸ID | 名前 | 内容 |
|---|---|---|
| `age_behavior` | 年代別行動パターン | 年齢帯×スクロール深度×熟読時間×CVR |
| `gender_content` | 性別×コンテンツ効果 | 性別×画像視認時間×動画視聴率×CVR |
| `region_cv` | 地域×CV | 都道府県×CVR×平均注文額 |
| `demo_persona` | デモグラ×ペルソナ | 年齢×性別×行動ペルソナの三次元マトリクス |

**追加方法**: `analysisAxes.set()`に1軸追加するだけ。APIルート・MCP定義の変更不要。

---

## 8. セキュリティ

| 項目 | 実装 |
|---|---|
| API認証 | JWT（HS256、24h有効）、middleware.tsで全API強制 |
| トラッキングAPI | 公開（認証不要）、Redis Rate Limiting（100req/15min） |
| マルチテナント | x-user-idヘッダ注入、verifySiteAccess()で所有権検証 |
| データプライバシー | PIIマスク（メール/電話/クレカ）、IP匿名化、GDPR opt-out対応 |
| CORS | /api/track: 全オリジン許可、その他: 管理画面ドメイン限定 |
| MCP認証 | Bearer Token（API keyベース、SaaS管理画面で発行） |

---

## 9. 競合不可能な点

1. **要素レベルの行動×CV突き合わせ**: click_x/y、画像視認ms、動画進捗%、フォームフィールド滞在ms — 全てCVデータと1クエリでJOIN可能
2. **MCP提供**: AIエージェントがリアルタイムでUX分析を実行できるヒートマップツールは市場に存在しない
3. **20軸分析エンジン**: 各軸にAIプロンプトヒント付き。AIが「何をどう解釈すべきか」まで構造化されている
4. **GA4デモグラフィック連携**: _gaクッキー読み取りだけで年齢/性別/地域の分析が可能になる
5. **拡張性**: 新しい分析軸 = SQL 1個追加。API/MCP/UIの変更不要

---

## 10. 実装ステータス

| コンポーネント | 状態 |
|---|---|
| データパイプライン（tracking→Redis→ClickHouse） | **実装済み** |
| 20軸分析エンジン（lib/analysis-axes.ts） | **実装済み**（コスト制御付き） |
| GA4 client_id取得（tracking.js） | **実装済み** |
| Redisバッファ原子性（Luaスクリプト） | **実装済み** |
| APIキー別Rate Limiting | **実装済み** |
| REST API Layer 1（サマリー） | **実装済み** `/api/v1/insights/{site_id}` |
| REST API Layer 2（軸別分析） | **実装済み** `/api/v1/insights/{site_id}/axis/{axis_id}` |
| REST API Layer 2（複数軸一括） | **実装済み** `/api/v1/insights/{site_id}/multi` |
| REST API Layer 3（AI診断） | 未実装 |
| MCP Server（7ツール） | **実装済み** `mcp-server.ts` |
| BigQuery連携（GA4デモグラフィック） | 未実装（ga_client_idは取得済み） |
