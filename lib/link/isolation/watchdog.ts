/**
 * UGOKI LINK v2 — 5-Minute Tenant Isolation Watchdog & F-01 Incident Hold
 * (`store-final.md` M7 / `store.G-9` / Master Architecture v2 §5.6)
 *
 * Runs 4 canary checks across every tenant table every 5 minutes:
 *   1. Negative canary: user without row policy MUST read 0 rows
 *   2. Positive canary: canary tenant A reads exact N seeded marker rows
 *   3. Cross-tenant canary: canary tenant A reads 0 rows belonging to canary tenant B
 *   4. Injection canary: `SETTINGS` / `additional_table_filters` / `SET ROLE` fails
 *
 * On ANY violation:
 *   - Places affected table into `isolation_hold` (HTTP 503) via `TenantScopedQueryBuilder`
 *   - Emits an incident `F-01` (Sev-1) alert
 */

import type { TenantScopedQueryBuilder } from './query-builder';
import type { ClickHouseIsolationSimulator } from './row-policy';

export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

export type WatchdogProbeName =
  | 'negative_no_policy'
  | 'positive_canary_markers'
  | 'cross_tenant_zero_leak'
  | 'settings_and_role_injection';

export interface WatchdogProbeResult {
  readonly table: string;
  readonly probe: WatchdogProbeName;
  readonly passed: boolean;
  readonly detail: string;
}

export interface IncidentF01Alert {
  readonly incidentCode: 'F-01';
  readonly severity: 'sev1';
  readonly timestamp: string;
  readonly table: string;
  readonly failedProbe: WatchdogProbeName;
  readonly actionTaken: 'table_isolation_hold_503';
  readonly detail: string;
}

export interface WatchdogRunReport {
  readonly ranAt: string;
  readonly allPassed: boolean;
  readonly tablesChecked: ReadonlyArray<string>;
  readonly heldTables: ReadonlyArray<string>;
  readonly probes: ReadonlyArray<WatchdogProbeResult>;
  readonly alerts: ReadonlyArray<IncidentF01Alert>;
}

export interface WatchdogConfig {
  readonly canaryTenantA: string;
  readonly canaryUserA: string;
  readonly expectedMarkersA: number;
  readonly canaryTenantB: string;
  readonly policylessCanaryUser: string;
  readonly tables: ReadonlyArray<string>;
}

export class IsolationWatchdog {
  private consecutiveCleanRuns = 0;
  private readonly alertHistory: IncidentF01Alert[] = [];

  public getConsecutiveCleanRuns(): number {
    return this.consecutiveCleanRuns;
  }

  public getAlertHistory(): ReadonlyArray<IncidentF01Alert> {
    return [...this.alertHistory];
  }

  public runCycle(params: {
    readonly simulator: ClickHouseIsolationSimulator;
    readonly queryBuilder: TenantScopedQueryBuilder;
    readonly config: WatchdogConfig;
    readonly now?: Date;
  }): WatchdogRunReport {
    const now = params.now ?? new Date();
    const ranAt = now.toISOString();
    const { simulator, queryBuilder, config } = params;

    const probes: WatchdogProbeResult[] = [];
    const alerts: IncidentF01Alert[] = [];
    const newlyHeld = new Set<string>();

    const recordFailure = (table: string, probe: WatchdogProbeName, detail: string) => {
      probes.push({ table, probe, passed: false, detail });
      newlyHeld.add(table);
      queryBuilder.setTableIsolationHold(table, true);
      const alert: IncidentF01Alert = {
        incidentCode: 'F-01',
        severity: 'sev1',
        timestamp: ranAt,
        table,
        failedProbe: probe,
        actionTaken: 'table_isolation_hold_503',
        detail,
      };
      alerts.push(alert);
      this.alertHistory.push(alert);
    };

    for (const table of config.tables) {
      // Probe 1: Negative canary — user without row policy MUST read 0 rows
      const negRes = simulator.executeSelect({
        username: config.policylessCanaryUser,
        table,
      });
      if (!negRes.ok) {
        // Access denied also guarantees 0 rows readable
        probes.push({
          table,
          probe: 'negative_no_policy',
          passed: true,
          detail: `Policyless user denied access (${negRes.error})`,
        });
      } else if (negRes.rows.length === 0) {
        probes.push({
          table,
          probe: 'negative_no_policy',
          passed: true,
          detail: 'Policyless canary user read 0 rows',
        });
      } else {
        recordFailure(
          table,
          'negative_no_policy',
          `Policyless user read ${negRes.rows.length} rows (expected 0)`
        );
      }

      // Probe 2: Positive canary — tenant A reads exact N markers
      const posRes = simulator.executeSelect({
        username: config.canaryUserA,
        table,
        filter: (r) => r.tenant_id === config.canaryTenantA,
      });
      if (posRes.ok && posRes.rows.length === config.expectedMarkersA) {
        probes.push({
          table,
          probe: 'positive_canary_markers',
          passed: true,
          detail: `Canary tenant A read exact ${config.expectedMarkersA} markers`,
        });
      } else {
        recordFailure(
          table,
          'positive_canary_markers',
          posRes.ok
            ? `Canary tenant A read ${posRes.rows.length} markers (expected ${config.expectedMarkersA})`
            : `Positive canary query failed: ${posRes.error}`
        );
      }

      // Probe 3: Cross-tenant canary — tenant A querying tenant B MUST read 0 rows
      const crossRes = simulator.executeSelect({
        username: config.canaryUserA,
        table,
        filter: (r) => r.tenant_id === config.canaryTenantB,
      });
      if (crossRes.ok && crossRes.rows.length === 0) {
        probes.push({
          table,
          probe: 'cross_tenant_zero_leak',
          passed: true,
          detail: 'Cross-tenant query returned 0 rows',
        });
      } else {
        recordFailure(
          table,
          'cross_tenant_zero_leak',
          crossRes.ok
            ? `Cross-tenant leak detected! Tenant A saw ${crossRes.rows.length} rows of tenant B`
            : `Cross-tenant probe errored unexpectedly: ${crossRes.error}`
        );
      }

      // Probe 4: Injection canary — SETTINGS / additional_table_filters / SET ROLE MUST fail
      const injectionPayloads = [
        `SELECT tenant_id FROM ${table} SETTINGS additional_table_filters={'${table}':'1=1'}`,
        `SET ROLE admin; SELECT tenant_id FROM ${table}`,
      ];
      let injectionBlocked = true;
      let injectionFailureDetail = '';
      for (const badSql of injectionPayloads) {
        const injRes = simulator.executeSelect({
          username: config.canaryUserA,
          table,
          sql: badSql,
        });
        if (injRes.ok) {
          injectionBlocked = false;
          injectionFailureDetail = `Injection SQL succeeded under ${config.canaryUserA}: ${badSql}`;
          break;
        }
      }
      if (injectionBlocked) {
        probes.push({
          table,
          probe: 'settings_and_role_injection',
          passed: true,
          detail: 'SETTINGS / additional_table_filters / SET ROLE injections rejected',
        });
      } else {
        recordFailure(table, 'settings_and_role_injection', injectionFailureDetail);
      }
    }

    const allPassed = alerts.length === 0;
    if (allPassed) {
      this.consecutiveCleanRuns += 1;
    } else {
      this.consecutiveCleanRuns = 0;
    }

    return {
      ranAt,
      allPassed,
      tablesChecked: [...config.tables],
      heldTables: [...newlyHeld],
      probes,
      alerts,
    };
  }
}
