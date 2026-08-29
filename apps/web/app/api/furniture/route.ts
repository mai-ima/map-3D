import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import { attributionStrings } from '@ijm/shared';
import { OverpassUnavailableError, fetchStreetFurniture } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 45;

/**
 * 街路樹・街灯・ベンチの「実在位置」を OSM から取得する。
 * 位置を捏造しないための唯一の入口。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('bbox');
  if (!raw) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です' },
      { status: 400 },
    );
  }

  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: 'bbox の形式が不正です' }, { status: 400 });
  }
  const bbox = parts as BBox;

  // 広すぎる範囲は Overpass に負荷をかけるため拒否する
  const areaDeg = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  if (areaDeg > 0.02) {
    return NextResponse.json(
      { points: [], degraded: true, message: '範囲が広すぎます。ズームインしてください。' },
      { status: 200 },
    );
  }

  try {
    const elements = await fetchStreetFurniture(bbox);
    const points = elements
      .filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
      .map((e) => ({
        lat: e.lat!,
        lng: e.lon!,
        kind:
          e.tags?.natural === 'tree'
            ? ('tree' as const)
            : e.tags?.highway === 'street_lamp'
              ? ('street_lamp' as const)
              : ('bench' as const),
        height: e.tags?.height ? Number(e.tags.height) : undefined,
      }));

    return NextResponse.json(
      { points, attribution: attributionStrings(['overpass', 'osm']) },
      { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=3600' } },
    );
  } catch (error) {
    if (error instanceof OverpassUnavailableError) {
      return NextResponse.json({ points: [], degraded: true, message: error.message });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
