/**
 * Phase 2.1 frequency_cap / schedule schema tests + server-side schedule filter.
 */

import { FrequencyCapSchema, ScheduleSchema, ScenarioSchema } from './types'
import { isScenarioInSchedule } from './schedule-utils'

describe('FrequencyCapSchema', () => {
  it('accepts valid period + max_impressions', () => {
    for (const period of ['session', 'day', 'week'] as const) {
      const ok = FrequencyCapSchema.safeParse({ per_period: period, max_impressions: 3 })
      expect(ok.success).toBe(true)
    }
  })

  it('rejects unknown period', () => {
    expect(FrequencyCapSchema.safeParse({ per_period: 'month', max_impressions: 1 }).success).toBe(false)
  })

  it('rejects max_impressions out of [1,100]', () => {
    expect(FrequencyCapSchema.safeParse({ per_period: 'day', max_impressions: 0 }).success).toBe(false)
    expect(FrequencyCapSchema.safeParse({ per_period: 'day', max_impressions: 101 }).success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(
      FrequencyCapSchema.safeParse({ per_period: 'day', max_impressions: 3, extra: 'x' }).success,
    ).toBe(false)
  })
})

describe('ScheduleSchema', () => {
  it('accepts empty / nulls', () => {
    expect(ScheduleSchema.safeParse({}).success).toBe(true)
    expect(ScheduleSchema.safeParse({ start_at: null, end_at: null }).success).toBe(true)
  })

  it('accepts valid ISO datetimes', () => {
    expect(
      ScheduleSchema.safeParse({
        start_at: '2026-07-01T00:00:00Z',
        end_at: '2026-07-31T23:59:59Z',
      }).success,
    ).toBe(true)
  })

  it('rejects start >= end', () => {
    expect(
      ScheduleSchema.safeParse({
        start_at: '2026-07-31T23:59:59Z',
        end_at: '2026-07-01T00:00:00Z',
      }).success,
    ).toBe(false)
  })

  it('rejects non-ISO strings', () => {
    expect(
      ScheduleSchema.safeParse({ start_at: '2026/07/01', end_at: null }).success,
    ).toBe(false)
  })
})

describe('ScenarioSchema includes additive fields', () => {
  function baseScenario() {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      tenant_id: 'tenant_a',
      site_id: 'site_x',
      name: 'test',
      description: '',
      condition_ast: { op: 'AND', children: [{ op: 'EQ', field: 'utm_source', value: 'google' }] },
      variants: [
        {
          id: 'A',
          content_type: 'image' as const,
          image_url: 'https://cdn.example.com/x.png',
          image_alt: '',
          position: 'center' as const,
          traffic_split: 100,
        },
      ],
      status: 'draft' as const,
      evidence_level: 'planned' as const,
      evidence_data: {},
      created_at: '2026-06-07T00:00:00Z',
      updated_at: '2026-06-07T00:00:00Z',
      created_by: 'user_1',
      archived_at: null,
    }
  }

  it('omitting frequency_cap / schedule is valid (backward compat)', () => {
    expect(ScenarioSchema.safeParse(baseScenario()).success).toBe(true)
  })

  it('frequency_cap=null and schedule=null both pass', () => {
    expect(
      ScenarioSchema.safeParse({ ...baseScenario(), frequency_cap: null, schedule: null }).success,
    ).toBe(true)
  })

  it('valid frequency_cap and schedule pass', () => {
    expect(
      ScenarioSchema.safeParse({
        ...baseScenario(),
        frequency_cap: { per_period: 'day', max_impressions: 3 },
        schedule: { start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T23:59:59Z' },
      }).success,
    ).toBe(true)
  })

  it('invalid frequency_cap fails the parent', () => {
    expect(
      ScenarioSchema.safeParse({
        ...baseScenario(),
        frequency_cap: { per_period: 'bogus', max_impressions: 3 },
      }).success,
    ).toBe(false)
  })
})

describe('isScenarioInSchedule (server-side filter)', () => {
  const NOW = Date.UTC(2026, 6, 15, 12, 0, 0) // 2026-07-15T12:00:00Z

  it('returns true when schedule is undefined / null', () => {
    expect(isScenarioInSchedule(undefined, NOW)).toBe(true)
    expect(isScenarioInSchedule(null, NOW)).toBe(true)
  })

  it('returns true within window', () => {
    expect(
      isScenarioInSchedule(
        { start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T23:59:59Z' },
        NOW,
      ),
    ).toBe(true)
  })

  it('returns false before start_at', () => {
    expect(
      isScenarioInSchedule({ start_at: '2026-07-20T00:00:00Z', end_at: null }, NOW),
    ).toBe(false)
  })

  it('returns false at or after end_at', () => {
    expect(
      isScenarioInSchedule({ start_at: null, end_at: '2026-07-15T12:00:00Z' }, NOW),
    ).toBe(false)
    expect(
      isScenarioInSchedule({ start_at: null, end_at: '2026-07-10T00:00:00Z' }, NOW),
    ).toBe(false)
  })

  it('fail-closed on invalid ISO', () => {
    expect(
      isScenarioInSchedule({ start_at: 'not-a-date', end_at: null }, NOW),
    ).toBe(false)
    expect(
      isScenarioInSchedule({ start_at: null, end_at: 'still-not' }, NOW),
    ).toBe(false)
  })
})
