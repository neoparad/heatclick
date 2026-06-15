/**
 * REQ-SEC-006 — scenario delivery kill-switch unit tests.
 */

import {
  isDeliveryKilled,
  isScenarioDeliveryGloballyDisabled,
  isScenarioDisabled,
  isTenantDeliveryDisabled,
} from './kill-switch'

describe('scenario delivery kill-switch (REQ-SEC-006)', () => {
  const ORIGINAL_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('global disable', () => {
    delete process.env.SCENARIO_DELIVERY_DISABLED
    expect(isScenarioDeliveryGloballyDisabled()).toBe(false)
    process.env.SCENARIO_DELIVERY_DISABLED = '1'
    expect(isScenarioDeliveryGloballyDisabled()).toBe(true)
    expect(isDeliveryKilled('any', 'any')).toBe(true)
  })

  it('per-tenant disable', () => {
    delete process.env.SCENARIO_DELIVERY_DISABLED
    process.env.SCENARIO_DELIVERY_DISABLED_TENANTS = 'tenant_a, tenant_b'
    expect(isTenantDeliveryDisabled('tenant_a')).toBe(true)
    expect(isTenantDeliveryDisabled('tenant_b')).toBe(true)
    expect(isTenantDeliveryDisabled('tenant_c')).toBe(false)
    expect(isDeliveryKilled('tenant_a', 'sid')).toBe(true)
    expect(isDeliveryKilled('tenant_c', 'sid')).toBe(false)
  })

  it('per-scenario disable', () => {
    delete process.env.SCENARIO_DELIVERY_DISABLED
    delete process.env.SCENARIO_DELIVERY_DISABLED_TENANTS
    process.env.SCENARIO_DELIVERY_DISABLED_IDS = 'id-1,id-2'
    expect(isScenarioDisabled('id-1')).toBe(true)
    expect(isScenarioDisabled('id-3')).toBe(false)
    expect(isDeliveryKilled('t', 'id-1')).toBe(true)
    expect(isDeliveryKilled('t', 'id-3')).toBe(false)
  })

  it('nothing killed by default', () => {
    delete process.env.SCENARIO_DELIVERY_DISABLED
    delete process.env.SCENARIO_DELIVERY_DISABLED_TENANTS
    delete process.env.SCENARIO_DELIVERY_DISABLED_IDS
    expect(isDeliveryKilled('t', 'sid')).toBe(false)
  })
})
