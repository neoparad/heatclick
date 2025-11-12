'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { 
  Search, 
  Filter, 
  Download,
  Menu,
  User,
  LogOut
} from 'lucide-react'
import { getCurrentUser, logout } from '@/lib/auth'
import { Button } from '../ui/button'

export default function Header() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    const currentUser = getCurrentUser()
    setUser(currentUser)
  }, [])

  const handleLogout = () => {
    logout()
    router.push('/')
  }

  return (
    <header className="bg-white border-b border-gray-200 px-4 lg:px-8 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 lg:gap-4">
          <button className="lg:hidden p-2 hover:bg-gray-100 rounded-lg">
            <Menu className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        <div className="flex items-center gap-2 lg:gap-3">
          <button className="p-2 hover:bg-gray-100 rounded-lg hidden sm:block">
            <Search className="w-5 h-5 text-gray-600" />
          </button>
          <button className="p-2 hover:bg-gray-100 rounded-lg hidden sm:block">
            <Filter className="w-5 h-5 text-gray-600" />
          </button>
          <button className="flex items-center gap-2 px-2 lg:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">レポート出力</span>
          </button>
          
          {/* ユーザー情報 */}
          {user && (
            <div className="flex items-center gap-2 ml-2 pl-2 border-l border-gray-300">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50">
                <User className="w-4 h-4 text-gray-600" />
                <span className="hidden lg:inline text-sm text-gray-700">{user.name || user.email}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-gray-600 hover:text-gray-900"
                title="ログアウト"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}





