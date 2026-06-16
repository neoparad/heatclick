/**
 * Persona Grid — P-05 personas page の cluster チップグリッド
 *
 * 親 SSOT Part V §5.5.2 P-05 / §5.5.0 / D-07
 *
 * - persona チップは neutral gray + name のみ (emo palette 流用禁止、§5.5.2)
 * - 各カードに EvidenceBadge 必須
 * - クリック → 親 onSelect 経由で cluster detail panel に展開
 */

'use client'

import { ChevronRight } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { PersonaCluster } from '@/lib/fixtures/personas'
import { EvidenceBadge } from './evidence-badge'

interface PersonaGridProps {
  clusters: PersonaCluster[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function PersonaGrid({ clusters, selectedId, onSelect }: PersonaGridProps) {
  return (
    <section
      aria-label="Persona clusters"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {clusters.map((cluster) => (
        <PersonaChip
          key={cluster.id}
          cluster={cluster}
          selected={cluster.id === selectedId}
          onSelect={() => onSelect(cluster.id)}
        />
      ))}
    </section>
  )
}

interface PersonaChipProps {
  cluster: PersonaCluster
  selected: boolean
  onSelect: () => void
}

function PersonaChip({ cluster, selected, onSelect }: PersonaChipProps) {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      data-testid={`persona-chip-${cluster.label}`}
      className={cn(
        'group cursor-pointer border-border p-4 transition-colors',
        'hover:border-foreground/30 hover:bg-muted/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected && 'border-foreground/60 bg-muted/60 shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">
            {cluster.label}
          </p>
          <h3 className="mt-1 truncate text-base font-semibold text-foreground">
            {cluster.displayName}
          </h3>
        </div>
        <EvidenceBadge evidence={cluster.evidence} compact />
      </div>

      <p className="mt-2 line-clamp-2 text-xs text-text-2">{cluster.description}</p>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
        <span className="font-mono text-[10px] text-text-3">{cluster.kpis.length} KPI</span>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-text-3 transition-transform',
            selected && 'translate-x-0.5 text-foreground',
          )}
          aria-hidden
        />
      </div>
    </Card>
  )
}
