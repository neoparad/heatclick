import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getClickHouseClientAsync } from '@/lib/clickhouse'

// 簡易的なメモリ内ユーザーストレージ（テスト用）
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
    const { email, password } = body

    // バリデーション
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    let user: any = null

    // メモリ内から検索
    user = users.find(u => u.email === email)

    // ClickHouseから検索（接続されている場合）
    if (!user) {
      try {
        const clickhouse = await getClickHouseClientAsync()
        const result = await clickhouse.query({
          query: `SELECT id, email, password, name, created_at, plan, status FROM clickinsight.users WHERE email = {email:String}`,
          query_params: { email },
          format: 'JSONEachRow',
        })
        const usersFromDb = await result.json()
        if (usersFromDb.length > 0) {
          user = usersFromDb[0]
        }
      } catch (error) {
        console.log('ClickHouse not connected, checking memory storage only')
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // パスワードの検証
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // ユーザー情報を返す（パスワードは除外）
    const { password: _, ...userWithoutPassword } = user

    return NextResponse.json({
      success: true,
      user: userWithoutPassword,
    })
  } catch (error) {
    console.error('Error logging in:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}




