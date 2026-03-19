import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/jwt'

// 現在のログインユーザー情報を返す（トークン検証）
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request)

  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  return NextResponse.json({
    success: true,
    user: {
      id: user.sub,
      email: user.email,
      name: user.name,
      plan: user.plan,
    },
  })
}
