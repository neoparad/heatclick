import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/lib/clickhouse'

export async function POST(request: NextRequest) {
  try {
    console.log('Initializing database tables...')
    await initializeDatabase()
    console.log('Database initialized successfully')

    return NextResponse.json({
      success: true,
      message: 'Database tables initialized successfully'
    })
  } catch (error: any) {
    console.error('Database initialization error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to initialize database',
        details: error?.message || String(error)
      },
      { status: 500 }
    )
  }
}
