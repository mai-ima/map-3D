import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import { attributionStrings } from '@ijm/shared';
import { fetchElevatedStructures } from '@ijm/gis';

/**
 * 高架・橋梁の立体構造物を返す。
 *
 * PLATEAU の橋梁モデルは整備自治体が限られており（浜松市には無い）、
 * OpenStreetMap の bridge / layer タグから組み立てる。
 * 取得できなくても地図とナビは成立するので、失敗時は空配列を返す。
 */

export const runtime = 'nodejs';
export const maxDuration = 45;

function parseBBox(value: string | null): BBox | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng >= maxLng || minLat >= maxLat) return null;
  // 広すぎる範囲は Overpass に負担をかけるので拒否する（約 6km 四方まで）
  if (maxLng - minLng > 0.07 || maxLat - minLat > 0.06) return null;
  return [minLng, minLat, maxLng, maxLat];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bbox = parseBBox(url.searchParams.get('bbox'));
  if (!bbox) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です（約 6km 四方まで）' },
      { status: 400 },
    );
  }

  const structures = await fetchElevatedStructures(bbox);

  return NextResponse.json(
    {
      structures,
      degraded: structures.length === 0,
      attribution: attributionStrings(['osm']),
    },
    { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=86400' } },
  );
}
