import { NextResponse } from 'next/server';
import { attributionStrings, clampNumberParam, parseLatLngParam } from '@ijm/shared';
import { geocode } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * 検索語の長さの上限。
 * 地名としてこれより長いものは無く、そのまま外部へ投げる理由もない。
 */
const MAX_QUERY_LENGTH = 200;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) {
    return NextResponse.json({ error: '検索語 (q) を指定してください' }, { status: 400 });
  }

  // near は「この辺りを優先して探す」ための任意指定。
  // 地球上に無い値なら、指定が無かったものとして扱う
  const nearParam = url.searchParams.get('near')?.split(',') ?? [];
  const near = parseLatLngParam(nearParam[0] ?? null, nearParam[1] ?? null) ?? undefined;

  // Math.min(Number('abc'), 20) は NaN になる。件数が NaN のまま渡っていた
  const limit = clampNumberParam(url.searchParams.get('limit'), 8, 1, 20);

  try {
    const results = await geocode(query, { near, limit });
    return NextResponse.json(
      { results, attribution: attributionStrings(['nominatim', 'osm']) },
      { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? '検索に失敗しました' },
      { status: 502 },
    );
  }
}
