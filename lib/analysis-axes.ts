/**
 * 分析軸レジストリ
 *
 * 新しい軸の追加方法:
 *   analysisAxes.set('new_axis_name', { ... })
 *
 * 使い方:
 *   const axis = analysisAxes.get('cv_behavior_diff')
 *   const result = await executeAxis(clickhouse, 'cv_behavior_diff', { site_id: '...' })
 */

export interface AnalysisAxis {
  id: string
  name: string
  description: string
  category: 'conversion' | 'engagement' | 'friction' | 'persona' | 'content' | 'traffic' | 'demographic' | 'seo' | 'cognitive' | 'meta'
  query: string
  requiredParams: string[]
  aiPromptHint: string
  // クエリコスト: light(<1s), medium(1-5s), heavy(5s+, ウィンドウ関数/CROSS JOIN含む)
  cost: 'light' | 'medium' | 'heavy'
}

export const analysisAxes = new Map<string, AnalysisAxis>()

// --- Conversion ---

analysisAxes.set('cv_behavior_diff', {
  id: 'cv_behavior_diff',
  name: 'CV vs 非CV 行動差分',
  description: 'CVした人としなかった人の行動パターンの違いを抽出',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'event_sequenceからCVに至る典型パターンを抽出し、3-5個のペルソナに分類してください。各ペルソナの特徴と推奨施策を出力してください。',
  cost: 'heavy',
  query: `
    SELECT session_id,
      max(conversion_type IS NOT NULL) as converted,
      groupArray(event_type) as event_sequence,
      avg(read_duration) as avg_read_time,
      count(CASE WHEN event_type = 'image_visibility' THEN 1 END) as images_viewed,
      max(scroll_percentage) as max_scroll,
      dateDiff('second', min(timestamp), max(timestamp)) as session_duration_sec,
      count(CASE WHEN event_type = 'click' THEN 1 END) as total_clicks,
      count(CASE WHEN event_type IN ('rage_click','dead_click') THEN 1 END) as friction_clicks
    FROM clickinsight.events
    WHERE site_id = {site_id:String}
    GROUP BY session_id
    ORDER BY converted DESC
    LIMIT 1000
  `,
})

analysisAxes.set('element_cv_contribution', {
  id: 'element_cv_contribution',
  name: '要素レベルCV寄与度',
  description: 'CVした人がクリックした要素のランキング',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVに寄与している要素と、寄与していない要素を比較し、CTAの改善提案を出してください。',
  cost: 'medium',
  query: `
    SELECT element_text, element_href, element_tag_name,
      count() as click_count, uniq(session_id) as unique_sessions
    FROM clickinsight.events
    WHERE site_id = {site_id:String} AND event_type = 'click'
      AND session_id IN (
        SELECT DISTINCT session_id FROM clickinsight.events
        WHERE conversion_type IS NOT NULL AND site_id = {site_id:String}
      )
    GROUP BY element_text, element_href, element_tag_name
    ORDER BY unique_sessions DESC LIMIT 30
  `,
})

analysisAxes.set('multi_session_cv', {
  id: 'multi_session_cv',
  name: 'マルチセッションCV分析',
  description: '何回目の訪問でCVに至るか',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVまでの訪問回数の分布から、リマーケティング戦略と初回/再訪のLP切り替え提案を出してください。',
  cost: 'medium',
  query: `
    SELECT session_rank, count() as cv_count,
      count() / sum(count()) OVER () * 100 as pct
    FROM (
      SELECT session_id, user_id,
        row_number() OVER (PARTITION BY user_id ORDER BY min(timestamp)) as session_rank
      FROM clickinsight.events WHERE site_id = {site_id:String}
        AND session_id IN (
          SELECT DISTINCT session_id FROM clickinsight.events
          WHERE conversion_type IS NOT NULL AND site_id = {site_id:String}
        )
      GROUP BY session_id, user_id
    )
    GROUP BY session_rank ORDER BY session_rank LIMIT 20
  `,
})

analysisAxes.set('lp_source_cv', {
  id: 'lp_source_cv',
  name: 'LP×流入元×CV',
  description: 'ランディングページと流入元の組み合わせ別CVR',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVRが高い/低いLP×流入元の組み合わせを特定し、広告費の再配分と各LPの改善提案を出してください。',
  cost: 'medium',
  query: `
    SELECT landing_page, utm_source, utm_medium,
      count() as sessions,
      countIf(converted = 1) / count() * 100 as cvr,
      sum(conversion_value) as total_revenue
    FROM (
      SELECT session_id,
        argMin(url, timestamp) as landing_page,
        any(utm_source) as utm_source, any(utm_medium) as utm_medium,
        max(conversion_type IS NOT NULL) as converted,
        max(conversion_value) as conversion_value
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    )
    GROUP BY landing_page, utm_source, utm_medium
    HAVING sessions >= 5
    ORDER BY cvr DESC LIMIT 50
  `,
})

// --- Engagement ---

analysisAxes.set('image_cv_correlation', {
  id: 'image_cv_correlation',
  name: '画像視認×CV相関',
  description: 'CVした人としなかった人の画像ごとの視認時間差',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVとの相関が強い画像を特定し、配置変更・差し替え・強調の具体的提案を出してください。',
  cost: 'medium',
  query: `
    SELECT iv.image_src, iv.image_alt,
      avgIf(iv.visible_duration_ms, e.converted = 1) as cv_avg_ms,
      avgIf(iv.visible_duration_ms, e.converted = 0) as noncv_avg_ms,
      countIf(e.converted = 1) as cv_sessions,
      countIf(e.converted = 0) as noncv_sessions
    FROM clickinsight.image_visibility iv
    JOIN (
      SELECT session_id, max(conversion_type IS NOT NULL) as converted
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    ) e ON iv.session_id = e.session_id
    WHERE iv.site_id = {site_id:String}
    GROUP BY iv.image_src, iv.image_alt
    HAVING cv_sessions + noncv_sessions >= 5
    ORDER BY cv_avg_ms - noncv_avg_ms DESC LIMIT 30
  `,
})

analysisAxes.set('video_cv_correlation', {
  id: 'video_cv_correlation',
  name: '動画視聴×CV',
  description: '動画の視聴到達地点別CVR',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: '動画のどの地点まで見るとCVRが跳ね上がるかを特定し、動画の長さ・CTAオーバーレイ位置の提案を出してください。',
  cost: 'medium',
  query: `
    SELECT ve.video_src, ve.video_milestone,
      countIf(e.converted = 1) as cv_count,
      countIf(e.converted = 0) as noncv_count,
      cv_count / greatest(cv_count + noncv_count, 1) * 100 as cv_rate
    FROM clickinsight.video_events ve
    JOIN (
      SELECT session_id, max(conversion_type IS NOT NULL) as converted
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    ) e ON ve.session_id = e.session_id
    WHERE ve.site_id = {site_id:String} AND ve.event_type = 'video_milestone'
    GROUP BY ve.video_src, ve.video_milestone
    ORDER BY ve.video_src, ve.video_milestone
  `,
})

analysisAxes.set('reading_area_cv', {
  id: 'reading_area_cv',
  name: '熟読エリア×CV',
  description: 'ページのどの部分を熟読するとCVに繋がるか',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVした人が熟読したセクションを特定し、そのコンテンツの強化・位置変更の提案を出してください。',
  cost: 'medium',
  query: `
    SELECT url,
      intDiv(read_y, 200) * 200 as y_zone,
      avgIf(read_duration, converted = 1) as cv_read_ms,
      avgIf(read_duration, converted = 0) as noncv_read_ms,
      countIf(converted = 1) as cv_sessions,
      countIf(converted = 0) as noncv_sessions
    FROM (
      SELECT url, read_y, read_duration, session_id,
        max(conversion_type IS NOT NULL) OVER (PARTITION BY session_id) as converted
      FROM clickinsight.events
      WHERE site_id = {site_id:String} AND event_type = 'read_area' AND read_y > 0
    )
    GROUP BY url, y_zone
    HAVING cv_sessions >= 3
    ORDER BY cv_read_ms - noncv_read_ms DESC LIMIT 50
  `,
})

analysisAxes.set('content_type_effectiveness', {
  id: 'content_type_effectiveness',
  name: 'コンテンツタイプ別効果',
  description: 'テキスト熟読・画像視認・動画視聴のどれがCVに効くか',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: 'テキスト/画像/動画のどのコンテンツタイプがCVに最も寄与しているかを判定し、コンテンツ制作リソースの配分提案を出してください。',
  cost: 'heavy',
  query: `
    SELECT 'text' as content_type,
      avgIf(total_ms, converted=1) as cv_engagement_ms,
      avgIf(total_ms, converted=0) as noncv_engagement_ms
    FROM (
      SELECT session_id, sum(read_duration) as total_ms,
        max(conversion_type IS NOT NULL) as converted
      FROM clickinsight.events WHERE site_id = {site_id:String} AND event_type = 'read_area'
      GROUP BY session_id
    )
    UNION ALL
    SELECT 'image',
      avgIf(total_ms, converted=1), avgIf(total_ms, converted=0)
    FROM (
      SELECT iv.session_id, sum(iv.visible_duration_ms) as total_ms,
        max(e.conversion_type IS NOT NULL) as converted
      FROM clickinsight.image_visibility iv
      JOIN clickinsight.events e ON iv.session_id = e.session_id AND e.site_id = {site_id:String}
      WHERE iv.site_id = {site_id:String}
      GROUP BY iv.session_id
    )
    UNION ALL
    SELECT 'video',
      avgIf(total_ms, converted=1), avgIf(total_ms, converted=0)
    FROM (
      SELECT ve.session_id, sum(ve.video_played_ms) as total_ms,
        max(e.conversion_type IS NOT NULL) as converted
      FROM clickinsight.video_events ve
      JOIN clickinsight.events e ON ve.session_id = e.session_id AND e.site_id = {site_id:String}
      WHERE ve.site_id = {site_id:String}
      GROUP BY ve.session_id
    )
  `,
})

analysisAxes.set('cta_visibility_clickrate', {
  id: 'cta_visibility_clickrate',
  name: 'CTA可視性×クリック率',
  description: '見えているのにクリックされていないCTA/バナーの検出',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: '可視時間が長いのにクリック率が低い要素を特定し、コピー・デザイン・配置の改善提案を出してください。',
  cost: 'light',
  query: `
    SELECT element_selector, element_text,
      avg(visible_duration_ms) as avg_visible_ms,
      avg(max_visible_ratio) as avg_visible_ratio,
      countIf(element_clicked = 1) as clicked,
      count() as total,
      countIf(element_clicked = 1) / greatest(count(), 1) * 100 as click_rate
    FROM clickinsight.element_visibility
    WHERE site_id = {site_id:String}
    GROUP BY element_selector, element_text
    HAVING total >= 10
    ORDER BY avg_visible_ms DESC LIMIT 30
  `,
})

analysisAxes.set('atf_vs_btf', {
  id: 'atf_vs_btf',
  name: 'ファーストビュー vs ビロウザフォールド',
  description: 'ページ上部と下部の滞在時間比率',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: 'ATF滞在率が高すぎるページは重要コンテンツが埋もれている。低すぎるページはファーストビューが弱い。改善提案を出してください。',
  cost: 'medium',
  query: `
    SELECT url,
      sumIf(read_duration, read_y <= viewport_height) as atf_ms,
      sumIf(read_duration, read_y > viewport_height) as btf_ms,
      sumIf(read_duration, read_y <= viewport_height) / greatest(sumIf(read_duration, read_y <= viewport_height) + sumIf(read_duration, read_y > viewport_height), 1) * 100 as atf_pct
    FROM clickinsight.events
    WHERE site_id = {site_id:String} AND event_type = 'read_area' AND read_y > 0
    GROUP BY url
    HAVING atf_ms + btf_ms > 5000
    ORDER BY atf_pct DESC LIMIT 30
  `,
})

// --- Friction ---

analysisAxes.set('form_friction', {
  id: 'form_friction',
  name: 'フォーム離脱摩擦ポイント',
  description: 'どのフォームフィールドで離脱しているか',
  category: 'friction',
  requiredParams: ['site_id'],
  aiPromptHint: '離脱率が高いフィールドを特定し、削除・任意化・自動入力の提案を出してください。',
  cost: 'light',
  query: `
    SELECT form_id, field_name, field_type,
      avg(field_duration_ms) as avg_duration_ms,
      countIf(event_type = 'form_abandon') as abandon_count,
      countIf(event_type = 'form_submit') as submit_count,
      countIf(event_type = 'form_abandon') / greatest(countIf(event_type = 'form_abandon') + countIf(event_type = 'form_submit'), 1) * 100 as abandon_rate
    FROM clickinsight.form_interactions
    WHERE site_id = {site_id:String}
    GROUP BY form_id, field_name, field_type
    HAVING abandon_count + submit_count >= 5
    ORDER BY abandon_rate DESC LIMIT 30
  `,
})

analysisAxes.set('rage_dead_clicks', {
  id: 'rage_dead_clicks',
  name: 'rage/dead clickマップ',
  description: 'UI摩擦が集中している箇所',
  category: 'friction',
  requiredParams: ['site_id'],
  aiPromptHint: 'rage clickはUI不満の指標、dead clickはクリッカブルに見える非インタラクティブ要素の指標。具体的なUI修正提案を出してください。',
  cost: 'light',
  query: `
    SELECT url, element_text, element_tag_name,
      intDiv(click_y, 100) * 100 as y_zone,
      countIf(event_type = 'rage_click') as rage_count,
      countIf(event_type = 'dead_click') as dead_count
    FROM clickinsight.events
    WHERE site_id = {site_id:String} AND event_type IN ('rage_click', 'dead_click')
    GROUP BY url, element_text, element_tag_name, y_zone
    HAVING rage_count >= 2 OR dead_count >= 3
    ORDER BY rage_count + dead_count DESC LIMIT 30
  `,
})

analysisAxes.set('confusion_scrolling', {
  id: 'confusion_scrolling',
  name: '迷い行動検出',
  description: '上下スクロールの往復が多いページ（情報設計の問題）',
  category: 'friction',
  requiredParams: ['site_id'],
  aiPromptHint: '上下往復が多い箇所は情報の配置順序やナビゲーションに問題がある。具体的なレイアウト改善提案を出してください。',
  cost: 'heavy',
  query: `
    SELECT url, count() as sessions_with_confusion,
      avg(confusion_rate) as avg_confusion_rate
    FROM (
      SELECT url, session_id,
        count() as scroll_events,
        countIf(scroll_y < neighbor_y) as up_count,
        countIf(scroll_y < neighbor_y) / greatest(count(), 1) * 100 as confusion_rate
      FROM (
        SELECT url, session_id, scroll_y,
          leadInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp) as neighbor_y
        FROM clickinsight.events
        WHERE site_id = {site_id:String} AND event_type = 'scroll'
      )
      WHERE neighbor_y > 0
      GROUP BY url, session_id
      HAVING scroll_events >= 5 AND confusion_rate > 30
    )
    GROUP BY url
    ORDER BY sessions_with_confusion DESC LIMIT 20
  `,
})

analysisAxes.set('cta_hesitation', {
  id: 'cta_hesitation',
  name: 'CTAクリック迷い時間',
  description: 'ページ到着からCTAクリックまでの平均時間',
  category: 'friction',
  requiredParams: ['site_id'],
  aiPromptHint: '迷い時間が長いCTAは、直前のコンテンツが不安を解消できていない。CTA直前に安心材料（保証・実績・FAQ）を配置する提案を出してください。',
  cost: 'heavy',
  query: `
    SELECT url, element_text,
      avg(time_to_click) as avg_hesitation_sec,
      count() as click_count
    FROM (
      SELECT e.url, e.element_text, e.session_id,
        dateDiff('second', pv.first_view, e.timestamp) as time_to_click
      FROM clickinsight.events e
      JOIN (
        SELECT session_id, url, min(timestamp) as first_view
        FROM clickinsight.events WHERE event_type IN ('pageview','page_view') AND site_id = {site_id:String}
        GROUP BY session_id, url
      ) pv ON e.session_id = pv.session_id AND e.url = pv.url
      WHERE e.site_id = {site_id:String}
        AND e.event_type = 'click' AND e.element_tag_name IN ('a', 'button')
    )
    WHERE time_to_click > 0 AND time_to_click < 600
    GROUP BY url, element_text
    HAVING click_count >= 5
    ORDER BY avg_hesitation_sec DESC LIMIT 30
  `,
})

// --- Persona / Segments ---

analysisAxes.set('new_vs_returning', {
  id: 'new_vs_returning',
  name: '新規 vs リピーター',
  description: '新規訪問とリピート訪問の行動差分',
  category: 'persona',
  requiredParams: ['site_id'],
  aiPromptHint: '新規とリピーターの行動差から、それぞれに最適化されたLPやコンテンツの提案を出してください。',
  cost: 'medium',
  query: `
    SELECT
      CASE WHEN visit_count = 1 THEN 'new' ELSE 'returning' END as user_type,
      count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr,
      avg(page_views) as avg_pages,
      avg(max_scroll) as avg_scroll,
      avg(session_sec) as avg_duration_sec
    FROM (
      SELECT session_id, user_id,
        max(conversion_type IS NOT NULL) as converted,
        count(CASE WHEN event_type IN ('pageview','page_view') THEN 1 END) as page_views,
        max(scroll_percentage) as max_scroll,
        dateDiff('second', min(timestamp), max(timestamp)) as session_sec,
        count() OVER (PARTITION BY user_id) as visit_count
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id, user_id
    )
    GROUP BY user_type
  `,
})

analysisAxes.set('scroll_speed_persona', {
  id: 'scroll_speed_persona',
  name: 'スクロール速度ペルソナ',
  description: '速読者/精読者/通常の3群に分類',
  category: 'persona',
  requiredParams: ['site_id'],
  aiPromptHint: 'skimmerはビジュアル重視のLP、careful_readerはテキスト詳細型のLPが適している。各群のCVRから最適なコンテンツ戦略を提案してください。',
  cost: 'heavy',
  query: `
    SELECT reader_type, count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr,
      avg(avg_speed) as avg_scroll_speed
    FROM (
      SELECT session_id,
        max(conversion_type IS NOT NULL) as converted,
        avg(abs(scroll_y - prev_y) / greatest(diff_ms, 1) * 1000) as avg_speed,
        CASE
          WHEN avg(abs(scroll_y - prev_y) / greatest(diff_ms, 1) * 1000) > 500 THEN 'skimmer'
          WHEN avg(abs(scroll_y - prev_y) / greatest(diff_ms, 1) * 1000) < 100 THEN 'careful_reader'
          ELSE 'normal'
        END as reader_type
      FROM (
        SELECT session_id, scroll_y, conversion_type,
          lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp) as prev_y,
          dateDiff('millisecond', lagInFrame(timestamp, 1) OVER (PARTITION BY session_id ORDER BY timestamp), timestamp) as diff_ms
        FROM clickinsight.events
        WHERE site_id = {site_id:String} AND event_type = 'scroll'
      )
      WHERE prev_y > 0 AND diff_ms > 0
      GROUP BY session_id
    )
    GROUP BY reader_type
  `,
})

// --- Traffic ---

analysisAxes.set('source_behavior_cv', {
  id: 'source_behavior_cv',
  name: '流入元×行動×CV',
  description: '広告/オーガニック/SNS別の行動パターンとCVR',
  category: 'traffic',
  requiredParams: ['site_id'],
  aiPromptHint: '流入元ごとの行動差から、各チャネルに最適化されたLPバリアントの提案を出してください。',
  cost: 'light',
  query: `
    SELECT utm_source, utm_medium,
      count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr,
      avg(max_scroll) as avg_scroll, avg(session_sec) as avg_duration_sec,
      avg(total_clicks) as avg_clicks
    FROM (
      SELECT session_id, any(utm_source) as utm_source, any(utm_medium) as utm_medium,
        max(conversion_type IS NOT NULL) as converted,
        max(scroll_percentage) as max_scroll,
        dateDiff('second', min(timestamp), max(timestamp)) as session_sec,
        count(CASE WHEN event_type = 'click' THEN 1 END) as total_clicks
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    )
    GROUP BY utm_source, utm_medium
    HAVING sessions >= 5
    ORDER BY cvr DESC LIMIT 30
  `,
})

analysisAxes.set('hourly_pattern', {
  id: 'hourly_pattern',
  name: '時間帯パターン',
  description: '時間帯別のCVRと行動パターン',
  category: 'traffic',
  requiredParams: ['site_id'],
  aiPromptHint: '時間帯別CVRから最適な広告配信時間、コンテンツ更新タイミングの提案を出してください。',
  cost: 'light',
  query: `
    SELECT toHour(min_ts) as hour_of_day,
      count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr,
      avg(max_scroll) as avg_scroll,
      avg(session_sec) as avg_duration_sec
    FROM (
      SELECT session_id, min(timestamp) as min_ts,
        max(conversion_type IS NOT NULL) as converted,
        max(scroll_percentage) as max_scroll,
        dateDiff('second', min(timestamp), max(timestamp)) as session_sec
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    )
    GROUP BY hour_of_day ORDER BY hour_of_day
  `,
})

analysisAxes.set('weekday_device_cv', {
  id: 'weekday_device_cv',
  name: '曜日×デバイス×CV',
  description: '曜日とデバイスの組み合わせ別CVR',
  category: 'traffic',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVRが高い/低い曜日×デバイスの組み合わせから、デバイス別LP最適化と広告配信スケジュールの提案を出してください。',
  cost: 'light',
  query: `
    SELECT toDayOfWeek(min_ts) as day_of_week, device_type,
      count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr
    FROM (
      SELECT session_id, multiIf(any(viewport_width) >= 1024, 'desktop', any(viewport_width) >= 768, 'tablet', 'mobile') as device_type,
        min(timestamp) as min_ts, max(conversion_type IS NOT NULL) as converted
      FROM clickinsight.events WHERE site_id = {site_id:String}
      GROUP BY session_id
    )
    GROUP BY day_of_week, device_type
    ORDER BY day_of_week, device_type
  `,
})

// --- Journey ---

analysisAxes.set('page_journey', {
  id: 'page_journey',
  name: 'ページ遷移ジャーニー',
  description: 'CVした人の典型的なページ遷移パターン',
  category: 'persona',
  requiredParams: ['site_id'],
  aiPromptHint: 'CVした人の遷移パターンから典型的なカスタマージャーニーを3-5パターン抽出し、各ジャーニーの特徴と離脱ポイント、改善提案を出してください。',
  cost: 'heavy',
  query: `
    SELECT page_sequence, count() as session_count, avg(session_sec) as avg_duration_sec
    FROM (
      SELECT session_id,
        groupArray(url) as page_sequence,
        dateDiff('second', min(timestamp), max(timestamp)) as session_sec
      FROM (
        SELECT session_id, url, timestamp,
          row_number() OVER (PARTITION BY session_id ORDER BY timestamp) as step
        FROM clickinsight.events
        WHERE site_id = {site_id:String} AND event_type IN ('pageview','page_view')
          AND session_id IN (
            SELECT DISTINCT session_id FROM clickinsight.events
            WHERE conversion_type IS NOT NULL AND site_id = {site_id:String}
          )
      )
      GROUP BY session_id
    )
    GROUP BY page_sequence
    ORDER BY session_count DESC LIMIT 30
  `,
})

// =============================================================================
// TOP 10 新規分析軸（Phase 2）
// =============================================================================

// --- #1: カニバリゼーション行動検出 (GSC Level 1) ---

analysisAxes.set('cannibalization_behavior', {
  id: 'cannibalization_behavior',
  name: 'カニバリゼーション行動検出',
  description: 'GSCで同一クエリに複数ページがランクインし、ユーザーがそれらのページ間を往復している行動を検出',
  category: 'seo',
  requiredParams: ['site_id'],
  aiPromptHint: '同一クエリで複数ページがランクインしているケースを特定し、ページ統合すべきか・差別化すべきかを判断してください。往復行動が多いページペアはユーザーが混乱しています。統合/リダイレクト/コンテンツ差別化の具体的提案を出してください。',
  cost: 'heavy',
  query: `
    WITH cannibal_pages AS (
      SELECT query, groupArray(page) as pages, count() as page_count,
        sum(clicks) as total_clicks, avg(position) as avg_position
      FROM clickinsight.gsc_data
      WHERE site_id = {site_id:String}
      GROUP BY query
      HAVING page_count >= 2
      ORDER BY total_clicks DESC
      LIMIT 50
    ),
    page_pairs AS (
      SELECT
        cp.query,
        cp.pages[1] as page_a,
        cp.pages[2] as page_b,
        cp.total_clicks,
        cp.avg_position
      FROM cannibal_pages cp
    ),
    user_bouncing AS (
      SELECT
        pp.query, pp.page_a, pp.page_b, pp.total_clicks, pp.avg_position,
        count(DISTINCT e.session_id) as sessions_visiting_both
      FROM page_pairs pp
      JOIN clickinsight.events e ON e.site_id = {site_id:String}
        AND (e.url = pp.page_a OR e.url = pp.page_b)
        AND e.event_type IN ('pageview', 'page_view')
      GROUP BY pp.query, pp.page_a, pp.page_b, pp.total_clicks, pp.avg_position
      HAVING sessions_visiting_both >= 2
    )
    SELECT query, page_a, page_b, total_clicks, avg_position,
      sessions_visiting_both,
      sessions_visiting_both / greatest(total_clicks, 1) * 100 as bounce_between_rate
    FROM user_bouncing
    ORDER BY sessions_visiting_both DESC
    LIMIT 30
  `,
})

// --- #2: 認知負荷スコア (純ClickHouse) ---

analysisAxes.set('cognitive_load_score', {
  id: 'cognitive_load_score',
  name: '認知負荷スコア',
  description: 'スクロール速度の不安定さ、rage/dead click密度、上下往復頻度から、ページごとの認知負荷を0-100でスコア化',
  category: 'cognitive',
  requiredParams: ['site_id'],
  aiPromptHint: 'cognitive_load_scoreが高いページはユーザーが混乱しています。スコアの内訳（scroll_instability, friction_density, confusion_rate）を見て、最も寄与している要因ごとに改善提案を出してください。scroll_instability高→情報の密度が高すぎるか視覚的ノイズが多い。friction_density高→クリッカブルに見える非インタラクティブ要素がある。confusion_rate高→情報の順序が直感に反している。',
  cost: 'heavy',
  query: `
    SELECT url,
      uniq(session_id) as sessions,

      -- 要素1: スクロール速度の不安定度（標準偏差 / 平均）
      avg(scroll_speed_cv) as avg_scroll_instability,

      -- 要素2: rage + dead click 密度（1セッションあたり）
      sum(friction_clicks) / greatest(uniq(session_id), 1) as friction_density,

      -- 要素3: 上下往復率
      avg(confusion_rate) as avg_confusion_rate,

      -- 総合スコア（0-100、各要素を正規化して合算）
      least(100, greatest(0,
        least(50, avg(scroll_speed_cv) * 10) +
        least(30, sum(friction_clicks) / greatest(uniq(session_id), 1) * 15) +
        least(20, avg(confusion_rate) * 0.4)
      )) as cognitive_load_score

    FROM (
      SELECT
        session_id, url,
        -- スクロール速度のCV（変動係数）
        stddevPop(abs(scroll_y - prev_scroll_y) / greatest(time_diff_ms, 1) * 1000)
          / greatest(avg(abs(scroll_y - prev_scroll_y) / greatest(time_diff_ms, 1) * 1000), 0.01)
          as scroll_speed_cv,
        -- 摩擦クリック数
        countIf(event_type IN ('rage_click', 'dead_click')) as friction_clicks,
        -- 上方向スクロール率
        countIf(scroll_y < prev_scroll_y AND prev_scroll_y > 0)
          / greatest(countIf(event_type = 'scroll'), 1) * 100 as confusion_rate
      FROM (
        SELECT session_id, url, event_type, scroll_y,
          lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp) as prev_scroll_y,
          dateDiff('millisecond',
            lagInFrame(timestamp, 1) OVER (PARTITION BY session_id ORDER BY timestamp),
            timestamp
          ) as time_diff_ms
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
          AND event_type IN ('scroll', 'click', 'rage_click', 'dead_click')
      )
      WHERE time_diff_ms > 0
      GROUP BY session_id, url
      HAVING countIf(event_type = 'scroll') >= 3
    )
    GROUP BY url
    HAVING sessions >= 5
    ORDER BY cognitive_load_score DESC
    LIMIT 30
  `,
})

// --- #3: 注目の競合 (純ClickHouse) ---

analysisAxes.set('attention_competition', {
  id: 'attention_competition',
  name: '注目の競合（同一画面CTA競合）',
  description: '同一セッションで同時に可視だった複数の要素のうち、どちらがクリックされたかを分析。要素間の勝敗マトリクスを生成',
  category: 'engagement',
  requiredParams: ['site_id'],
  aiPromptHint: '同一画面内で可視性が高いのにクリックされない要素は、隣接する要素に注目を奪われています。勝っている要素と負けている要素の対比から、CTAの配置・サイズ・色・コピーの改善提案を出してください。特にwin_rateが低い要素は「見えているのに無視されている」ため、視覚的な差別化が必要です。',
  cost: 'medium',
  query: `
    SELECT
      winner.element_selector as winner_selector,
      winner.element_text as winner_text,
      loser.element_selector as loser_selector,
      loser.element_text as loser_text,
      count() as matchups,
      countIf(winner.element_clicked = 1 AND loser.element_clicked = 0) as winner_wins,
      countIf(winner.element_clicked = 0 AND loser.element_clicked = 1) as loser_wins,
      countIf(winner.element_clicked = 1 AND loser.element_clicked = 0)
        / greatest(count(), 1) * 100 as win_rate
    FROM clickinsight.element_visibility winner
    JOIN clickinsight.element_visibility loser
      ON winner.session_id = loser.session_id
      AND winner.page_url = loser.page_url
      AND winner.site_id = loser.site_id
      AND winner.element_selector < loser.element_selector
      AND abs(toInt32(winner.element_y) - toInt32(loser.element_y)) < 800
    WHERE winner.site_id = {site_id:String}
      AND winner.max_visible_ratio > 0.5
      AND loser.max_visible_ratio > 0.5
    GROUP BY winner_selector, winner_text, loser_selector, loser_text
    HAVING matchups >= 10
    ORDER BY matchups DESC
    LIMIT 30
  `,
})

// --- #4: 検索意図×ページ行動一致度 (GSC Level 1) ---

analysisAxes.set('query_intent_page_match', {
  id: 'query_intent_page_match',
  name: '検索意図×ページ行動一致度',
  description: 'GSCクエリを意図分類（情報型/比較型/購入型/ナビ型）し、ランディングページ上の行動が意図に適合しているかを判定',
  category: 'seo',
  requiredParams: ['site_id'],
  aiPromptHint: '各ページの主要クエリ意図と実際の行動を比較してください。intent_typeが「transactional」なのにCVRが低い場合、CTAが弱いか到達コストが高い。「informational」なのにスクロール深度が浅い場合、コンテンツが期待に応えていない。意図と行動のミスマッチが大きいページから優先的に改善提案を出してください。query_samplesを参考に具体的なクエリを引用してください。',
  cost: 'heavy',
  query: `
    WITH page_queries AS (
      SELECT page, query, sum(clicks) as clicks, avg(position) as avg_pos,
        -- クエリ意図の推定（キーワードパターン）
        multiIf(
          query LIKE '%料金%' OR query LIKE '%価格%' OR query LIKE '%購入%'
            OR query LIKE '%申込%' OR query LIKE '%契約%' OR query LIKE '%買%',
          'transactional',
          query LIKE '%比較%' OR query LIKE '%おすすめ%' OR query LIKE '%ランキング%'
            OR query LIKE '%vs%' OR query LIKE '%違い%',
          'comparison',
          query LIKE '%とは%' OR query LIKE '%方法%' OR query LIKE '%やり方%'
            OR query LIKE '%使い方%' OR query LIKE '%意味%' OR query LIKE '%解説%',
          'informational',
          query LIKE '%ログイン%' OR query LIKE '%公式%' OR query LIKE '%サイト%',
          'navigational',
          'informational'
        ) as intent_type
      FROM clickinsight.gsc_data
      WHERE site_id = {site_id:String}
      GROUP BY page, query
    ),
    page_intent AS (
      SELECT page,
        argMax(intent_type, clicks) as primary_intent,
        sum(clicks) as total_gsc_clicks,
        groupArray(query) as query_samples,
        avg(avg_pos) as avg_position
      FROM page_queries
      GROUP BY page
    ),
    page_behavior AS (
      SELECT url,
        uniq(session_id) as sessions,
        countIf(conversion_type IS NOT NULL) / greatest(uniq(session_id), 1) * 100 as cvr,
        avg(scroll_percentage) as avg_scroll,
        avgIf(read_duration, event_type = 'read_area') as avg_read_ms,
        countIf(event_type = 'click') / greatest(uniq(session_id), 1) as clicks_per_session,
        countIf(event_type IN ('rage_click', 'dead_click')) / greatest(uniq(session_id), 1) as friction_per_session
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
      GROUP BY url
      HAVING sessions >= 5
    )
    SELECT
      pi.page, pi.primary_intent, pi.total_gsc_clicks, pi.avg_position,
      arraySlice(pi.query_samples, 1, 5) as top_queries,
      pb.sessions, pb.cvr, pb.avg_scroll, pb.avg_read_ms,
      pb.clicks_per_session, pb.friction_per_session,
      -- 意図適合度スコア（0-100）
      multiIf(
        pi.primary_intent = 'transactional',
          least(100, pb.cvr * 10 + least(30, pb.clicks_per_session * 10)),
        pi.primary_intent = 'comparison',
          least(100, pb.avg_scroll * 0.8 + pb.avg_read_ms / 100),
        pi.primary_intent = 'informational',
          least(100, pb.avg_scroll * 0.6 + pb.avg_read_ms / 50),
        pi.primary_intent = 'navigational',
          least(100, pb.clicks_per_session * 30 + (100 - pb.friction_per_session * 50)),
        50
      ) as intent_match_score
    FROM page_intent pi
    JOIN page_behavior pb ON pi.page = pb.url
    ORDER BY pi.total_gsc_clicks DESC
    LIMIT 50
  `,
})

// --- #5: セッション録画優先スコア (純ClickHouse) ---

analysisAxes.set('session_replay_priority', {
  id: 'session_replay_priority',
  name: 'セッション録画優先スコア',
  description: 'rage click・confusion scrolling・CV直前離脱・フォーム放棄の有無でセッションをスコアリングし、分析者が見るべき録画を優先順位付け',
  category: 'meta',
  requiredParams: ['site_id'],
  aiPromptHint: 'priority_scoreが高いセッションは問題行動が集中しています。上位5セッションのスコア内訳を分析し、共通するUX問題のパターンを抽出してください。rage_clickが多いセッションはUI問題、high_scroll_confusion_rateは情報設計問題、near_miss_cvは最もCVに近かったのに逃したユーザーです。各パターンに対する改善提案を出してください。',
  cost: 'medium',
  query: `
    SELECT
      e.session_id,
      min(e.timestamp) as session_start,
      max(e.timestamp) as session_end,
      dateDiff('second', min(e.timestamp), max(e.timestamp)) as duration_sec,
      count() as total_events,
      any(e.url) as landing_page,

      -- スコア要素
      countIf(e.event_type = 'rage_click') as rage_clicks,
      countIf(e.event_type = 'dead_click') as dead_clicks,
      max(e.scroll_percentage) as max_scroll,

      -- 上下往復スクロール率
      countIf(e.scroll_y < prev_y AND prev_y > 0)
        / greatest(countIf(e.event_type = 'scroll'), 1) * 100 as scroll_confusion_rate,

      -- フォーム放棄
      countIf(e.event_type = 'form_abandon') > 0 as has_form_abandon,

      -- CV直前離脱（スクロール80%以上到達 + クリック5回以上 + CV無し）
      (max(e.scroll_percentage) >= 80
        AND countIf(e.event_type = 'click') >= 5
        AND max(e.conversion_type IS NOT NULL) = 0) as near_miss_cv,

      -- 総合優先スコア（0-100）
      least(100, greatest(0,
        countIf(e.event_type = 'rage_click') * 15
        + countIf(e.event_type = 'dead_click') * 5
        + (countIf(e.scroll_y < prev_y AND prev_y > 0)
           / greatest(countIf(e.event_type = 'scroll'), 1) * 30)
        + (countIf(e.event_type = 'form_abandon') > 0) * 20
        + ((max(e.scroll_percentage) >= 80
            AND countIf(e.event_type = 'click') >= 5
            AND max(e.conversion_type IS NOT NULL) = 0)) * 25
      )) as priority_score

    FROM (
      SELECT *, lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp) as prev_y
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
    ) e
    GROUP BY e.session_id
    HAVING total_events >= 5 AND duration_sec >= 3
    ORDER BY priority_score DESC
    LIMIT 20
  `,
})

// --- #6: エンゲージメント減衰曲線 (純ClickHouse) ---

analysisAxes.set('engagement_decay_curve', {
  id: 'engagement_decay_curve',
  name: 'エンゲージメント減衰曲線',
  description: 'ページの上部から下部へ100px区切りでエンゲージメント強度（滞在時間×クリック密度）をプロットし、急落するポイント（コンテンツの壁）を検出',
  category: 'content',
  requiredParams: ['site_id'],
  aiPromptHint: 'engagement_intensityが急落するy_zone（drop_rate > 40%）はコンテンツの壁です。その位置のコンテンツを確認し、壁の原因（退屈なテキストブロック、無関係な画像、CTAの欠如）と改善案を出してください。逆にintensityが急上昇するゾーンは「注目コンテンツ」です。それをページ上部に移動する提案も検討してください。',
  cost: 'medium',
  query: `
    SELECT url,
      intDiv(y_position, 100) * 100 as y_zone,
      sum(engagement_ms) as total_engagement_ms,
      sum(click_count) as total_clicks,
      uniq(session_id) as sessions,
      -- エンゲージメント強度（時間+クリックの正規化複合スコア）
      sum(engagement_ms) / greatest(uniq(session_id), 1)
        + sum(click_count) * 500 / greatest(uniq(session_id), 1)
        as engagement_intensity,
      -- 前ゾーンからの減衰率
      engagement_intensity / greatest(
        lagInFrame(engagement_intensity, 1) OVER (PARTITION BY url ORDER BY y_zone),
        0.01
      ) * 100 - 100 as drop_rate
    FROM (
      -- 熟読データ
      SELECT session_id, url, read_y as y_position, read_duration as engagement_ms, 0 as click_count
      FROM clickinsight.events
      WHERE site_id = {site_id:String} AND event_type = 'read_area' AND read_y > 0
      UNION ALL
      -- クリックデータ
      SELECT session_id, url, click_y as y_position, 0 as engagement_ms, 1 as click_count
      FROM clickinsight.events
      WHERE site_id = {site_id:String} AND event_type IN ('click', 'rage_click', 'dead_click') AND click_y > 0
    )
    GROUP BY url, y_zone
    HAVING sessions >= 3
    ORDER BY url, y_zone
  `,
})

// --- #7: 内部リンク効果測定 (純ClickHouse) ---

analysisAxes.set('internal_link_effectiveness', {
  id: 'internal_link_effectiveness',
  name: '内部リンク効果測定',
  description: 'クリックされた内部リンクごとに、遷移先でのCV率・滞在時間・スクロール深度を算出し、内部リンクのROIを可視化',
  category: 'seo',
  requiredParams: ['site_id'],
  aiPromptHint: 'cv_rateが高い内部リンクは「ゴールデンリンク」です。これらのリンクの視認性・配置をさらに強化してください。逆にclick_countが多いのにcv_rateが0のリンクは、遷移先ページに問題があります。遷移先のコンテンツ改善 or リンク先の変更を提案してください。click_rateが低い内部リンクはアンカーテキストやデザインの見直しが必要です。',
  cost: 'medium',
  query: `
    WITH link_clicks AS (
      SELECT
        session_id, url as source_page, element_href as target_page,
        element_text as link_text, timestamp as click_time
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND event_type = 'click'
        AND element_tag_name = 'a'
        AND element_href != ''
        AND element_href NOT LIKE 'http%'
        AND element_href NOT LIKE 'mailto%'
        AND element_href NOT LIKE 'tel%'
        AND element_href NOT LIKE '#%'
    ),
    post_click_behavior AS (
      SELECT
        lc.source_page, lc.target_page, lc.link_text, lc.session_id,
        max(e.conversion_type IS NOT NULL) as converted,
        max(e.scroll_percentage) as max_scroll_after,
        dateDiff('second', lc.click_time, max(e.timestamp)) as time_on_target_sec
      FROM link_clicks lc
      JOIN clickinsight.events e
        ON e.session_id = lc.session_id
        AND e.site_id = {site_id:String}
        AND e.timestamp > lc.click_time
      GROUP BY lc.source_page, lc.target_page, lc.link_text, lc.session_id
    )
    SELECT
      source_page, target_page, link_text,
      count() as click_count,
      countIf(converted = 1) as cv_count,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cv_rate,
      avg(max_scroll_after) as avg_scroll_on_target,
      avg(time_on_target_sec) as avg_time_on_target_sec
    FROM post_click_behavior
    GROUP BY source_page, target_page, link_text
    HAVING click_count >= 3
    ORDER BY click_count DESC
    LIMIT 50
  `,
})

// --- #8: ゼロクリックコンテンツ判定 (GSC Level 1) ---

analysisAxes.set('zero_click_content_audit', {
  id: 'zero_click_content_audit',
  name: 'ゼロクリックコンテンツ判定',
  description: 'クリックが発生せず熟読のみで離脱するページを検出し、GSCクエリの意図と照合して「情報提供の成功」か「CV導線の失敗」かを判定',
  category: 'seo',
  requiredParams: ['site_id'],
  aiPromptHint: 'primary_intentが「informational」でzero_click_rateが高いページは情報提供に成功している可能性があります（ただしCVにつなげる余地はある）。primary_intentが「transactional」「comparison」なのにzero_click_rateが高いページはCTA不足・CTA位置の問題です。後者を優先的に改善してください。avg_read_msが高いのにクリックゼロのページは「読ませているのに逃がしている」最ももったいないケースです。',
  cost: 'heavy',
  query: `
    WITH page_click_stats AS (
      SELECT url,
        uniq(session_id) as total_sessions,
        uniqIf(session_id, has_click = 0 AND has_read = 1) as zero_click_read_sessions,
        uniqIf(session_id, has_click = 0 AND has_read = 1)
          / greatest(uniq(session_id), 1) * 100 as zero_click_rate,
        avgIf(total_read_ms, has_click = 0 AND has_read = 1) as avg_read_ms_zero_click,
        avgIf(max_scroll, has_click = 0 AND has_read = 1) as avg_scroll_zero_click
      FROM (
        SELECT session_id, url,
          countIf(event_type IN ('click', 'rage_click', 'dead_click')) > 0 as has_click,
          countIf(event_type = 'read_area') > 0 as has_read,
          sumIf(read_duration, event_type = 'read_area') as total_read_ms,
          max(scroll_percentage) as max_scroll
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
        GROUP BY session_id, url
      )
      GROUP BY url
      HAVING total_sessions >= 5
    ),
    page_gsc AS (
      SELECT page,
        sum(clicks) as gsc_clicks,
        avg(position) as avg_position,
        argMax(query, clicks) as top_query,
        multiIf(
          argMax(query, clicks) LIKE '%料金%' OR argMax(query, clicks) LIKE '%価格%'
            OR argMax(query, clicks) LIKE '%購入%' OR argMax(query, clicks) LIKE '%申込%',
          'transactional',
          argMax(query, clicks) LIKE '%比較%' OR argMax(query, clicks) LIKE '%おすすめ%'
            OR argMax(query, clicks) LIKE '%ランキング%',
          'comparison',
          'informational'
        ) as primary_intent
      FROM clickinsight.gsc_data
      WHERE site_id = {site_id:String}
      GROUP BY page
    )
    SELECT
      pcs.url, pcs.total_sessions, pcs.zero_click_read_sessions,
      pcs.zero_click_rate, pcs.avg_read_ms_zero_click, pcs.avg_scroll_zero_click,
      pg.gsc_clicks, pg.avg_position, pg.top_query, pg.primary_intent,
      -- 問題度スコア: transactional/comparisonでゼロクリック率が高いほど深刻
      multiIf(
        pg.primary_intent = 'transactional', pcs.zero_click_rate * 1.5,
        pg.primary_intent = 'comparison', pcs.zero_click_rate * 1.2,
        pcs.zero_click_rate * 0.5
      ) as severity_score
    FROM page_click_stats pcs
    LEFT JOIN page_gsc pg ON pcs.url = pg.page
    WHERE pcs.zero_click_rate > 20
    ORDER BY severity_score DESC
    LIMIT 30
  `,
})

// --- #9: 離脱予兆パターン (純ClickHouse) ---

analysisAxes.set('exit_intent_pattern', {
  id: 'exit_intent_pattern',
  name: '離脱予兆パターン',
  description: '離脱したセッションの最後の3アクションのパターンを分類し、離脱防止施策の最適タイミングを算出',
  category: 'friction',
  requiredParams: ['site_id'],
  aiPromptHint: '離脱パターンを分類し、各パターンに対する介入施策を提案してください。rapid_scroll_up（ページ上部に高速リターン）はブラウザバック直前で、ポップアップの最適タイミング。slow_fade（クリック・スクロール頻度の急減少）はコンテンツへの興味喪失で、関連コンテンツの表示が有効。friction_exit（rage/dead click後の即離脱）はUI修正が必要。各パターンの発生ページと頻度を考慮して優先順位をつけてください。',
  cost: 'heavy',
  query: `
    WITH session_last_events AS (
      SELECT session_id, url,
        groupArray(event_type) as last_events,
        groupArray(scroll_y) as last_scroll_positions,
        groupArray(timestamp) as last_timestamps
      FROM (
        SELECT session_id, url, event_type, scroll_y, timestamp,
          row_number() OVER (PARTITION BY session_id ORDER BY timestamp DESC) as rn
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
      )
      WHERE rn <= 5
      GROUP BY session_id, url
    ),
    exit_sessions AS (
      SELECT session_id, url, last_events,
        -- パターン分類
        multiIf(
          -- ページ上部への急速リターン
          length(last_scroll_positions) >= 2
            AND last_scroll_positions[1] < last_scroll_positions[length(last_scroll_positions)] * 0.3,
          'rapid_scroll_up',
          -- 摩擦後の即離脱
          hasAny(last_events, ['rage_click', 'dead_click']),
          'friction_exit',
          -- スクロール深度が浅い（ファーストビューで離脱）
          length(last_scroll_positions) >= 1
            AND arrayMax(last_scroll_positions) < 300,
          'shallow_bounce',
          -- デフォルト
          'slow_fade'
        ) as exit_pattern,
        -- CV未達
        NOT has(last_events, 'conversion') as no_conversion
      FROM session_last_events
    )
    SELECT
      url, exit_pattern,
      count() as session_count,
      count() / (SELECT greatest(count(), 1) FROM exit_sessions) * 100 as pattern_share
    FROM exit_sessions
    WHERE no_conversion = 1
    GROUP BY url, exit_pattern
    HAVING session_count >= 3
    ORDER BY session_count DESC
    LIMIT 40
  `,
})

// --- #10: 価格感度シグナル (純ClickHouse) ---

analysisAxes.set('price_sensitivity_signal', {
  id: 'price_sensitivity_signal',
  name: '価格感度シグナル',
  description: '料金・価格関連セクションでの行動パターンから、価格がCVブロッカーになっているかを定量判定',
  category: 'conversion',
  requiredParams: ['site_id'],
  aiPromptHint: 'price_hesitation_scoreが高いページは価格がCVの障壁になっています。要素ごとの分析を確認してください。pricing_dwell_ratioが高い（料金セクション滞在比率が全体の30%超）は価格への過度な注目。revisit_countが2以上は料金の再確認行動。confusion_near_pricingが高いは料金体系の複雑さ。post_pricing_exit_rateが高いは価格を見てすぐ離脱。各パターンに対し、安心材料の追加・価格表のシンプル化・無料トライアル訴求強化などの施策を提案してください。',
  cost: 'medium',
  query: `
    WITH pricing_elements AS (
      -- 料金関連の要素を検出（テキスト・URL・要素IDで判定）
      SELECT session_id, url, timestamp, event_type,
        scroll_y, click_y, read_y, read_duration,
        element_text, element_id, element_class_name
      FROM clickinsight.events
      WHERE site_id = {site_id:String}
        AND (
          lower(element_text) LIKE '%料金%'
          OR lower(element_text) LIKE '%価格%'
          OR lower(element_text) LIKE '%プラン%'
          OR lower(element_text) LIKE '%月額%'
          OR lower(element_text) LIKE '%年額%'
          OR lower(element_text) LIKE '%price%'
          OR lower(element_text) LIKE '%pricing%'
          OR lower(element_text) LIKE '%¥%'
          OR lower(element_id) LIKE '%price%'
          OR lower(element_id) LIKE '%pricing%'
          OR lower(element_id) LIKE '%plan%'
          OR lower(element_class_name) LIKE '%price%'
          OR lower(element_class_name) LIKE '%pricing%'
          OR url LIKE '%pricing%'
          OR url LIKE '%price%'
          OR url LIKE '%plan%'
        )
    ),
    session_pricing_behavior AS (
      SELECT
        pe.url,
        pe.session_id,
        count() as pricing_interactions,
        sumIf(pe.read_duration, pe.event_type = 'read_area') as pricing_read_ms,
        countIf(pe.event_type IN ('rage_click', 'dead_click')) as pricing_friction,

        -- 全体セッション時間に対する料金セクション滞在比率
        sumIf(pe.read_duration, pe.event_type = 'read_area')
          / greatest(s.total_read_ms, 1) * 100 as pricing_dwell_ratio,

        -- 料金エリアへの再訪回数（上下往復）
        s.total_events,
        s.total_read_ms,
        max(s.converted) as converted
      FROM pricing_elements pe
      JOIN (
        SELECT session_id, url,
          count() as total_events,
          sumIf(read_duration, event_type = 'read_area') as total_read_ms,
          max(conversion_type IS NOT NULL) as converted
        FROM clickinsight.events
        WHERE site_id = {site_id:String}
        GROUP BY session_id, url
      ) s ON pe.session_id = s.session_id AND pe.url = s.url
      GROUP BY pe.url, pe.session_id, s.total_events, s.total_read_ms
    )
    SELECT
      url,
      uniq(session_id) as sessions,
      avg(pricing_interactions) as avg_pricing_interactions,
      avg(pricing_read_ms) as avg_pricing_read_ms,
      avg(pricing_dwell_ratio) as avg_pricing_dwell_ratio,
      sum(pricing_friction) as total_pricing_friction,
      countIf(converted = 1) / greatest(uniq(session_id), 1) * 100 as cvr,
      countIf(converted = 0 AND pricing_dwell_ratio > 30) as high_dwell_no_cv,
      -- 価格感度スコア（0-100）
      least(100, greatest(0,
        avg(pricing_dwell_ratio) * 0.8
        + avg(pricing_interactions) * 5
        + sum(pricing_friction) / greatest(uniq(session_id), 1) * 20
        + countIf(converted = 0 AND pricing_dwell_ratio > 30) / greatest(uniq(session_id), 1) * 30
      )) as price_hesitation_score
    FROM session_pricing_behavior
    GROUP BY url
    HAVING sessions >= 5
    ORDER BY price_hesitation_score DESC
    LIMIT 20
  `,
})

// =============================================================================
// 行動ベースペルソナ自動生成
// =============================================================================

// セッション単位の行動プロファイル（ペルソナクラスタリングの素材）
analysisAxes.set('persona_behavior_profile', {
  id: 'persona_behavior_profile',
  name: '行動ベースペルソナプロファイル',
  description: 'セッション単位で行動特徴量を抽出。スクロール速度・熟読傾向・クリックパターン・摩擦度・CV有無・流入元・検索意図を統合したプロファイルを生成',
  category: 'persona',
  requiredParams: ['site_id'],
  aiPromptHint: `以下のセッション行動プロファイルデータから、3-5個の行動ベースペルソナを自動生成してください。

【ペルソナ生成ルール】
1. 行動パターンの類似性でグルーピングし、各グループに象徴的な名前をつけてください（例: 「即決スプリンター」「慎重リサーチャー」「価格ハンター」）
2. 各ペルソナに以下を記述:
   - 行動特徴（スクロール速度・熟読セクション・クリック傾向・CV率）
   - 推定デモグラフィック（デバイス比率・流入元・検索クエリ傾向から推定）
   - 検索意図タイプ（情報収集/比較検討/購入意図）
   - CVまでの典型導線
   - このペルソナに最適化されたLP/コンテンツの提案
   - 広告クリエイティブの方向性
3. ペルソナ間の行動差を明確に対比してください
4. 各ペルソナのセッション数割合を示し、ビジネスインパクトの大きいペルソナを特定してください`,
  cost: 'heavy',
  query: `
    WITH session_profile AS (
      SELECT
        session_id,
        any(user_id) as user_id,
        multiIf(any(viewport_width) >= 1024, 'desktop', any(viewport_width) >= 768, 'tablet', 'mobile') as device_type,
        any(utm_source) as utm_source,
        any(utm_medium) as utm_medium,
        argMin(url, timestamp) as landing_page,

        -- 時間特徴
        dateDiff('second', min(timestamp), max(timestamp)) as duration_sec,
        toHour(min(timestamp)) as visit_hour,
        toDayOfWeek(min(timestamp)) as visit_dow,

        -- スクロール行動
        max(scroll_percentage) as max_scroll_depth,
        countIf(event_type = 'scroll') as scroll_events,
        -- スクロール速度分類
        avgIf(
          abs(scroll_y - lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp))
            / greatest(dateDiff('millisecond',
                lagInFrame(timestamp, 1) OVER (PARTITION BY session_id ORDER BY timestamp),
                timestamp), 1) * 1000,
          event_type = 'scroll'
        ) as avg_scroll_speed,

        -- 熟読行動
        sumIf(read_duration, event_type = 'read_area') as total_read_ms,
        countIf(event_type = 'read_area') as read_events,
        avgIf(read_duration, event_type = 'read_area' AND read_duration > 0) as avg_read_duration_ms,

        -- クリック行動
        countIf(event_type = 'click') as total_clicks,
        countIf(event_type = 'rage_click') as rage_clicks,
        countIf(event_type = 'dead_click') as dead_clicks,

        -- ページ閲覧
        countIf(event_type IN ('pageview', 'page_view')) as page_views,

        -- CV
        max(conversion_type IS NOT NULL) as converted,
        max(conversion_value) as conversion_value,

        -- 画像接触
        countIf(event_type = 'image_visibility') as images_viewed,

        -- 上下往復率（迷い度）
        countIf(scroll_y < lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp)
                AND lagInFrame(scroll_y, 1) OVER (PARTITION BY session_id ORDER BY timestamp) > 0)
          / greatest(countIf(event_type = 'scroll'), 1) * 100 as confusion_rate

      FROM clickinsight.events
      WHERE site_id = {site_id:String}
      GROUP BY session_id
      HAVING duration_sec >= 3 AND (total_clicks + scroll_events + read_events) >= 2
    )
    SELECT
      -- 行動タイプ分類
      multiIf(
        converted = 1 AND duration_sec < 120 AND total_clicks <= 5,
        'quick_converter',
        converted = 1 AND total_read_ms > 30000,
        'deep_reader_converter',
        converted = 1,
        'standard_converter',
        max_scroll_depth > 80 AND total_read_ms > 20000 AND converted = 0,
        'engaged_non_converter',
        avg_scroll_speed > 500 AND max_scroll_depth > 60 AND total_read_ms < 5000,
        'skimmer',
        confusion_rate > 30,
        'confused_navigator',
        rage_clicks + dead_clicks >= 2,
        'frustrated_user',
        max_scroll_depth < 25 AND duration_sec < 15,
        'bouncer',
        total_read_ms > 30000 AND total_clicks < 3,
        'passive_reader',
        'standard_visitor'
      ) as behavior_type,

      count() as session_count,
      count() / (SELECT greatest(count(), 1) FROM session_profile) * 100 as share_pct,

      -- デモグラ集約
      topK(1)(device_type) as primary_device,
      topK(1)(utm_source) as primary_source,
      topK(1)(utm_medium) as primary_medium,

      -- 行動統計
      avg(duration_sec) as avg_duration_sec,
      avg(max_scroll_depth) as avg_scroll_depth,
      avg(total_read_ms) as avg_read_ms,
      avg(total_clicks) as avg_clicks,
      avg(page_views) as avg_page_views,
      avg(confusion_rate) as avg_confusion_rate,
      avg(rage_clicks + dead_clicks) as avg_friction_events,
      avg(images_viewed) as avg_images_viewed,

      -- CV率
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr,
      avg(conversion_value) as avg_cv_value,

      -- 時間帯傾向
      topK(3)(visit_hour) as typical_hours,
      topK(1)(visit_dow) as typical_dow,

      -- ランディングページ上位
      topK(3)(landing_page) as top_landing_pages

    FROM session_profile
    GROUP BY behavior_type
    ORDER BY session_count DESC
  `,
})

// GSC検索意図とペルソナの紐付け（ペルソナ生成の補助データ）
analysisAxes.set('persona_query_intent', {
  id: 'persona_query_intent',
  name: 'ペルソナ×検索意図マッピング',
  description: 'ランディングページの主要GSCクエリ意図を分類し、行動ペルソナの流入経路に検索意図を紐付ける',
  category: 'persona',
  requiredParams: ['site_id'],
  aiPromptHint: 'persona_behavior_profileの各behavior_typeのtop_landing_pagesと、このデータのpage別intent分布を突き合わせてください。各ペルソナがどの検索意図で流入しているかを特定し、ペルソナ像をより具体化してください。',
  cost: 'medium',
  query: `
    SELECT
      page as landing_page,
      count() as query_count,
      sum(clicks) as total_clicks,
      avg(position) as avg_position,

      -- 意図別クリック分布
      sumIf(clicks, query LIKE '%料金%' OR query LIKE '%価格%' OR query LIKE '%購入%'
        OR query LIKE '%申込%' OR query LIKE '%契約%') as transactional_clicks,
      sumIf(clicks, query LIKE '%比較%' OR query LIKE '%おすすめ%' OR query LIKE '%ランキング%'
        OR query LIKE '%vs%' OR query LIKE '%違い%' OR query LIKE '%口コミ%') as comparison_clicks,
      sumIf(clicks, query LIKE '%とは%' OR query LIKE '%方法%' OR query LIKE '%やり方%'
        OR query LIKE '%使い方%' OR query LIKE '%意味%' OR query LIKE '%解説%') as informational_clicks,
      sumIf(clicks, query LIKE '%ログイン%' OR query LIKE '%公式%') as navigational_clicks,

      -- 主要意図
      multiIf(
        transactional_clicks >= comparison_clicks
          AND transactional_clicks >= informational_clicks, 'transactional',
        comparison_clicks >= informational_clicks, 'comparison',
        informational_clicks > 0, 'informational',
        'other'
      ) as primary_intent,

      -- クエリサンプル
      topK(5)(query) as sample_queries

    FROM clickinsight.gsc_data
    WHERE site_id = {site_id:String}
    GROUP BY page
    HAVING total_clicks >= 3
    ORDER BY total_clicks DESC
    LIMIT 50
  `,
})

// --- 軸の実行ヘルパー ---

import type { ClickHouseClient } from '@clickhouse/client'

export async function executeAxis(
  clickhouse: ClickHouseClient,
  axisId: string,
  params: Record<string, string>
): Promise<{ axis: AnalysisAxis; data: Record<string, unknown>[] } | null> {
  const axis = analysisAxes.get(axisId)
  if (!axis) return null

  // 必須パラメータの検証
  for (const p of axis.requiredParams) {
    if (!params[p]) throw new Error(`Missing required parameter: ${p}`)
  }

  const result = await clickhouse.query({
    query: axis.query,
    query_params: params,
    format: 'JSONEachRow',
  })

  const data = await result.json() as Record<string, unknown>[]
  return { axis, data }
}

// 全軸を一括実行（コスト制御付き: heavyは直列、light/mediumは並列）
export async function executeAllAxes(
  clickhouse: ClickHouseClient,
  params: Record<string, string>
): Promise<Map<string, { axis: AnalysisAxis; data: Record<string, unknown>[] }>> {
  const results = new Map()
  const entries = Array.from(analysisAxes.entries())

  // light/medium を並列実行
  const lightMedium = entries.filter(([_, a]) => a.cost !== 'heavy')
  const heavy = entries.filter(([_, a]) => a.cost === 'heavy')

  // light/medium: 最大5並列
  for (let i = 0; i < lightMedium.length; i += 5) {
    const batch = lightMedium.slice(i, i + 5)
    const batchResults = await Promise.allSettled(
      batch.map(([id]) => executeAxis(clickhouse, id, params))
    )
    batchResults.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value && r.value.data.length > 0) {
        results.set(batch[idx][0], r.value)
      }
    })
  }

  // heavy: 1つずつ直列実行（メモリ圧迫を防ぐ）
  for (const [id] of heavy) {
    try {
      const result = await executeAxis(clickhouse, id, params)
      if (result && result.data.length > 0) {
        results.set(id, result)
      }
    } catch (e) {
      console.error(`Heavy axis ${id} failed:`, e)
    }
  }

  return results
}

// カテゴリ別に軸を取得
export function getAxesByCategory(category: string): AnalysisAxis[] {
  return Array.from(analysisAxes.values()).filter(a => a.category === category)
}

// 軸の一覧（API/MCP用）
export function listAxes(): Array<{ id: string; name: string; description: string; category: string; cost: string }> {
  return Array.from(analysisAxes.values()).map(a => ({
    id: a.id, name: a.name, description: a.description, category: a.category, cost: a.cost,
  }))
}
