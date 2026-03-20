import { TrendingUp, TrendingDown, type LucideIcon } from 'lucide-react'

interface ChangeData {
  value: string
  isPositive: boolean
}

interface KPICardProps {
  title: string
  value: string | number
  suffix?: string
  icon: LucideIcon
  iconColor: string
  change?: ChangeData | null
  description?: string
  invertChangeColor?: boolean // 直帰率のように低い方が良い指標
}

export default function KPICard({
  title,
  value,
  suffix,
  icon: Icon,
  iconColor,
  change,
  description,
  invertChangeColor = false,
}: KPICardProps) {
  const positiveColor = invertChangeColor ? 'text-red-600' : 'text-green-600'
  const negativeColor = invertChangeColor ? 'text-green-600' : 'text-red-600'

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-600">{title}</span>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
      <div className="text-3xl font-bold mb-2">
        {typeof value === 'number' ? value.toLocaleString() : value}
        {suffix && <span className="text-base font-normal text-gray-400 ml-0.5">{suffix}</span>}
      </div>
      <div className="flex items-center gap-1 text-sm">
        {change ? (
          <div className={`flex items-center gap-1 ${change.isPositive ? positiveColor : negativeColor}`}>
            {change.isPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            <span className="font-medium">{change.value}</span>
            <span className="text-gray-500">vs 前期間</span>
          </div>
        ) : (
          description && <span className="text-gray-500">{description}</span>
        )}
      </div>
    </div>
  )
}
