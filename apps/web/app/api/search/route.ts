import { NextResponse } from 'next/server';
import { attributionStrings } from '@ijm/shared';
import { geocode } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim();
  if (!query) {
    return NextResponse.json({ error: '検索語 (q) を指定してください' }, { status: 400 });
  }

  const nearParam = url.searchParams.get('near');
  const near = nearParam
    ? (() => {
        const [lat, lng] = nearParam.split(',').map(Number);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
      })()
    : undefined;

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 8), 20);

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
