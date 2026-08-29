import { NextResponse } from 'next/server';
import {
  AIProviderNotConfiguredError,
  createAIProvider,
  isAIConfigured,
  runMapAgent,
  type ChatMessage,
  type MapContext,
} from '@ijm/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * AI 地図エージェント。
 * API キーはサーバ側の環境変数にのみ存在し、クライアントには一切渡らない。
 */
export async function POST(request: Request) {
  if (!isAIConfigured()) {
    return NextResponse.json(
      {
        error:
          'AI 機能が未設定です。環境変数 AI_PROVIDER と対応する API キーを設定してください。',
        configured: false,
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    messages?: ChatMessage[];
    mapContext?: MapContext;
  };

  const messages = (body.messages ?? []).filter(
    (m) => typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'),
  );
  if (messages.length === 0) {
    return NextResponse.json({ error: 'messages が空です' }, { status: 400 });
  }

  // 会話が長くなりすぎないよう直近のみ使う（コストと遅延の制御）
  const trimmed = messages.slice(-12);

  try {
    const provider = createAIProvider();
    const result = await runMapAgent({
      provider,
      messages: trimmed,
      mapContext: body.mapContext ?? {},
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AIProviderNotConfiguredError) {
      return NextResponse.json({ error: error.message, configured: false }, { status: 503 });
    }
    return NextResponse.json(
      { error: (error as Error).message ?? 'AI の処理に失敗しました' },
      { status: 502 },
    );
  }
}
