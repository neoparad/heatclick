# LINKTH CRAWL 最新アーキテクチャ・全機能・API/MCP/DB 連携仕様書（v1完成版 / 2026-11-04 時点）

作成: 2026-11-04（LINKTH CRAWL 本線 Antigravity セッション `715eaea0-88e0-419b-94a2-944abba12d1d`）
対象: `ugokimap-saas`（融合SaaS：UGOKI MAP × LINKTH CRAWL × AIreceipt）本線セッション（`4f6aeb14-d5e9-4496-b7ad-bd5574b3fd93`）

---

## 1. エグゼクティブサマリー（最新の実数値スペック）

初期計画時の「156種SEO検出・52ツール」からその後の全レーン統合により、現在の `linkscrawl`（本線ブランチ `origin/feature/serp-api` 最新 `ef93e869`）は **以下の規模へ大幅拡張・実装完了** しています。

| 領域 | 実装済み規模（コード実測値） | 内訳・詳細 |
| :--- | :--- | :--- |
| **総検出・評価ルール数** | **計 420+ 項目** | ・統合監査レジストリ（`ISSUE_TYPE_META`）：**294種**（15カテゴリ）<br>・ページ速度専用ルール（`speed_rules`）：**90種**（T1: 67種 + T2: 23種、12ファミリ）<br>・ページ種別連動AI意味監査（`semantic_cascade`）：**16項目 × 7要素**<br>・デザイン崩れ決定論実測 v2（`design_defects`）：**18種**（Tier A 確定事実 14種 + Tier B 品質懸念 4種）<br>・Vision AI デザイン評価ルーブリック（`design_vision`）：**8軸**（計26種の `design_*` を `issues` テーブル＆台帳へ統合永続化） |
| **MCP ツール数** | **全 107 ツール** | クロール・単発取得・SEO/速度/DNS/セキュリティ監査・デザイン抽出/崩れ検出・SERP/被リンク/GSC競合分析・RAG/Answer Engine・UGOKI MAP 行動Fusion/ML予測・自動修正パッチ生成・OEM子テナント管理まで網羅 |
| **REST API ルート数** | **全 180 エンドポイント** | OpenAPI 3.1 完全準拠（`docs/openapi.json`）、TypeScript SDK (`sdk/ts`) & Python SDK (`sdk/python`) 完備 |

---

## 2. 全検出・分析エンジンの完全内訳（410+ 項目の全貌）

### A. 統合監査レジストリ `ISSUE_TYPE_META`（全15カテゴリ・294種）
1. **`infra`（94種：セキュリティ・DNS・メール認証・TLS・AIボット制御・サイトマップ）**
   - **DNS / メール認証 / インフラ（45種）**：DMARC（7種）、SPF（9種）、MX（7種）、DKIM（4種）、MTA-STS / TLS-RPT / BIMI（5種）、CAA / NS / SOA / Dangling CNAME（9種）、DNSSEC（4種）。
   - **Webセキュリティ / CSP / TLS / Cookie（31種）**：CSP品質（`csp_missing`, `csp_unsafe_inline`, `csp_unsafe_eval`, `csp_script_unrestricted`, `csp_runtime_violation` 等9種）、HSTS、Permissions-Policy、Referrer-Policy、Clickjacking、SRI欠落、CORS wildcard、XML-RPC露出、ソースマップ露出（`sourcemap_exposed`）、TLS証明書エラー・レガシーTLS・TLS失敗種別内訳（`pages_by_tls_error_kind`）、Cookie属性欠落等。
   - **AIボット / `llms.txt` / サイトマップ（18種）**：`llms_txt_missing`, `llms_txt_url_issues`, `ai_bot_rules_undefined`, `ai_search_bot_blocked`（GPTBot/ClaudeBot/Google-Extended等のブロック検出）、サイトマップ不整合・`lastmod`異常・アクセスログBot異常（`access_log_bot_anomalies`）。
2. **`perf`（28種：基本パフォーマンス・Core Web Vitals・リソース重量）**
   - `slow_pages`, `lcp_slow_pages`, `cls_high`, `inp_slow`, `render_blocking_css_count`, `page_weight_excessive`, `unused_css`, `unused_js`, `unminified_css_js`, `bfcache_unload`, `brotli_compression_missing`, `missing_browser_cache` 等。
3. **`tech_basic`（27種：基本HTML・メタ・見出し・JS専用リンク）**
   - `h1_issues`, `meta_description_issues`, `duplicate_title`, `canonical_noindex_conflict`, `js_only_links`（CSRでのみ出現するリンク）、`color_scheme` 等。
4. **`indexability`（21種：インデックス制御・正規化競合・Soft 404）**
   - `multiple_canonical_tags`, `xrobots_meta_robots_conflict`, `canonical_to_4xx`, `canonical_to_redirect`, `canonical_to_noindex`, `soft_404_200` 等。
5. **`links`（20種：内部リンク構造・PageRank・外部リンク切れ・アンカー）**
   - `orphan_pages`, `valuable_orphan_pages`, `deep_page`, `broken_links`, `broken_external_links`, `broken_external_5xx`, `nofollow_concentration`, `anchor_text_issues`, Louvain コミュニティ構造偏り（`cross_section_tight_coupling`, `intra_section_fragmentation`, `bridge_pages`）等。
6. **`content`（19種：重複・カニバリ・著者/日付・AI生成マーカー）**
   - `duplicate_content`, `semantic_duplicates`, `author_missing_in_article`, `published_date_missing`, `updated_date_inconsistent`, `ai_generated_content_marker` 等。
7. **`semantic_ai`（16種：ページ種別連動AI意味監査 & J08 意味系検出）**
   - 下記「C. 16項目×7要素の3段カスケード意味監査」と直結。
8. **`structured_data`（15種：Schema.org / JSON-LD 厳密検証）**
   - `missing_schema`, `structured_data_missing_required`, `structured_data_invalid_aggregaterating`, `structured_data_breadcrumb_missing`, `structured_data_organization_incomplete`, `structured_data_invalid_jsonld` 等。
9. **`url`（12種）・`media`（11種）・`hreflang`（9種）・`redirect`（8種）・`mobile`（7種）・`social`（6種）・`intl`（1種）**
   - URL設計問題、画像 `srcset`/`picture`/サイズ不整合、多言語 `hreflang` 相互参照・ループ、リダイレクト鎖/JSリダイレクト、モバイルViewport/タップ領域/フォントサイズ、OGP/Twitterカード等。

---

### B. ページ速度・レンダリング専用エンジン `analyzer/speed_rules`（全12ファミリ・計90ルール + PageSpeed Insights + RUM CWV p75）
単なる PageSpeed API ラッパーではなく、**HTML/CSS/JS/HAR/DOM からなぜ遅いかの根本原因を特定する90種の専用ルール（T1: 67種 + T2: 23種）** を搭載しています（`linkscrawl_speed_inventory` / `linkscrawl_evidence_speed_factors`）：
- **F1 ファーストビュー・LCP (`FV-01`〜`FV-06`)**: ヒーロー画像の lazy-load 誤用、LCP画像の preload 欠落、背景CSS画像によるLCP遅延等。
- **F2 スライダー・カルーセル (`SLD-01`〜`SLD-05`)**: Swiper/Slick 等の初期化ブロッキング、非表示スライド画像の先行読み込み等。
- **F3 画像最適化 (`IMG-01`〜`IMG-14`)**: WebP/AVIF未変換、width/height欠落によるCLS、実表示サイズに対する過大解像度、破損画像（`IMG-08` モード切替対応）等14種。
- **F4 JavaScript (`JS-01`〜`JS-10`)**: `<head>`内同期script、巨大バンドル、長大タスク（Long Tasks）、未使用JS等10種。
- **F5 CSS (`CSS-01`〜`CSS-08`)**: レンダーブロッキングCSS、`@import` 連鎖、肥大化インラインCSS、巨大CSSファイル等8種。
- **F6 Webフォント (`FONT-01`〜`FONT-06`)**: `font-display: swap` 欠落、Google Fonts 同期読み込み、WOFF2未使用、サブセット未適用等6種。
- **F7 ネットワーク・プロトコル (`NET-01`〜`NET-10`)**: TTFB遅延、HTTP/1.1 接続多重化不足、Brotli/Gzip未圧縮、Cache-Control不在、preconnect欠落等10種。
- **F8 リダイレクト (`RED-03`〜`RED-04`)**: 初回ドキュメント・静的アセットのリダイレクト遅延。
- **F9 サードパーティタグ (`3P-01`〜`3P-08`)**: GTM/広告/チャットウィジェット/SNS埋め込みによるメインスレッド占有・通信肥大化等8種。
- **F10 DOM 構造 (`DOM-01`〜`DOM-06`)**: DOMノード数過多（>1,500）、ネスト深度過大、大量の非表示DOM等6種。
- **F11 WordPress 特有ボトルネック (`WP-01`〜`WP-08`)**: `wp-emoji`、jQuery Migrate、プラグインCSS/JS乱立、Admin-Ajax ポーリング等8種。
- **F12 複合ボトルネック (`CMB-01`〜`CMB-08`)**: 「HTTP/1.1 × 大量小ファイル」「LCP画像 × レンダーブロッキングCSS × フォント待機」等の複合原因8種。
- さらに **Google PageSpeed Insights 一括計測（`linkscrawl_pagespeed_batch`）** および **速度タグによる実ユーザー RUM CWV p75 集計（`rum_cwv_p75`）** にも対応。

---

### C. 【独自AI基盤】16項目 × 7要素（Content Asset Value 7 Pillars）の3段カスケード意味監査
- **ページ種別自動判別（`top`, `lp_service`, `listing`, `company`, `article`, `contact`, `faq`, `legal`）** により評価基準を動的に切り替え。
- **Stage 1（Jev 0.18秒フィルタ）→ Stage 2（自社Gemma 4）→ Stage 3（Teacher Verdict カルテ帳）** の3段カスケード。
- **16項目**：`thin_content`, `soft_404`, `boilerplate_high`, `stale_date`, `trust_entity_weak`, `specificity_lacking`, `primary_info_lacking`, `heading_decorative_abuse`（`<h>`タグのデザイン流用5角度検出）、`attribute_coverage_weak`, `comparability_missing`, `unstructured_data_prose`, `title_content_mismatch`, `meta_description_issue`, `entity_schema_weak`, `ai_extractability_poor`, `cta_or_next_step_missing`。
- **7要素レーダースコア（0〜100点）**：`01_volume`（情報量）、`02_uniqueness`（独自性・一次情報）、`03_reliability`（信頼性・E-E-A-T）、`04_specificity`（具体性・数値属性）、`05_structure`（情報構造・見出し設計）、`06_ai_readiness`（AI可読性・AIO引用適性）、`07_discoverability`（回遊性・CTA導線）。
- 加えて **サイト全体の主題一貫性監査（`linkscrawl_topic_audit_ai` / Topical Coherence Score + Outlier Pages）** も搭載。

---

### D. デザイン・UI/UX・アクセシビリティ検査＆生成エンジン（v2 完了：全26種 DB永続化＆下層ページ対応）
1. **デザイン崩れ決定論的実測 18種（`linkscrawl_design_defects` / `linkscrawl_design_defects_batch`）**：
   - LLM不使用・ブラウザ描画実測で以下 **18種（Tier A 確定事実 14種 ＋ Tier B デザイン品質懸念 4種）** を検出し、`shared/design_issue_store.py` 経由で `issues` テーブル＆ `analysis_run_detector_status` 台帳へ自動永続化。下層ページ URL（LPや個別記事・商品ページ）の直接検査にも対応：
   - **Tier A（確定事実：14種）**
     1. `horizontal_overflow`（横スクロール発生）
     2. `element_overflows_viewport`（要素の画面外はみ出し）
     3. `element_overflows_container`（要素の親枠からはみ出し）
     4. `text_clipped`（テキスト切れ・読めない文字）
     5. `empty_element_occupies_space`（空要素による不自然な余白）
     6. `image_aspect_distorted`（画像の縦横比潰れ・伸び）
     7. `image_upscaled`（小画像の引き伸ばしによる粗さ）
     8. `webfont_not_applied`（指定Webフォント未適用）
     9. `tap_target_too_small`（タップ領域狭小）
     10. `element_not_clickable`（他要素の重なりでボタン/リンクが押せない）
     11. `broken_image_rendered`（壊れた画像の描画露出：`naturalWidth === 0` かつ表示領域占有）
     12. `contrast_ratio_insufficient`（文字と背景のコントラスト比不足：WCAG 2.1 AA 4.5:1 / 3.0:1 合成実測）
     13. `text_overlap_collision`（テキスト要素同士の重なり衝突：矩形交差率 35% 以上）
     14. `template_placeholder_leaked`（未展開テンプレート変数 `{{...}}` / `[object Object]` / `undefined` / `Lorem ipsum` の露出）
   - **Tier B（可能性・デザイン品質懸念：4種）**
     15. `sticky_viewport_occlusion`（固定ヘッダー/フッター/追従バナーによる画面占有過多：viewport 高さの 35% 以上）
     16. `input_zoom_trigger_mobile`（モバイル入力欄の `font-size < 16px` による iOS 自動ズーム誘発）
     17. `line_length_excessive`（デスクトップ本文 1 行幅の過長 `> 960px` による可読性低下）
     18. `sibling_card_misaligned`（横並び Flex/Grid 兄弟カード 3 枚以上の高さ不揃い）
2. **デッドボタン実クリック検査（`linkscrawl_click_probe` / `linkscrawl_evidence_dead_buttons`）**：
   - ページ内のボタンを実際にヘッドレスブラウザで操作し、「押しても何も起きない壊れたボタン」を検出。
3. **デザインシステム自動抽出 ＆ トンマナ差し替えプレビュー（`linkscrawl_design_tokens` / `linkscrawl_tonmana_preview`）**：
   - `getComputedStyle` から W3C Design Tokens / CSS Variables / Tailwind Config / 日本語スタイルガイド Markdown を自動生成（G08）。さらに競合や別ブランドのトンマナを構造保持のまま当てはめるプレビュー生成に対応。
4. **Vision AI デザイン8軸評価（`linkscrawl_design_evaluate`）**：
   - フルページスクショをマルチモーダルAIで8軸ルーブリック（配色・コントラスト・余白・タイポグラフィ・視覚階層・CTA視認性・信頼感・一貫性）で採点。
5. **アクセシビリティ監査（`linkscrawl_a11y_audit`）**：axe-core × セマンティック判定。

---

### E. SERP・AI Overview (AIO)・被リンク・競合ギャップ・自動修正パッチ生成
- **Google SERP & AI Overview 分析**：オーガニック検索（`linkscrawl_serp_search`）、SERP全展開（`linkscrawl_serp_full`）、AI Overview引用分析（`linkscrawl_serp_ai_overview`）、画像SERP（`linkscrawl_serp_images`）、ニュースSERP（`linkscrawl_serp_news`）。
- **AIO 引用競合差分（`linkscrawl_aio_citation_diff`）**：AI Overview に引用されている競合ページと自サイトページの構造・E-E-A-T・一次情報シグナルの差分を比較。
- **競合画像ギャップ ＆ Vision API 画像分析（`linkscrawl_analyze_page_images`, `linkscrawl_serp_image_analysis`, `linkscrawl_image_gap_analysis`）**：OCR・ラベル・色・SafeSearch・競合画像との要素比較。
- **外部被リンク ＆ ランクインキーワード分析（`linkscrawl_backlinks`, `linkscrawl_ranked_keywords`）**。
- **自動修正パッチ生成 ＆ 再検証（`linkscrawl_generate_fix_patch`, `linkscrawl_verify_page_fix`）**：検出したSEO課題に対して変更前後のHTML/メタ/JSON-LDコード差分パッチを自動生成し、適用後に課題が解消されたか即座に再検証。

---

### F. UGOKI MAP × LINKTH CRAWL 行動Fusion ＆ 機械学習（ML）エンジン（全13ツール実装済み）
`ugokimap-saas` がそのままSaaSの目玉機能として使える **構造×行動×速度の統合ML/分析ツール群** がすでに実装されています：
1. `linkscrawl_sync_to_ugokimap`: クロール構造・PageRank・課題・Bot判定シグナル（J06 `audit_ugoki_session_bot_signals`）を ClickHouse に同期。
2. `linkscrawl_content_map` / `linkscrawl_content_map_batch`: ページのセクションY座標マップ＋フルページスクショを生成。
3. `linkscrawl_behavior_fusion`: UGOKI MAP の行動異常（rage_click・長時間滞留・画像注視）と `page_content_map` を座標突合。
4. `linkscrawl_section_analysis`: Layer 2 セクション別行動分析（見出しセクション単位の click / dead_click / rage_click / 離脱率・Friction Hotspot 検出）。
5. `linkscrawl_performance_fusion`: PageSpeed（LCP/CLS/TTFB）× 行動データ（bounce / rage_click / デバイス別CVR）の5パターン突合で **CV損失数を定量化**。
6. `linkscrawl_ml_train` / `linkscrawl_ml_status`: K-Means ペルソナ分類 & Gradient Boosting 感情予測モデルの学習・状態管理。
7. `linkscrawl_ml_persona`: 行動パターン（スクロール速度・滞在時間・rage_click等）からセッションをペルソナに自動分類。
8. `linkscrawl_ml_emotion`: 行動シグナルからユーザー感情（迷い・苛立ち・関心・確信等）を予測。
9. `linkscrawl_ml_scroll_survival`: **Kaplan-Meier スクロール生存分析**（Y座標別の生存率曲線、CV者 vs 非CV者の離脱集中ポイント比較）。
10. `linkscrawl_ml_session_quality`: 30軸の行動データを 0〜100（A〜Fランク）のセッション品質スコアに集約。
11. `linkscrawl_ml_cvr_predict`: **構造×行動×速度の 80+ 特徴量から CVR を予測**し、改善ポテンシャルの高いページをランキング。
12. `linkscrawl_ml_impact_ranking`: 感情ラベル別のセッション数・CVR・推定CV増加数から施策インパクト順を算出。
13. `linkscrawl_generate_proposals`: ペルソナ＋スクロール生存＋セクション分析＋構造監査を統合し、日本語の改善施策提案を自動生成。

---

### G. 厳密引用保証 RAG ＆ Answer Engine（18ツール連携）＆ ドキュメント解析・エクスポート
- **RAG & Answer Engine（P0〜P2 ＆ Jev リランキング完了）**：
  - 親子チャンク（250字子 / 1,500字親）＋ 384次元ベクトル検索 ＋ 日本語自然文 SQL Exact ＋ `jev_rerank_and_diversify`（見出し/数値/表構造加点＋同一ページ最大2チャンク制限）。
  - Answer Engine が18ツール（`find_pages` → `page_text` の 2-hop URL自動解決含む）を自律実行。
  - `verify_citation`（一字一句の包含検証）＋ 凍結 `evidence_ref`（HMAC署名）＋ `linkscrawl_verify_ai_citations`（X01: 外部AI回答の事実検証ツール）。
- **オフィス文書・PDF・アーカイブ解析（`shared/document_parse`）**：
  - HTMLだけでなくサイト内の PDF / Word (`docx`) / Excel (`xlsx`, `xls`, `xlsb`, `ods`：純Python数式評価・チャートシート読取・非表示行列保持) / PowerPoint (`pptx`, `ppt`, `odp`：スライド単位分割・スピーカーノート抽出) / CSV（日中韓エンコーディング自動判定・16,384列超対応）まで構造化抽出。
- **多彩なエクスポート（Screaming Frog / ahrefs / Firecrawl 互換）**：
  - `linkscrawl_export`（CSV / TSV / xlsx / JSON ストリーミングダウンロード）、`linkscrawl_export_master`（1行1URLマスターCSV）、`linkscrawl_export_issues`（ahrefs相当の課題別一括出力）、`linkscrawl_export_markdown`（LLM学習用Markdownコーパス）、`linkscrawl_audit_report`（Markdown & 印刷対応スタンドアロンHTML5）。

---

## 3. ユーザーによる取得データ制限・パフォーマンス＆クレジット制御（`shared/acquisition_modes.py`）

これだけ膨大な機能があるため、ユーザーが重さやクレジット消費を自在にコントロールできるようモジュラー制御を実装済みです：
- `mode`: `"fast"`（軽量HTTPのみ） / `"standard"`（標準監査） / `"rendered"`（ブラウザ描画＋CWV） / `"rag"`（RAG索引化込み） / `"full"`
- `options.speed.har` (`bool`): `false` で重い HAR 記録をOFF。
- `options.audit.semantic_mode` (`"off" | "jev_only" | "cascade"`): AI意味監査の負荷を3段階（OFF / 0.18秒Jevのみ / 3段カスケード）で切り替え。
- `options.screenshot.enabled` / `options.index.rag`: スクショやベクトル索引化も個別にON/OFF可能。
- `shared/credit_schedule.py` & `shared/credit_meter.py`: 選択したオプションに応じてクレジット消費倍率を自動計算し、月間上限到達時は HTTP 402 で安全に停止。

---

## 4. URL 正規化・サイト同一性の共通キー（`ugokimap-saas` 連携の基盤）

1. **URL 正規化・比較キー**：
   - `shared/url_canon.py` および `shared/utils.py` の `url_match_key(url)` / SQL式 `url_match_key_sql("url")`
   - `http`/`https`、先頭 `www.` の有無、末尾スラッシュ `/` の有無、`#fragment` を吸収して同一URLとして結合可能。
2. **サイト（登録可能ドメイン）正規化・所有確認**：
   - `shared/registrable_domain.py` & `shared/site_ownership.py`（DNS TXT / HTML meta / ファイルによるドメイン所有確認 `site_verifications` テーブル完備）。
3. **OEM マルチテナント管理**：
   - `linkscrawl_oem_list_sub_tenants` / `get_sub_tenant` / `create_sub_tenant` により、代理店・OEM親テナントが子テナント（エンド顧客）を発行・クォータ管理する機能も実装済み。
