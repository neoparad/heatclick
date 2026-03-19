import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/lib/clickhouse'

export async function POST(request: NextRequest) {
  try {
    // 認証チェック: INIT_SECRET環境変数または開発環境のみ許可
    const authHeader = request.headers.get('authorization')
    const initSecret = process.env.INIT_SECRET
    const isDev = process.env.NODE_ENV === 'development'

    if (!isDev) {
      if (!initSecret || authHeader !== `Bearer ${initSecret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    await initializeDatabase()

    return NextResponse.json({
      success: true,
      message: 'Database tables initialized successfully'
    })
  } catch (error: any) {
    console.error('Database initialization error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to initialize database' },
      { status: 500 }
    )
  }
}
