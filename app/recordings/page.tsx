'use client'

import DashboardLayout from '../../components/layout/DashboardLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Clock, Video } from 'lucide-react'

export default function RecordingsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="text-center py-20">
          <div className="flex justify-center mb-6">
            <div className="w-24 h-24 rounded-full bg-blue-100 flex items-center justify-center">
              <Video className="w-12 h-12 text-blue-600" />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Coming Soon</h1>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            セッション録画機能は現在開発中です。
            <br />
            まもなくご利用いただけるようになります。
          </p>
          <div className="flex items-center justify-center gap-2 text-gray-500">
            <Clock className="w-5 h-5" />
            <span>近日公開予定</span>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

