/**
 * 到着地点の案内。
 *
 * カーナビで最後に困るのは「着いたけれど、どこから入るのか」。
 * 大きな駅や商業施設では、目的地の座標に着いても建物の裏側だったり、
 * 駐車場の入口が反対側だったりする。
 *
 * OSM に入っている実在のデータだけを使う。
 *
 *   entrance=main / yes / shop … 建物の出入口（node）
 *   amenity=parking            … 駐車場（node または way）
 *
 * **無いものは出さない。** 建物の形から入口を推定したりはしない。
 * 実測（2026-09、OSM 本体 API、1km 四方）:
 *
 *   東京駅  入口 117 件（main 17 / yes 99 / shop 1）・駐車場 49 件
 *           名前つきの入口 30 件（「八重洲中央南口」「丸の内北口」「京橋口」など）
 *   浜松駅  入口 7 件（main 1 / yes 6）・駐車場 705 件
 *           名前つきの入口 0 件
 *
 * 地域によって整備の傾向が違う。東京は入口、浜松は駐車場が充実している。
 * どちらも「あるものを出す」だけで役に立つ。
 *
 * 描画エンジンに依存しない。Swift へもそのまま持っていける。
 */

import type { LatLng } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';

/** 到着案内に出す地点 */
export interface ArrivalPoint {
  id: string;
  /** OSM に名前があればそれ。無ければ種別から決まる呼び名 */
  name: string;
  position: LatLng;
  /** 目的地からの距離 (m) */
  distanceM: number;
}

export interface ArrivalGuide {
  /** 建物の出入口。正面（`entrance=main`）を先に並べる */
  entrances: ArrivalPoint[];
  /** 駐車場 */
  parking: ArrivalPoint[];
}

/**
 * 目的地の周りをどこまで見るか (m)。
 *
 * 大きな駅は端から端まで数百メートルあるが、そこまで広げると
 * 別の建物の入口まで混ざる。東京駅の丸の内側と八重洲側で約 250m なので、
 * その半分より少し広い 150m を取る。
 */
export const ARRIVAL_RADIUS_M = 150;

/** 一覧に出す上限。多すぎると選べない */
const MAX_ENTRANCES = 5;
const MAX_PARKING = 3;

/** OSM の要素（必要なところだけ） */
export interface ArrivalElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  /** way のときは中心点が入る */
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

/** 要素の代表点。way なら中心 */
function positionOf(element: ArrivalElement): LatLng | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: lat as number, lng: lng as number };
}

/**
 * 入口の呼び名。
 *
 * OSM に名前があればそれを使う（「八重洲中央南口」など実在の呼び名）。
 * 無ければ種別から決める。**位置から「北口」などと推測しない** —
 * 建物の向きは分からないし、実際の呼び名と食い違う。
 */
function entranceName(tags: Record<string, string>): string {
  const named = tags.name ?? tags.ref;
  if (named) return named;
  return tags.entrance === 'main' ? '正面入口' : '入口';
}

/** 駐車場の呼び名 */
function parkingName(tags: Record<string, string>): string {
  if (tags.name) return tags.name;
  // 屋根の有無は OSM に入っていることがある。実データなので使ってよい
  if (tags.parking === 'multi-storey') return '立体駐車場';
  if (tags.parking === 'underground') return '地下駐車場';
  return '駐車場';
}

/**
 * 目的地の周りの入口と駐車場を、近い順に選ぶ。
 *
 * 入口は `entrance=main`（正面）を先に出す。
 * 同じ種別なら近い順。正面が遠くにあっても先に見せるのは、
 * 大きな施設では「正面へ回る」ほうが結局は早いことが多いため。
 */
export function buildArrivalGuide(
  elements: ArrivalElement[],
  destination: LatLng,
  radiusM = ARRIVAL_RADIUS_M,
): ArrivalGuide {
  const entrances: (ArrivalPoint & { main: boolean })[] = [];
  const parking: ArrivalPoint[] = [];

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const position = positionOf(element);
    if (!position) continue;
    const distanceM = distanceMeters(destination, position);
    if (!(distanceM <= radiusM)) continue;

    const id = `${element.type ?? 'node'}/${element.id ?? `${position.lat},${position.lng}`}`;

    if (tags.entrance) {
      // 非常口と業務用は案内しない。使えないところへ誘導することになる
      if (tags.entrance === 'emergency' || tags.entrance === 'service') continue;
      entrances.push({
        id,
        name: entranceName(tags),
        position,
        distanceM: Math.round(distanceM),
        main: tags.entrance === 'main',
      });
      continue;
    }

    if (tags.amenity === 'parking') {
      // 私有・利用者専用は案内しない
      if (tags.access === 'private' || tags.access === 'no') continue;
      parking.push({ id, name: parkingName(tags), position, distanceM: Math.round(distanceM) });
    }
  }

  entrances.sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return a.distanceM - b.distanceM;
  });
  parking.sort((a, b) => a.distanceM - b.distanceM);

  return {
    entrances: entrances.slice(0, MAX_ENTRANCES).map(({ main: _main, ...rest }) => rest),
    parking: parking.slice(0, MAX_PARKING),
  };
}

/** 案内するものが 1 つでもあるか */
export function hasArrivalGuide(guide: ArrivalGuide | null | undefined): boolean {
  return Boolean(guide && (guide.entrances.length > 0 || guide.parking.length > 0));
}
