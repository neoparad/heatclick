'use client'

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
  Activity
} from 'lucide-react'

const menuItems = [
  { id: 'dashboard', icon: BarChart3, label: 'ダッシュボード', href: '/dashboard' },
  { id: 'realtime', icon: Activity, label: 'リアルタイム', href: '/realtime' },
  { id: 'heatmap', icon: Map, label: 'ヒートマップ', href: '/heatmap' },
  { id: 'sites', icon: Globe, label: 'サイト管理', href: '/sites' },
  { id: 'clicks', icon: MousePointerClick, label: 'クリック分析', href: '/clicks' },
  { id: 'ai-insights', icon: Brain, label: 'AI分析', href: '/ai-insights' },
  { id: 'reports', icon: FileText, label: 'レポート', href: '/reports' },
  { id: 'settings', icon: Settings, label: '設定', href: '/settings' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  const handleLogoClick = () => {
    router.push('/')
  }

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col hidden lg:flex">
      <div className="p-6 border-b border-gray-200">
        <button
          onClick={handleLogoClick}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer"
          aria-label="ホームに戻る"
        >
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg">ClickInsight Pro</span>
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
            <span className="font-semibold text-sm">Starter プラン</span>
          </div>
          <p className="text-xs text-gray-600 mb-2">今月の使用量</p>
          <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
            <div className="bg-blue-600 h-2 rounded-full" style={{ width: '65%' }} />
          </div>
          <p className="text-xs text-gray-500">32,500 / 50,000 PV</p>
        </div>
      </div>
    </div>
  )
}
