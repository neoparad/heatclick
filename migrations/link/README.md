# UGOKI LINK v2 — Storage Migrations (`migrations/link`)

> **WARNING — Owner-Only Production Execution**
> Agents and CI pipelines MUST NEVER execute these SQL files against production databases.
> These files are generated directly from [`packages/contract/schema/canonical.ts`](../../packages/contract/schema/canonical.ts) and verified by CI zero-diff tests (`lib/link/store/store.test.ts`).

## Generated Files

| File | Dialect | Tables | Source Generator | SHA-256 (schema v2.0.0) |
| --- | --- | ---: | --- | --- |
| `001_clickhouse_v2.sql` | ClickHouse | 27 | `generateClickHouseDdl(CANONICAL_SCHEMA)` | `5830c3f112763fa2c61a148cd0d8798e138bfdc06b83117f40710552d2ecfedb` |
| `002_postgres_v2.sql` | PostgreSQL | 4 | `generatePostgresDdl(CANONICAL_SCHEMA)` | `15bf65dcb4cc674880fa65d2730bb7b44d7d0f565d75d7c399f088d12ec17369` |

**Do not hand-edit `001_clickhouse_v2.sql` or `002_postgres_v2.sql`.** Any schema change MUST be authored in `packages/contract/schema/canonical.ts`, regenerated, and verified with `npx jest lib/link/store`.

---

## Prerequisites Before Production Apply

1. **Step 0 Baseline Captured**
   Run `node scripts/link/inspect-prod-baseline.mjs` against the existing environment and archive the baseline report before provisioning or touching v2 tables.
2. **Dedicated 8 GiB ClickHouse Node (Decision 5 / `D-05`)**
   - Provision a **dedicated** ClickHouse **LTS >= 26.3** node with **8 GiB RAM** (never co-located on a shared 2 GiB host).
   - Configure `max_server_memory_usage = 7730941132` (~7.2 GiB, 90% of host RAM). The working budget caps planned steady-state usage at **5.74 GiB** (<= 85% of the 7.2 GiB server limit = 6.12 GiB):
     - Background merges & mutations: `1.40 GiB`
     - Mark / uncompressed / schema caches: `0.90 GiB`
     - `api_live` lane (6 concurrent × 160 MiB): `0.94 GiB`
     - `api_heavy` lane (2 concurrent × 512 MiB): `1.00 GiB`
     - Single `maintenance` lane (1 concurrent × 768 MiB; priority `builder > deletion > rebuild > extract > backfill`): `0.75 GiB`
     - `loader` lane (2 concurrent × 256 MiB): `0.50 GiB`
     - Independent reconciliation lane: `0.25 GiB`
3. **Fail-Closed Row Policy Server Setting (`store.M7` / §5.6)**
   - In ClickHouse `users.xml` / SQL access control, enforce:
     ```xml
     <users_without_row_policies_can_read_rows>0</users_without_row_policies_can_read_rows>
     ```
   - Create the service roles referenced in `001_clickhouse_v2.sql` (`ugk_admin`, `ugk_loader`, `ugk_builder`, `ugk_eraser`) and per-tenant read-only roles (`ugk_ro_<tenant_id>`).
   - Never grant `ugk_ro_*` roles read access without both the `PERMISSIVE` and `RESTRICTIVE` row policies active.
4. **Data Residency Pinning (Decision 29 / `D-29`)**
   - Confirm target ClickHouse, PostgreSQL, and Cloudflare R2 bucket locations match the tenant's pinned storage region (`jp` default, or `eu` / `us` per `tenant_sites.storage_region`).
5. **PostgreSQL Control Plane**
   - Ensure the application database role is **non-superuser** and does not have `BYPASSRLS`, so `ALTER TABLE ... FORCE ROW LEVEL SECURITY` with `RESTRICTIVE` `app.tenant_id` policies is enforced on every query.

---

## Why Materialized Views and Projections Are Strictly Banned on Tenant Tables

`001_clickhouse_v2.sql` intentionally contains **zero** `CREATE MATERIALIZED VIEW` statements and **zero** `PROJECTION` clauses. CI (`lib/link/store/store.test.ts` and `packages/contract/schema/ddl-generator.ts`) fails the build if either appears.

### 1. Why Materialized Views Are Banned (`[ch 2, 4]`, Master Spec §5.1, `store-final.md`)
- **Insert-time triggers without transactional rollback**: ClickHouse Materialized Views execute synchronously on incoming `INSERT` blocks. If an MV fails mid-batch (schema mismatch, type cast error, OOM, or null constraint), the base table and other MVs are left in a partially written state with no atomic rollback.
- **v1 Production Failure Precedent**: In UGOKI v1, insert-time MVs caused **1,742 null-insert failures** and silent metric drift.
- **Unbounded memory amplification on 8 GiB RAM**: Multiple MVs reading the same insert block multiply in-flight merge/aggregation RAM beyond the 7.2 GiB ceiling, triggering OOM kills and retry loops.
- **Duplicate/reordered frame fragility**: MVs cannot cleanly recalculate when late frames arrive, when `urlkey/2` aliases change, or when a 14-day subject erasure deletes underlying PVs.
- **v2 Replacement**: Single-writer loader writes idempotent base tables (`page_view_state`, `events_v2`, `pv_index`, etc.), and a scheduled **1-hour sealed rollup builder** (`workers/link-loader/rollup-builder.ts`) computes immutable `build_seq` rollups inside the single 768 MiB maintenance lane, switching visibility atomically via `rollup_manifest`.

### 2. Why Projections Are Banned (`[ch 13]`, `store-final.md`)
- **Ignored by `FINAL`**: ClickHouse ignores projections whenever `FINAL` is used on `ReplacingMergeTree` / `AggregatingMergeTree` queries, providing zero benefit on unsealed tail reads.
- **Breaks 14-day erasure**: Projections block or complicate ClickHouse lightweight `DELETE` mutations (`DELETE FROM ... WHERE ...`), violating the 5-day physical purge / 14-day certified erasure SLA (`store.G-8`).

---

## Applying Procedure (Owner Runbook)

### Step 1 — Verify Zero-Diff Against Contract Schema
```bash
npx jest lib/link/store
```

### Step 2 — Apply ClickHouse DDL (`001_clickhouse_v2.sql`)
1. Confirm roles exist (`ugk_admin`, `ugk_loader`, `ugk_builder`, `ugk_eraser`) and `users_without_row_policies_can_read_rows = 0`.
2. Apply inside the target v2 database (never overwriting legacy v1 tables):
   ```bash
   clickhouse-client \
     --host "$CH_V2_HOST" --port "$CH_V2_PORT" --secure \
     --user ugk_admin --database "$CH_V2_DB" \
     --multiquery < migrations/link/001_clickhouse_v2.sql
   ```
3. Post-apply checks:
   - Verify 27 tables exist and `SELECT count() FROM system.tables WHERE database = currentDatabase() AND engine LIKE '%MaterializedView%'` returns `0`.
   - Verify `SELECT count() FROM system.row_policies WHERE database = currentDatabase()` returns `54` (`27 tables × 2 policies [PERMISSIVE + RESTRICTIVE]`).
   - Run a cross-tenant canary query as `ugk_ro_<tenant_a>` targeting `tenant_b` and verify `0` rows returned.

### Step 3 — Apply PostgreSQL Control-Plane DDL (`002_postgres_v2.sql`)
1. Apply within a transaction:
   ```bash
   psql "$PG_V2_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/link/002_postgres_v2.sql
   ```
2. Post-apply checks:
   - Verify all 4 tables (`audit_log`, `deletion_requests`, `disclosure_records`, `tenant_sites`) have `relrowsecurity = true` and `relforcerowsecurity = true` in `pg_class`.
   - Verify a query with unset `app.tenant_id` returns `0` rows.

---

## Rollback & Re-Derivation

- Because all statements use `CREATE TABLE IF NOT EXISTS` and target isolated v2 table names / database, failed initial provisioning can be cleanly dropped in the staging/v2 database without affecting v1 tables.
- Once live, **R2 WAL (`wal/{region}/{shard}/{minute}/{sha256}`) and R2 compacted frame segments (`seg/{exp_week}/{tenant_id}/{site_id}/{day}/{part}`)** are the system of record for replay. Any ClickHouse table corruption or schema migration can be re-derived cleanly via `replayWeekFromWal` (`workers/link-loader/loader.ts`) without data loss.
