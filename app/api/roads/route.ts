import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import { attributionStrings } from '@ijm/shared';
import { clipToBBox, fetchRoadScene, stitchRoads } from '@ijm/gis';

/**
 * 車道・車線・横断歩道・信号・線路を返す。
 *
 * PLATEAU には道路の 3D モデル（tran）が整備されている地域もあるが、
 * 区画線や信号までは入っておらず、未整備の地域も多い。
 * OpenStreetMap から取って組み立てる。
 *
 * 返すのは「解釈済みの道路の情報」であって、描く形そのものではない。
 * 形の組み立て（roadShapes など）は描画側で行う。
 * 地形の標高が要るものがあり、それは描画側にしか無いため。
 */

export const runtime = 'nodejs';
export const maxDuration = 45;

/**
 * 一度に返す上限。
 *
 * 浜松駅周辺 3km 四方で道路 2,011 本・線路 69 本。
 * 1.5km 四方ならおよそ 1/4 に収まるが、
 * 東京の都心部はこれより密なので上限で頭を押さえる。
 */
const MAX_ROADS = 2500;
const MAX_RAILS = 300;
const MAX_POINTS = 1200;

function parseBBox(value: string | null): BBox | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng >= maxLng || minLat >= maxLat) return null;
  // 道路は要素が多いので、構造物より狭い範囲に限る（約 3.5km 四方まで）
  if (maxLng - minLng > 0.04 || maxLat - minLat > 0.032) return null;
  return [minLng, minLat, maxLng, maxLat];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bbox = parseBBox(url.searchParams.get('bbox'));
  if (!bbox) {
    return NextResponse.json(
      { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です（約 3.5km 四方まで）' },
      { status: 400 },
    );
  }

  const scene = await fetchRoadScene(bbox);

  // Overpass は範囲に少しでもかかる way を丸ごと返すので、
  // 範囲の外まで伸びた道が混ざる。表示範囲に入るものだけに絞る
  const [minLng, minLat, maxLng, maxLat] = bbox;
  // OSM は道路を交差点ごとに別の way にする。そのままだと描画のまとまりが
  // その数だけ要るので、つなげられるものはつないでから返す。
  // 頂点は減らない（つなぎ目の重複が消えるだけ）ので、精度は落ちない
  const roads = stitchRoads(clipToBBox(scene.roads, bbox)).slice(0, MAX_ROADS);
  const rails = clipToBBox(scene.rails, bbox).slice(0, MAX_RAILS);
  const points = scene.points
    .filter(
      (p) =>
        p.position.lng >= minLng &&
        p.position.lng <= maxLng &&
        p.position.lat >= minLat &&
        p.position.lat <= maxLat,
    )
    .slice(0, MAX_POINTS);

  return NextResponse.json(
    {
      roads,
      rails,
      points,
      degraded: roads.length === 0 && rails.length === 0,
      attribution: attributionStrings(['osm']),
    },
    { headers: { 'Cache-Control': 'public, max-age=600, s-maxage=86400' } },
  );
}
