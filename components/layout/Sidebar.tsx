'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { 
  BarChart3, 
  Map, 
  MousePointerClick, 
  Brain, 
  FileText, 
  Settings, 
  Globe,
  Zap,
  Activity,
  Video
} from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'

const menuItems = [
  { id: 'dashboard', icon: BarChart3, label: 'ダッシュボード', href: '/dashboard' },
  { id: 'realtime', icon: Activity, label: 'リアルタイム', href: '/realtime' },
  { id: 'heatmap', icon: Map, label: 'ヒートマップ', href: '/heatmap' },
  { id: 'sites', icon: Globe, label: 'サイト管理', href: '/sites' },
  { id: 'clicks', icon: MousePointerClick, label: 'クリック分析', href: '/clicks' },
  { id: 'recordings', icon: Video, label: 'セッション録画', href: '/recordings' },
  { id: 'ai-insights', icon: Brain, label: 'AI分析', href: '/ai-insights' },
  { id: 'reports', icon: FileText, label: 'レポート', href: '/reports' },
  { id: 'settings', icon: Settings, label: '設定', href: '/settings' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [usage, setUsage] = useState({
    plan: 'Free',
    usage: 0,
    limit: 5000,
    percentage: 0,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const user = getCurrentUser()
        if (!user || !user.id) {
          setLoading(false)
          return
        }

        const plan = user.plan || 'free'
        const response = await fetch(`/api/usage?user_id=${user.id}&plan=${plan}`)
        if (response.ok) {
          const result = await response.json()
          if (result.success && result.data) {
            setUsage(result.data)
          }
        }
      } catch (error) {
        console.error('Error fetching usage:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchUsage()
  }, [])

  const handleLogoClick = () => {
    router.push('/')
  }

  const getPlanDisplayName = (plan: string) => {
    const planMap: Record<string, string> = {
      free: 'Free',
      starter: 'Starter',
      professional: 'Professional',
      business: 'Business',
    }
    return planMap[plan.toLowerCase()] || plan
  }

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col hidden lg:flex">
      <div className="p-6 border-b border-gray-200">
        <button
          onClick={handleLogoClick}
          className="flex items-center hover:opacity-80 transition-opacity cursor-pointer"
          aria-label="ホームに戻る"
        >
          <div className="w-10 h-10 bg-gradient-to-br from-pink-500 via-blue-500 to-blue-600 rounded-lg flex items-center justify-center shadow-md">
            <span className="text-white font-bold text-xl">U</span>
          </div>
        </button>
      </div>
      
      <nav className="flex-1 p-4 space-y-1">
        {menuItems.map(item => (
          <Link
            key={item.id}
            href={item.href}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              pathname === item.href
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <item.icon className="w-5 h-5" />
            <span className="font-medium">{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200">
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-5 h-5 text-blue-600" />
            <span className="font-semibold text-sm">
              {loading ? '読み込み中...' : `${usage.plan} プラン`}
            </span>
          </div>
          <p className="text-xs text-gray-600 mb-2">今月の使用量</p>
          {loading ? (
            <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
              <div className="bg-gray-300 h-2 rounded-full" style={{ width: '0%' }} />
            </div>
          ) : (
            <>
              <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                <div 
                  className={`h-2 rounded-full ${
                    usage.percentage >= 90 
                      ? 'bg-red-600' 
                      : usage.percentage >= 70 
                      ? 'bg-yellow-600' 
                      : 'bg-blue-600'
                  }`}
                  style={{ width: `${Math.min(100, usage.percentage)}%` }} 
                />
              </div>
              <p className="text-xs text-gray-500">
                {usage.usage.toLocaleString()} / {usage.limit.toLocaleString()} PV
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
