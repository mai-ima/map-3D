import { NextResponse } from 'next/server';
import { attributionStrings, bboxAround, parseLatLngParam } from '@ijm/shared';
import {
  ARRIVAL_RADIUS_M,
  OverpassUnavailableError,
  buildArrivalGuide,
  fetchArrivalPoints,
} from '@ijm/gis';

/**
 * 到着地点の案内（建物の出入口と駐車場）。
 *
 * カーナビで最後に困るのは「着いたけれど、どこから入るのか」。
 * 大きな駅や商業施設では、目的地の座標に着いても建物の裏側だったり、
 * 駐車場の入口が反対側だったりする。
 *
 * 出典は OSM の `entrance=*` と `amenity=parking`。**無いものは出さない。**
 * 建物の形から入口を推定したりはしない。
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const destination = parseLatLngParam(url.searchParams.get('lat'), url.searchParams.get('lng'));
  if (!destination) {
    return NextResponse.json(
      { error: 'lat と lng が必要です（緯度 ±90・経度 ±180 の範囲）' },
      { status: 400 },
    );
  }

  try {
    // 半径ぶんの正方形で取ってから、円で絞る（Overpass の bbox は矩形のため）
    const elements = await fetchArrivalPoints(bboxAround(destination, ARRIVAL_RADIUS_M));
    const guide = buildArrivalGuide(elements, destination);
    return NextResponse.json(
      { ...guide, attribution: attributionStrings(['overpass', 'osm']) },
      { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } },
    );
  } catch (error) {
    // 到着案内が取れなくても、案内そのものは成立する。
    // 空で返して「出せなかった」ことだけ伝える
    if (error instanceof OverpassUnavailableError) {
      return NextResponse.json(
        { entrances: [], parking: [], degraded: true },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { entrances: [], parking: [], degraded: true },
      { status: 200 },
    );
  }
}
