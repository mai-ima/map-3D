import { NextResponse } from 'next/server';
import { attributionStrings, clampNumberParam, parseLatLngParam } from '@ijm/shared';
import { OverpassUnavailableError, searchNearbyPois } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 45;

/**
 * 一度に指定できる分類の数。
 * Overpass のクエリは分類ごとに 1 行増えるので、際限なく受けない。
 */
const MAX_CATEGORIES = 12;

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Number(null) は 0 になる。素朴に書くと lat も lng も無い要求が
  // 「緯度 0・経度 0（大西洋）」として通ってしまう
  const center = parseLatLngParam(url.searchParams.get('lat'), url.searchParams.get('lng'));
  if (!center) {
    return NextResponse.json(
      { error: 'lat と lng が必要です（緯度 ±90・経度 ±180 の範囲）' },
      { status: 400 },
    );
  }

  const radius = clampNumberParam(url.searchParams.get('radius'), 500, 10, 3000);
  const limit = clampNumberParam(url.searchParams.get('limit'), 20, 1, 50);
  const categories = (url.searchParams.get('categories') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CATEGORIES);

  try {
    const pois = await searchNearbyPois({ center, radius, categories, limit });
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
