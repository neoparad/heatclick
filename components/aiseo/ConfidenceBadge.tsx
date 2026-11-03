import {
  CONFIDENCE_CLASS,
  CONFIDENCE_LABEL,
  CONFIDENCE_SHORT,
  type ConfidenceLevel,
} from '@/lib/aiseo/confidence'

interface ConfidenceBadgeProps {
  level?: ConfidenceLevel | null
  reason?: string
  compact?: boolean
}

export default function ConfidenceBadge({
  level,
  reason,
  compact,
}: ConfidenceBadgeProps) {
  const lv: ConfidenceLevel = level || 'insufficient'
  const cls = CONFIDENCE_CLASS[lv] || 'chip'
  const label = compact ? CONFIDENCE_SHORT[lv] || lv : CONFIDENCE_LABEL[lv] || lv
  return (
    <span className={'cov ' + cls} title={reason || undefined}>
      {label}
    </span>
  )
}
