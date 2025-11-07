'use client'

import { useState } from 'react'
import { 
  ChevronDown, 
  Calendar, 
  Search, 
  Filter, 
  Download,
  Menu
} from 'lucide-react'

export default function Header() {
  const [selectedSite, setSelectedSite] = useState('example.com')
  const [selectedPeriod, setSelectedPeriod] = useState('過去7日間')

  return (
    <header className="bg-white border-b border-gray-200 px-4 lg:px-8 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 lg:gap-4">
          <button className="lg:hidden p-2 hover:bg-gray-100 rounded-lg">
            <Menu className="w-5 h-5 text-gray-600" />
          </button>
          
          <div className="relative">
            <button className="flex items-center gap-2 px-2 lg:px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              <span className="font-medium text-sm lg:text-base">{selectedSite}</span>
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          
          <div className="relative hidden sm:block">
            <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              <Calendar className="w-4 h-4" />
              <span className="hidden lg:inline">{selectedPeriod}</span>
              <span className="lg:hidden">7日</span>
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
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
        </div>
      </div>
    </header>
  )
}




