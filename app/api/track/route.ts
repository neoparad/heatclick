import { NextRequest, NextResponse } from 'next/server'

// メモリ内データストレージ（実際のプロダクションではデータベースを使用）
let trackingData: any[] = []

function buildCorsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  const headers = buildCorsHeaders(request)
  return new NextResponse(null, { headers })
}

export async function POST(request: NextRequest) {
  try {
    const data = await request.json()
    
    // データの検証
    if (!data.siteId || !data.eventType) {
      return NextResponse.json({ error: 'Invalid data' }, { status: 400, headers: buildCorsHeaders(request) })
    }

    // データを保存
    trackingData.push({
      ...data,
      id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      receivedAt: new Date().toISOString()
    })

    // デバッグ用ログ
    console.log('ClickInsight Pro - Received tracking data:', {
      siteId: data.siteId,
      eventType: data.eventType,
      timestamp: data.timestamp,
      url: data.url
    })

    return NextResponse.json({ success: true }, { headers: buildCorsHeaders(request) })
  } catch (error) {
    console.error('ClickInsight Pro - API Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: buildCorsHeaders(request) })
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get('siteId')
  const eventType = searchParams.get('eventType')
  const limit = parseInt(searchParams.get('limit') || '100')

  let filteredData = trackingData

  if (siteId) {
    filteredData = filteredData.filter(item => item.siteId === siteId)
  }

  if (eventType) {
    filteredData = filteredData.filter(item => item.eventType === eventType)
  }

  // 最新のデータを返す
  filteredData = filteredData
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)

  return NextResponse.json({
    data: filteredData,
    total: trackingData.length,
    filtered: filteredData.length
  }, { headers: buildCorsHeaders(request) })
}



