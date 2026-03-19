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
  category: 'conversion' | 'engagement' | 'friction' | 'persona' | 'content' | 'traffic' | 'demographic'
  query: string
  // 必須パラメータ
  requiredParams: string[]
  // AI向けのプロンプトヒント（結果をどう解釈すべきか）
  aiPromptHint: string
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
  query: `
    SELECT toDayOfWeek(min_ts) as day_of_week, device_type,
      count() as sessions,
      countIf(converted = 1) / greatest(count(), 1) * 100 as cvr
    FROM (
      SELECT session_id, any(device_type) as device_type,
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

// --- 軸の実行ヘルパー ---

export async function executeAxis(
  clickhouse: any,
  axisId: string,
  params: Record<string, string>
): Promise<{ axis: AnalysisAxis; data: any[] } | null> {
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

  const data = await result.json()
  return { axis, data: data as any[] }
}

// 全軸を一括実行
export async function executeAllAxes(
  clickhouse: any,
  params: Record<string, string>
): Promise<Map<string, { axis: AnalysisAxis; data: any[] }>> {
  const results = new Map()

  for (const [id, axis] of Array.from(analysisAxes.entries())) {
    try {
      const result = await executeAxis(clickhouse, id, params)
      if (result && result.data.length > 0) {
        results.set(id, result)
      }
    } catch (e) {
      console.error(`Axis ${id} failed:`, e)
    }
  }

  return results
}

// カテゴリ別に軸を取得
export function getAxesByCategory(category: string): AnalysisAxis[] {
  return Array.from(analysisAxes.values()).filter(a => a.category === category)
}

// 軸の一覧（API/MCP用）
export function listAxes(): Array<{ id: string; name: string; description: string; category: string }> {
  return Array.from(analysisAxes.values()).map(a => ({
    id: a.id, name: a.name, description: a.description, category: a.category,
  }))
}
