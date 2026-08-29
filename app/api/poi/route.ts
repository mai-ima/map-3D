import { NextResponse } from 'next/server';
import { attributionStrings } from '@ijm/shared';
import { OverpassUnavailableError, searchNearbyPois } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 45;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat と lng が必要です' }, { status: 400 });
  }

  const radius = Math.min(Number(url.searchParams.get('radius') ?? 500), 3000);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 50);
  const categories = (url.searchParams.get('categories') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const pois = await searchNearbyPois({ center: { lat, lng }, radius, categories, limit });
    return NextResponse.json(
      { pois, attribution: attributionStrings(['overpass', 'osm']) },
      { headers: { 'Cache-Control': 'public, max-age=120, s-maxage=600' } },
    );
  } catch (error) {
    // Overpass が落ちていても地図とナビは動き続けるべきなので、
    // POI 機能だけを無効化したことが分かる形で返す。
    if (error instanceof OverpassUnavailableError) {
      return NextResponse.json(
        {
          pois: [],
          degraded: true,
          message: 'POI データ提供元 (Overpass API) に接続できませんでした',
        },
        { status: 200 },
      );
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
