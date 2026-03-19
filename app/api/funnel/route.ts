import { NextRequest, NextResponse } from 'next/server'
import { getSessionFunnel, getSessions } from '@/lib/session-aggregator'
import { getAuthContext, unauthorized, badRequest } from '@/lib/api-utils'

// セッションごとのファネル分析
export async function GET(request: NextRequest) {
  const auth = getAuthContext(request)
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get('siteId')
    const sessionId = searchParams.get('sessionId')
    
    if (!siteId) {
      return badRequest('siteId is required')
    }
    
    // 特定のセッションのファネルを取得
    if (sessionId) {
      const funnel = await getSessionFunnel(siteId, sessionId)
      return NextResponse.json({ funnel })
    }
    
    // 全セッションのファネル統計を取得
    const sessions = await getSessions(siteId, undefined, undefined, 100)
    
    // ページ遷移パターンの集計
    const pageTransitions: Record<string, Record<string, number>> = {}
    const pageViews: Record<string, number> = {}
    const exitPages: Record<string, number> = {}
    
    for (const session of sessions) {
      // ランディングページ
      if (session.landing_page) {
        pageViews[session.landing_page] = (pageViews[session.landing_page] || 0) + 1
      }
      
      // 離脱ページ
      if (session.exit_page) {
        exitPages[session.exit_page] = (exitPages[session.exit_page] || 0) + 1
      }
      
      // セッションのファネルを取得して遷移パターンを集計
      try {
        const funnel = await getSessionFunnel(siteId, session.session_id)
        for (let i = 0; i < funnel.length - 1; i++) {
          const from = funnel[i].url
          const to = funnel[i + 1].url
          if (!pageTransitions[from]) {
            pageTransitions[from] = {}
          }
          pageTransitions[from][to] = (pageTransitions[from][to] || 0) + 1
        }
      } catch (error) {
        console.error('Error fetching session funnel:', error)
      }
    }
    
    return NextResponse.json({
      sessions: sessions.length,
      pageViews,
      exitPages,
      transitions: pageTransitions,
    })
  } catch (error) {
    console.error('Error fetching funnel data:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}












