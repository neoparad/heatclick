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

    // 既存ユーザーのチェック
    // ClickHouse接続可能な場合は、ClickHouseを優先してチェック
    // メモリ内ストレージはフォールバックとして使用
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
      // ClickHouse接続不可時はメモリ内ストレージをチェック
      console.warn('ClickHouse not connected, checking memory storage only:', error?.message || error)
      const existingUser = users.find(u => u.email === email)
      if (existingUser) {
        return NextResponse.json(
          { error: 'User with this email already exists' },
          { status: 409 }
        )
      }
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

    // ClickHouseに保存（接続されている場合）
    // ClickHouse接続可能な場合は、ClickHouseを優先して保存
    // メモリ内ストレージはフォールバックとして使用
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
      // ClickHouseに保存成功した場合、メモリ内ストレージにも保存（キャッシュとして）
      users.push(newUser)
    } catch (error: any) {
      // ClickHouse接続不可時はメモリ内ストレージのみに保存
      console.warn('ClickHouse not connected, user saved in memory only:', error?.message || error)
      console.warn('WARNING: Data will be lost on server restart. Please configure ClickHouse connection.')
      users.push(newUser)
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





