'use client'

import Sidebar from './Sidebar'
import Header from './Header'
import Footer from './Footer'

interface DashboardLayoutProps {
  children: React.ReactNode
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header />
        <main className="flex-1 overflow-y-auto p-4 lg:p-8 min-h-0">
          {children}
        </main>
        <div className="mt-auto">
          <Footer />
        </div>
      </div>
    </div>
  )
}





