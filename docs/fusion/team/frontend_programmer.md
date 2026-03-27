# Frontend Programmer - UGOKI MAP 2.0

## 担当範囲
- `ugokimap/` 配下（TypeScript / Next.js / React）
- `linkscrawl/`（Python/ML）には触らない → ML Programmer領域

---

## タスク1: tracking-ext-behavior.js イベント棚卸し

### 送信イベント一覧

| # | event_type | 送信タイミング | 主なペイロード | 感情推論の意味 |
|---|-----------|--------------|-------------|-------------|
| 1 | `text_copy` | `copy`イベント発火時（即時） | copied_text, copied_length, copy_y, element_path | 比較・評価意図（最強シグナル） |
| 2 | `tab_return` | `visibilitychange`でタブ復帰時（即時） | away_duration_ms, tab_switch_count, return_scroll_y | 他サイトとの比較行動 |
| 3 | `browser_back` | `popstate`イベント発火時（即時） | from_url, scroll_y_at_back, scroll_depth_at_back | 不満足（最強ネガティブシグナル） |
| 4 | `pinch_zoom` | 2本指ズーム検出時（touchmove, scale>1.3x） | zoom_scale, zoom_y, target_tag, target_src, target_alt, element_path, pinch_zoom_count | モバイルでの強い関心 |
| 5 | `scroll_reversal` | ページ離脱時（flush） | reversal_count, final_scroll_y | 混乱・躊躇・再評価 |
| 6 | `cta_hover` | ページ離脱時（flush, 各CTAごとに1件） | element_path, element_text, hover_duration_ms, hover_y, hover_clicked | 購入躊躇（CTAに近づくが押さない） |

### 送信メカニズム
- `CI.track()` = `queueEvent()` → バッチキュー `_q[]` に追加
- バッチ条件: 10件溜まるか、5秒経過で `sendBatch()` → `POST /api/track`
- ページ離脱時: `beforeunload` → `flush()` → `sendBatch()` (`sendBeacon` or `fetch`)

### CTA判定ロジック（_findCta）
- `<button>` タグは全てCTA
- `<a>` タグはclass名 or テキストでマッチ:
  - class: `/cta|btn|button|cart|buy|purchase/i`
  - text: `/購入|買う|申込|カート|詳細|今すぐ|無料|ダウンロード|登録|sign.?up|add.?to|checkout|subscribe|get.?started|try.?free/i`

---

## パイプライン全体図

```
┌─────────────────────────────────────────────────────────────┐
│  Client Browser (tracking-ext-behavior.js)                  │
│                                                             │
│  text_copy ──┐                                              │
│  tab_return ─┤                                              │
│  browser_back┤  CI.track() → queueEvent() → _q[]           │
│  pinch_zoom ─┤       ↓                                      │
│  scroll_rev ─┤  sendBatch() (10件 or 5秒 or ページ離脱)      │
│  cta_hover ──┘       ↓                                      │
│              POST /api/track  {events: [...]}               │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌──────────────────────┴──────────────────────────────────────┐
│  Next.js API: app/api/track/route.ts (POST)                 │
│                                                             │
│  events.forEach → event_type分類:                            │
│    behaviorEventTypes = ['text_copy','scroll_reversal',      │
│      'tab_return','browser_back','pinch_zoom','cta_hover']   │
│       ↓                                                      │
│  pushEventBuffer('clickinsight.behavior_signals', [...])     │
│       ↓ Redis RPUSH                                          │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌──────────────────────┴──────────────────────────────────────┐
│  Redis: event_buffer:pending (LIST)                         │
│  {table: "clickinsight.behavior_signals", values: [...]}    │
└──────────────────────┬──────────────────────────────────────┘
                       ↓ (毎分 Inngest cron)
┌──────────────────────┴──────────────────────────────────────┐
│  Inngest: flush-event-buffer                                │
│  inngest/funcs/flushEventBuffer.ts                          │
│                                                             │
│  popEventBuffer(500) → テーブルごとにグループ化              │
│       ↓                                                      │
│  clickhouse.insert({                                        │
│    table: 'clickinsight.behavior_signals',                  │
│    values: [...],                                           │
│    format: 'JSONEachRow'                                    │
│  })                                                         │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌──────────────────────┴──────────────────────────────────────┐
│  ClickHouse: clickinsight.behavior_signals                  │
│  ENGINE = MergeTree()                                       │
│  ORDER BY (site_id, page_url, event_type, created_at)       │
│  PARTITION BY toYYYYMM(created_at)                          │
│                                                             │
│  Columns:                                                   │
│    id, site_id, session_id, page_url, event_type,           │
│    copied_text, copied_length, copy_y,                      │
│    reversal_count, final_scroll_y,                          │
│    away_duration_ms, tab_switch_count, return_scroll_y,     │
│    from_url, scroll_y_at_back, scroll_depth_at_back,        │
│    zoom_scale, zoom_y, target_tag, target_src, target_alt,  │
│    pinch_zoom_count,                                        │
│    hover_duration_ms, hover_y, hover_clicked,               │
│    element_path, element_text, device_type, created_at      │
└─────────────────────────────────────────────────────────────┘
```

---

## タスク2: behavior_signals データ0件の原因と修正

### 調査結果

**バックエンドパイプライン（API→Redis→Inngest→ClickHouse）は正常。**
- `app/api/track/route.ts` L224-268: 6種のbehaviorイベントを正しく分類・マッピング
- `lib/redis.ts` `pushEventBuffer()`: テーブル名+valuesをJSON化してRPUSH
- `inngest/funcs/flushEventBuffer.ts`: テーブル名ごとにグループ化してClickHouseにINSERT
- ClickHouseスキーマ（`lib/clickhouse/schema.ts`）のカラムとAPI準備データのキーも一致

### 根本原因: クライアント側のスクリプトロード競合

tracking-ext-behavior.js の冒頭:
```js
const CI = window.ClickInsight;
if (!CI) return; // ← ここでサイレント終了
```

GTM（GTM-N8LQNZN4）経由でtracking-ext-behavior.jsを追加した場合、
tracking.js（コアスクリプト）より**先にロード**される可能性がある。
その場合 `window.ClickInsight` が未定義で、**何もせずに終了**する。

tracking.jsの内部 `loadExtensions()` は `async=true` で拡張をロードするため、
通常は `window.ClickInsight` 設定後に拡張がロードされるが、
GTMが独立してロードするスクリプトにはこの保証がない。

### 修正内容

`tracking-ext-behavior.js` にリトライ機構を追加:
- `window.ClickInsight` が存在すれば即 `setup(CI)` を実行
- 存在しなければ100msごとに最大50回（5秒）リトライ
- 全てのロジックを `setup(CI)` 関数でラップ

**修正ファイル**: `ugokimap/public/tracking-ext-behavior.js`

---

## タスク3: フロントエンド構造調査

### 技術スタック
- Next.js 14 (App Router) / React 18 / TypeScript 5
- Tailwind CSS 3.3 + shadcn/ui (Radix UI)
- Zustand 4.4 (状態管理)
- Recharts 2.8 (チャート)
- ClickHouse Client + Redis (ioredis)
- Inngest 3.45 (バックグラウンドジョブ)
- Anthropic Claude SDK (AI分析)
- rrweb (セッションリプレイ)
- heatmap.js (ヒートマップ描画)

### app/ ページ構成

| ルート | 機能 | 主要API |
|--------|------|---------|
| `/dashboard` | KPI概要（イベント数・PV・クリック率・滞在時間・直帰率・スクロール深度） | `/api/statistics` |
| `/heatmap` | クリック/スクロール/読了/画像 ヒートマップ | `/api/heatmap`, `/api/heatmap/query` |
| `/clicks` | 要素別クリック分析 | `/api/clicks` |
| `/cv-paths` | コンバージョンパス（ユーザージャーニー・Sankey図） | `/api/cv-paths` |
| `/form-analysis` | フォーム完了率・フィールド摩擦分析 | `/api/form-analysis` |
| `/element-analysis` | CTA/要素可視性・クリック率 | `/api/element-analysis` |
| `/video-analysis` | 動画再生率・完了率・マイルストーン | `/api/video-analysis` |
| `/image-visibility` | 画像可視性スコア | `/api/image-visibility` |
| `/performance` | Core Web Vitals / PageSpeed | `/api/performance`, `/api/pagespeed` |
| `/realtime` | リアルタイムイベントストリーム | WebSocket (Socket.io) |
| `/ai-insights` | AI分析（CTA最適化提案等） | `/api/ai-insights` |
| `/sites` | サイト管理（登録・一覧） | `/api/sites` |
| `/settings` | ユーザー設定・トラッキングスクリプト表示 | `/api/usage` |
| `/tests` | A/Bテスト管理 | `/api/tests` |
| `/install` | 初期セットアップガイド | - |
| `/auth/login` | ログイン | `/api/auth` |
| `/auth/register` | ユーザー登録 | `/api/auth` |

### ClickHouseテーブルとUI対応

| テーブル | UI | 説明 |
|---------|-----|------|
| `events` | Dashboard, Heatmap, Clicks, CV-Paths, Realtime, Performance | コアイベントログ |
| `sites` | Dashboard, Sites, 全ページ（サイト選択） | サイト登録情報 |
| `heatmap_summary` | Heatmap | 事前集計ヒートマップデータ |
| `image_visibility` | Image Visibility, Heatmap | 画像可視性 |
| `form_interactions` | Form Analysis | フォームイベント |
| `video_events` | Video Analysis | 動画再生イベント |
| `element_visibility` | Element Analysis | 要素可視性 |
| `behavior_signals` | AI Insights（将来） | 感情推論シグナル ← **今回修正対象** |
| `user_mappings` | バックエンドのみ | 匿名ID↔外部IDマッピング |
| `tests` | Tests | A/Bテスト定義 |
| `gsc_data` | GSC連携 | Search Console データ |

### レイアウト構成
- `DashboardLayout` (Header + Sidebar) → 全ページ共通
- `AuthGuard` → 認証保護
- サイドバーメニュー: Dashboard, Heatmap, Performance, Form Analysis, CTA Analysis, Video Analysis, CV Paths, Tests, Site Management, Settings
