// ClickHouse heatmap tables setup script
const { createClient } = require('@clickhouse/client');

async function setupTables() {
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
    console.log('Connecting to ClickHouse...');

    // Test connection
    const testResult = await client.query({
      query: 'SELECT 1',
      format: 'JSONEachRow',
    });
    console.log('✅ Connected to ClickHouse successfully');

    // Create heatmap_daily_summary table
    console.log('\n📊 Creating heatmap_daily_summary table...');
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS clickinsight.heatmap_daily_summary (
          site_id String,
          page_url String,
          device_type String,
          event_type String,
          date Date,
          click_x UInt16,
          click_y UInt16,
          click_count UInt32,
          unique_sessions UInt32,
          last_updated DateTime DEFAULT now()
        )
        ENGINE = SummingMergeTree()
        ORDER BY (site_id, page_url, event_type, date, device_type, click_x, click_y)
        PARTITION BY toYYYYMM(date)
      `,
    });
    console.log('✅ Table heatmap_daily_summary created successfully');

    // Create materialized view
    console.log('\n📊 Creating materialized view...');
    await client.exec({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS clickinsight.heatmap_daily_summary_mv
        TO clickinsight.heatmap_daily_summary
        AS
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
      `,
    });
    console.log('✅ Materialized view created successfully');

    // Verify tables
    console.log('\n🔍 Verifying tables...');
    const tableCheck = await client.query({
      query: 'SELECT count() as count FROM clickinsight.heatmap_daily_summary',
      format: 'JSONEachRow',
    });
    const tableData = await tableCheck.json();
    console.log(`✅ Table heatmap_daily_summary exists (rows: ${tableData[0]?.count || 0})`);

    console.log('\n✨ Setup completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Add Inngest keys to .env.local:');
    console.log('   INNGEST_EVENT_KEY=your_inngest_event_key');
    console.log('   INNGEST_SIGNING_KEY=your_inngest_signing_key');
    console.log('\n2. Run initial data aggregation:');
    console.log('   curl -X POST http://localhost:3000/api/inngest/rebuild');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    await client.close();
  }
}

setupTables();
