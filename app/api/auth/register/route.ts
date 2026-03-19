import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getClickHouseClientAsync } from '@/lib/clickhouse'
import { signToken } from '@/lib/jwt'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, name } = body

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      )
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const clickhouse = await getClickHouseClientAsync()

    // 既存ユーザーチェック
    const result = await clickhouse.query({
      query: `SELECT id FROM clickinsight.users WHERE email = {email:String}`,
      query_params: { email },
      format: 'JSONEachRow',
    })
    const existing = await result.json() as any[]
    if (existing.length > 0) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 409 }
      )
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    await clickhouse.insert({
      table: 'clickinsight.users',
      values: [{
        id: userId,
        email,
        password: hashedPassword,
        name,
        created_at: now,
        updated_at: now,
        plan: 'free',
        status: 'active',
      }],
      format: 'JSONEachRow',
    })

    // JWTトークン生成
    const token = await signToken({
      sub: userId,
      email,
      name,
      plan: 'free',
    })

    const response = NextResponse.json({
      success: true,
      user: { id: userId, email, name, plan: 'free' },
      token,
    }, { status: 201 })

    response.cookies.set('ugokimap_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24,
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Error registering user:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
