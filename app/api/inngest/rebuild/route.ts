import { NextRequest, NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';

// 過去データの初期集約を手動で実行するエンドポイント
export async function POST(request: NextRequest) {
  try {
    await inngest.send({
      name: 'heatmap.rebuild',
    });

    return NextResponse.json({
      success: true,
      message: 'Heatmap rebuild job triggered',
    });
  } catch (error) {
    console.error('Error triggering rebuild:', error);
    return NextResponse.json(
      { error: 'Failed to trigger rebuild job' },
      { status: 500 }
    );
  }
}


