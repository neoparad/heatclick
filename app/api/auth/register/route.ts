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
    } catch (error: any) {
      // ClickHouseが接続されていない場合はメモリ内のみでチェック
      console.warn('ClickHouse not connected, using memory storage only:', error?.message || error)
      // 警告: メモリ内ストレージはサーバー再起動でデータが失われます
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
    let savedToClickHouse = false
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
      savedToClickHouse = true
      console.log('User saved to ClickHouse successfully')
    } catch (error: any) {
      console.warn('ClickHouse not connected, user saved in memory only:', error?.message || error)
      console.warn('WARNING: Data will be lost on server restart. Please configure ClickHouse connection.')
    }

    return NextResponse.json({
      success: true,
      user: {
        id: userId,
        email,
        name,
        created_at: createdAt,
      },
      warning: savedToClickHouse ? undefined : 'User saved in memory only. Data will be lost on server restart. Please configure ClickHouse connection.',
    }, { status: 201 })
  } catch (error) {
    console.error('Error registering user:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}





