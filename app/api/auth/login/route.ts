import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { signToken } from '@/lib/jwt'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password } = body

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    let user: any = null

    try {
      const clickhouse = await getClickHouseClientAsync()
      const result = await clickhouse.query({
        query: `SELECT id, email, password, name, plan, status FROM clickinsight.users WHERE email = {email:String}`,
        query_params: { email },
        format: 'JSONEachRow',
      })
      const usersFromDb = await result.json() as any[]
      if (usersFromDb.length > 0) {
        user = usersFromDb[0]
      }
    } catch (error: any) {
      console.warn('ClickHouse not connected:', error?.message)
      return NextResponse.json(
        { error: 'Service temporarily unavailable' },
        { status: 503 }
      )
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // JWTトークン生成
    const token = await signToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan || 'free',
    })

    const { password: _, ...userWithoutPassword } = user

    // レスポンスにトークンをCookieとBodyの両方で返す
    const response = NextResponse.json({
      success: true,
      user: userWithoutPassword,
      token,
    })

    // HttpOnly Cookie設定（XSS対策）
    response.cookies.set('ugokimap_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24, // 24時間
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Error logging in:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
