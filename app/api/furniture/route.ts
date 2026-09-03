import { NextResponse } from 'next/server';
import { attributionStrings, parseBBoxParam } from '@ijm/shared';
import { OverpassUnavailableError, fetchStreetFurniture } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 45;

/**
 * 街路樹・街灯・ベンチの「実在位置」を OSM から取得する。
 * 位置を捏造しないための唯一の入口。
 */
/**
 * 広すぎる範囲は Overpass に負荷をかけるので拒否する。
 * 面積で見ていたが、南北と東西が逆転した bbox では面積が負になり、
 * 判定をすり抜けていた。辺の長さで見る（約 15km 四方まで）
 */
const LIMITS = { maxSpanLng: 0.17, maxSpanLat: 0.14 };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bbox = parseBBoxParam(url.searchParams.get('bbox'), LIMITS);
  if (!bbox) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です（約 15km 四方まで）' },
      { status: 400 },
    );
  }

  try {
    const elements = await fetchStreetFurniture(bbox);
    // 樹種・樹高・樹冠幅は OSM に入っているときだけ使う。
    // 形を決めるのに要るタグだけを通し、その他は落とす（転送量を増やさない）
    const KEEP = [
      'height',
      'diameter_crown',
      'leaf_type',
      'leaf_cycle',
      'genus',
      'species',
      'species:en',
      'genus:en',
    ];
    const points = elements
      .filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
      .map((e) => {
        const tags: Record<string, string> = {};
        for (const key of KEEP) {
          const value = e.tags?.[key];
          if (typeof value === 'string') tags[key] = value;
        }
        return {
          lat: e.lat!,
          lng: e.lon!,
          kind:
            e.tags?.natural === 'tree'
              ? ('tree' as const)
              : e.tags?.highway === 'street_lamp'
                ? ('street_lamp' as const)
                : ('bench' as const),
          height: e.tags?.height ? Number(e.tags.height) : undefined,
          tags,
        };
      });

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
