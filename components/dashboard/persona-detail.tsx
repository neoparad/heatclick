/**
 * Persona Detail Panel — P-05 personas page の cluster detail (KpiCard × 4 + behaviors + actions)
 *
 * 親 SSOT Part V §5.5.2 P-05 / §1.6 / D-07
 *
 * Sprint 2 W2 では inline 展開 (Sheet primitive 未配備のため)。
 * Sprint 3 で Sheet (`@radix-ui/react-dialog` ベース) に置換予定。
 *
 * D-07 整合:
 *   - inferred の KPI は range + 「推定」prefix を fixture 側で保証済
 *   - suggestedActions は inferred 時 "(仮説)" suffix を fixture 側で付与
 */

import { Card } from '@/components/ui/card'
import type { PersonaCluster, PersonaKpi } from '@/lib/fixtures/personas'
import { EvidenceBadge } from './evidence-badge'

interface PersonaDetailProps {
  cluster: PersonaCluster
}

export function PersonaDetail({ cluster }: PersonaDetailProps) {
  return (
    <Card
      aria-labelledby="persona-detail-title"
      data-testid={`persona-detail-${cluster.label}`}
      className="p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
            Persona Detail
          </p>
          <h2 id="persona-detail-title" className="text-xl font-bold tracking-tight">
            {cluster.displayName}
          </h2>
          <p className="text-sm text-text-2">{cluster.description}</p>
        </div>
        <EvidenceBadge evidence={cluster.evidence} />
      </div>

      <section aria-label="Persona KPI" className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cluster.kpis.map((kpi) => (
          <PersonaKpiCard key={kpi.id} kpi={kpi} />
        ))}
      </section>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <section aria-label="代表行動">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">
            代表行動
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm text-text-2">
            {cluster.detail.behaviors.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="select-none text-text-3" aria-hidden>
                  ・
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="推奨次アクション">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">
            推奨次アクション {cluster.evidence.level === 'inferred' ? '(仮説)' : ''}
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm text-text-2">
            {cluster.detail.suggestedActions.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="select-none text-text-3" aria-hidden>
                  →
                </span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="mt-5 border-t border-border pt-3 font-mono text-[10px] text-text-3">
        cluster_ref: {cluster.refId}
      </p>
    </Card>
  )
}

function PersonaKpiCard({ kpi }: { kpi: PersonaKpi }) {
  return (
    <Card className="p-3" data-testid={`persona-kpi-${kpi.id}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">
          {kpi.label}
        </p>
        <EvidenceBadge evidence={kpi.evidence} compact />
      </div>
      <p className="mt-1.5 text-base font-semibold text-foreground">{kpi.value}</p>
      {kpi.unit ? <p className="text-[11px] text-text-3">{kpi.unit}</p> : null}
    </Card>
  )
}
