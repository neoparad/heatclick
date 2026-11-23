import { DifferencingGuard, filterQueryAndRowsBeforeLlm } from './pre-llm-filter';

const aggregateSql =
  'SELECT sum(page_views) FROM v_pub_segment_agg WHERE tenant_id = {tenant_id:String} AND site_id = {site_id:String} AND day_local >= {start:Date}';
const groupedSql = aggregateSql + '\nGROUP BY segment_id';
const members = Array.from({ length: 12 }, (_, i) => `member_${i}`);

function checkSingleRow(sql: string, cohortMemberIds?: readonly string[]) {
  const guard = new DifferencingGuard();
  const sessionKey = 'fresh-report';
  const verdict = filterQueryAndRowsBeforeLlm({
    sql,
    viewName: 'v_pub_segment_agg',
    metricName: 'page_views',
    requestedColumns: ['page_views'],
    groupByColumns: [],
    rows: [{
      bucketLabel: 'report',
      metricKey: 'page_views',
      metricValue: 24,
      unitCount: 12,
      unit: 'page_views',
      cohortMemberIds,
    }],
    filterSignature: 'report',
    windowStart: '2026-11-01',
    windowEnd: '2026-11-28',
    sessionKey,
    differencingGuard: guard,
  });
  return { verdict, guard, sessionKey };
}

describe('Ask single-row report membership', () => {
  test('a SQL group requires membership even without planner grouping metadata', () => {
    const { verdict, guard, sessionKey } = checkSingleRow(groupedSql);
    expect(verdict.blockedCode).toBe('DIFFERENCING_ATTACK_BLOCKED');
    expect(verdict.safeRows).toHaveLength(0);
    expect(guard.getWindowHistoryLength(sessionKey)).toBe(0);
    expect(guard.getCohortHistoryLength(sessionKey)).toBe(0);
  });

  test('a SQL group with membership is approved and recorded', () => {
    const { verdict, guard, sessionKey } = checkSingleRow(groupedSql, members);
    expect(verdict.allowed).toBe(true);
    expect(guard.getCohortHistoryLength(sessionKey)).toBe(1);
  });

  test('an ungrouped total still works without per-group membership', () => {
    const { verdict } = checkSingleRow(aggregateSql);
    expect(verdict.allowed).toBe(true);
    expect(verdict.safeRows).toHaveLength(1);
  });
});
