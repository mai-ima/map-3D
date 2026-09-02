import { NextResponse } from 'next/server';
import type { LatLng, TravelMode } from '@ijm/shared';
import { RoutingError, routeWithFallback } from '@ijm/routing';

export const runtime = 'nodejs';
export const maxDuration = 30;

const VALID_MODES: TravelMode[] = ['walk', 'drive', 'bicycle', 'transit', 'multimodal'];

function parsePoint(value: string | null): LatLng | null {
  if (!value) return null;
  const [lat, lng] = value.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * 返ってきた経路が案内に使える形かを確かめる。
 *
 * 経路エンジンの応答が壊れていると、座標が 1 点しかなかったり、
 * 地球上に無い値が混ざったりする（polyline のデコードは壊れた文字列でも
 * 例外を出さず、緯度 -33.5 のような値を返す）。
 * そのまま案内を始めると、進捗も方位も計算できないまま画面が固まる。
 */
function isUsableRoute(route: { coordinates?: [number, number][] }): boolean {
  const coords = route.coordinates ?? [];
  // 2 点なければ線にならない
  if (coords.length < 2) return false;
  return coords.every(
    ([lng, lat]) =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180,
  );
}

async function handle(from: LatLng, to: LatLng, mode: TravelMode) {
  try {
    const route = await routeWithFallback({ from, to, mode, language: 'ja-JP' });
    if (!isUsableRoute(route)) {
      return NextResponse.json(
        { error: '経路の形状が壊れています。もう一度お試しください。' },
        { status: 502 },
      );
    }
    return NextResponse.json(route, {
      headers: { 'Cache-Control': 'private, max-age=30' },
    });
  } catch (error) {
    const status = error instanceof RoutingError ? error.status : 502;
    return NextResponse.json(
      { error: (error as Error).message ?? '経路を計算できませんでした' },
      { status },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = parsePoint(url.searchParams.get('from'));
  const to = parsePoint(url.searchParams.get('to'));
  const mode = (url.searchParams.get('mode') ?? 'walk') as TravelMode;

  if (!from || !to) {
    return NextResponse.json(
      { error: 'from と to を "緯度,経度" 形式で指定してください' },
      { status: 400 },
    );
  }
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json({ error: `未対応の移動手段です: ${mode}` }, { status: 400 });
  }

  return handle(from, to, mode);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    from?: LatLng;
    to?: LatLng;
    mode?: TravelMode;
  };

  if (
    !body.from ||
    !body.to ||
    !Number.isFinite(body.from.lat) ||
    !Number.isFinite(body.to.lat)
  ) {
    return NextResponse.json({ error: 'from と to が必要です' }, { status: 400 });
  }

  const mode = body.mode ?? 'walk';
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json({ error: `未対応の移動手段です: ${mode}` }, { status: 400 });
  }

  return handle(body.from, body.to, mode);
}
