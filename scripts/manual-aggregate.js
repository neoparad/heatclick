// Manual data aggregation script (without Inngest)
const { createClient } = require('@clickhouse/client');

async function aggregateData() {
  // secrets はハードコードしない (git 露出禁止)。env 必須・未設定なら fail-fast。
  const url = process.env.CLICKHOUSE_URL;
  const password = process.env.CLICKHOUSE_PASSWORD;
  if (!url || !password) {
    console.error('CLICKHOUSE_URL と CLICKHOUSE_PASSWORD を環境変数で設定してください (ハードコード fallback は廃止)。');
    process.exit(1);
  }
  const client = createClient({
    url,
    username: process.env.CLICKHOUSE_USER || 'default',
    password,
    database: process.env.CLICKHOUSE_DATABASE || 'clickinsight',
  });

  try {
    console.log('🚀 Starting manual data aggregation...');
    console.log('Connecting to ClickHouse...');

    // Check existing events count
    console.log('\n📊 Checking existing events...');
    const eventsCountResult = await client.query({
      query: 'SELECT count() as count FROM clickinsight.events WHERE event_type = \'click\' AND click_x > 0 AND click_y > 0',
      format: 'JSONEachRow',
    });
    const eventsData = await eventsCountResult.json();
    const totalEvents = eventsData[0]?.count || 0;
    console.log(`✅ Found ${totalEvents} click events to aggregate`);

    if (totalEvents === 0) {
      console.log('⚠️  No click events found. Skipping aggregation.');
      return;
    }

    // Aggregate all historical data
    console.log('\n📦 Aggregating historical data...');
    console.log('This may take a few minutes depending on data volume...');

    const aggregateQuery = `
      INSERT INTO clickinsight.heatmap_daily_summary
      SELECT
        site_id,
        url AS page_url,
        CASE
          WHEN viewport_width >= 1024 THEN 'desktop'
          WHEN viewport_width >= 768 THEN 'tablet'
          ELSE 'mobile'
        END AS device_type,
        event_type,
        toDate(timestamp) AS date,
        click_x,
        click_y,
        count() AS click_count,
        uniq(session_id) AS unique_sessions,
        now() AS last_updated
      FROM clickinsight.events
      WHERE event_type = 'click'
        AND click_x > 0
        AND click_y > 0
      GROUP BY site_id, page_url, device_type, event_type, date, click_x, click_y
    `;

    await client.exec({ query: aggregateQuery });
    console.log('✅ Historical data aggregated successfully');

    // Verify aggregated data
    console.log('\n🔍 Verifying aggregated data...');
    const summaryCountResult = await client.query({
      query: 'SELECT count() as count, sum(click_count) as total_clicks FROM clickinsight.heatmap_daily_summary',
      format: 'JSONEachRow',
    });
    const summaryData = await summaryCountResult.json();
    const aggregatedRows = summaryData[0]?.count || 0;
    const totalClicks = summaryData[0]?.total_clicks || 0;

    console.log(`✅ Aggregated ${aggregatedRows} unique positions`);
    console.log(`✅ Total clicks: ${totalClicks}`);

    // Show sample data
    console.log('\n📝 Sample aggregated data (top 10):');
    const sampleResult = await client.query({
      query: `
        SELECT
          site_id,
          page_url,
          device_type,
          click_x,
          click_y,
          click_count,
          unique_sessions,
          date
        FROM clickinsight.heatmap_daily_summary
        ORDER BY click_count DESC
        LIMIT 10
      `,
      format: 'JSONEachRow',
    });
    const sampleData = await sampleResult.json();
    console.table(sampleData);

    console.log('\n✨ Aggregation completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Test the heatmap API:');
    console.log('   npm run dev');
    console.log('   Then visit http://localhost:3000/heatmap');
    console.log('\n2. After confirming it works, add Inngest keys to automate daily aggregation:');
    console.log('   INNGEST_EVENT_KEY=your_key');
    console.log('   INNGEST_SIGNING_KEY=your_key');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    await client.close();
  }
}

aggregateData();
