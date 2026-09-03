import { NextResponse } from 'next/server';
import {
  AIProviderNotConfiguredError,
  createAIProvider,
  isAIConfigured,
  runMapAgent,
  type ChatMessage,
  type MapContext,
} from '@ijm/ai';
import { readLatLng, type TravelMode } from '@ijm/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TRAVEL_MODES: TravelMode[] = ['walk', 'drive', 'bicycle', 'transit', 'multimodal'];

/**
 * クライアントから届く地図の状態を検証する。
 *
 * この座標はツールの基準点になり、そのまま Nominatim や Overpass への
 * 問い合わせに入る。NaN や配列が混じっていると、NaN を含む URL を
 * 組み立てて外部サービスに投げてしまう。
 * 読めない項目は「無い」ものとして落とす。
 */
function readMapContext(value: unknown): MapContext {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const context: MapContext = {};

  const viewCenter = readLatLng(raw.viewCenter);
  if (viewCenter) context.viewCenter = viewCenter;

  const camera = raw.camera as Record<string, unknown> | undefined;
  const center = readLatLng(camera?.center);
  if (center) {
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    context.camera = {
      center,
      height: num(camera?.height, 500),
      heading: num(camera?.heading, 0),
      pitch: num(camera?.pitch, -40),
    };
  }

  // 都市名はシステムプロンプトにそのまま入る。改行を許すと
  // 「# 絶対に守るルール」のような見出しを偽装して差し込める
  if (typeof raw.cityName === 'string') {
    context.cityName = raw.cityName.replace(/[\r\n]+/g, ' ').slice(0, 100);
  }
  if (typeof raw.timeOfDay === 'number' && Number.isFinite(raw.timeOfDay)) {
    context.timeOfDay = raw.timeOfDay;
  }

  // 表示中のルートは「案内して」の判断材料になる。数値が壊れていると
  // プロンプトに NaN と書かれてしまうので、揃っているときだけ載せる
  const route = raw.activeRoute as Record<string, unknown> | undefined;
  if (
    route &&
    typeof route.id === 'string' &&
    typeof route.distance === 'number' &&
    Number.isFinite(route.distance) &&
    typeof route.duration === 'number' &&
    Number.isFinite(route.duration)
  ) {
    const mode = TRAVEL_MODES.find((m) => m === route.mode) ?? 'walk';
    context.activeRoute = {
      id: route.id.slice(0, 100),
      mode,
      distance: route.distance,
      duration: route.duration,
    };
  }
  return context;
}

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
      mapContext: readMapContext(body.mapContext),
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
