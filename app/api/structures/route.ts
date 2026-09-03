import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import { attributionStrings, parseBBoxParam } from '@ijm/shared';
import { fetchElevatedStructures } from '@ijm/gis';

/**
 * 高架・橋梁の立体構造物を返す。
 *
 * PLATEAU の橋梁モデルは整備自治体が限られており（浜松市には無い）、
 * OpenStreetMap の bridge / layer タグから組み立てる。
 * 取得できなくても地図とナビは成立するので、失敗時は空配列を返す。
 */

export const runtime = 'nodejs';
/**
 * 取得側（@ijm/gis）が合計 22 秒で諦めるので、その倍を上限にしておく。
 *
 * 以前はここが 45 秒で、取得側に合計の締め切りが無かった。
 * Overpass の 3 か所が順に時間切れになり、そのあと OSM 本体に切り替えて
 * 実測 80 秒。応答が返る前に打ち切られ、利用者にはエラーとして見えていた。
 */
export const maxDuration = 45;

/** 広すぎる範囲は Overpass に負担をかけるので拒否する（約 6km 四方まで） */
const LIMITS = { maxSpanLng: 0.07, maxSpanLat: 0.06 };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bbox = parseBBoxParam(url.searchParams.get('bbox'), LIMITS);
  if (!bbox) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です（約 6km 四方まで）' },
      { status: 400 },
    );
  }

  const { structures, degraded } = await fetchElevatedStructures(bbox);

  return NextResponse.json(
    {
      structures,
      // 「この範囲に無い」と「取り寄せられなかった」を混同しない
      degraded,
      attribution: attributionStrings(['osm']),
    },
    { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=86400' } },
  );
}
