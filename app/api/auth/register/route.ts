import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

// 簡易的なメモリ内ユーザーストレージ（テスト用、後でClickHouseに移行）
// 注意: サーバー再起動でデータは消失します
let users: Array<{
  id: string
  email: string
  password: string
  name: string
  created_at: string
}> = []

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, name } = body

    // バリデーション
    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      )
    }

    // メールアドレスの形式チェック
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      )
    }

    // パスワードの長さチェック
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // 既存ユーザーのチェック（メモリ内）
    const existingUser = users.find(u => u.email === email)
    if (existingUser) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 409 }
      )
    }

    // ClickHouseからもチェック（接続されている場合）
    try {
      const clickhouse = await getClickHouseClientAsync()
      const result = await clickhouse.query({
        query: `SELECT id FROM clickinsight.users WHERE email = {email:String}`,
        query_params: { email },
        format: 'JSONEachRow',
      })
      const existing = await result.json()
      if (existing.length > 0) {
        return NextResponse.json(
          { error: 'User with this email already exists' },
          { status: 409 }
        )
      }
    } catch (error) {
      // ClickHouseが接続されていない場合はメモリ内のみでチェック
      console.log('ClickHouse not connected, using memory storage')
    }

    // パスワードのハッシュ化
    const hashedPassword = await bcrypt.hash(password, 10)

    // ユーザーIDの生成
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const createdAt = new Date().toISOString()

    const newUser = {
      id: userId,
      email,
      password: hashedPassword,
      name,
      created_at: createdAt,
    }

    // メモリ内に保存
    users.push(newUser)

    // ClickHouseに保存（接続されている場合）
    try {
      const clickhouse = await getClickHouseClientAsync()
      await clickhouse.insert({
        table: 'clickinsight.users',
        values: [{
          id: userId,
          email,
          password: hashedPassword,
          name,
          created_at: createdAt.replace('T', ' ').substring(0, 19),
          updated_at: createdAt.replace('T', ' ').substring(0, 19),
          plan: 'free',
          status: 'active',
        }],
        format: 'JSONEachRow',
      })
    } catch (error) {
      console.log('ClickHouse not connected, user saved in memory only')
    }

    return NextResponse.json({
      success: true,
      user: {
        id: userId,
        email,
        name,
        created_at: createdAt,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Error registering user:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}




