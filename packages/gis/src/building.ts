/**
 * 建物情報の組み立て。
 *
 * 実在建物の属性は OSM（および PLATEAU の 3D Tiles feature 属性）を使う。
 * AI に「それらしい情報」を生成させることはしない。
 */

import type { BuildingInfo, LatLng } from '@ijm/shared';
import { fetchBuildingAt } from './overpass';
import { reverseGeocode } from './nominatim';

const BUILDING_TYPE_LABELS: Record<string, string> = {
  yes: '建物',
  residential: '住宅',
  apartments: '集合住宅',
  commercial: '商業ビル',
  office: 'オフィスビル',
  retail: '店舗',
  industrial: '工場・倉庫',
  train_station: '駅舎',
  hotel: 'ホテル',
  school: '学校',
  hospital: '病院',
  public: '公共施設',
  church: '教会',
  temple: '寺院',
  shrine: '神社',
};

/** 3D Tiles の feature 属性から取り出した値（クライアントから渡される） */
export interface PlateauFeatureAttributes {
  gmlId?: string;
  measuredHeight?: number;
  usage?: string;
  name?: string;
  storeysAboveGround?: number;
}

export async function getBuildingInfo(
  point: LatLng,
  plateauAttributes?: PlateauFeatureAttributes,
): Promise<BuildingInfo> {
  const sources: string[] = [];
  let osmTags: Record<string, string> | undefined;
  let center = point;

  try {
    const el = await fetchBuildingAt(point);
    if (el?.tags) {
      osmTags = el.tags;
      sources.push('osm');
      if (el.center) center = { lat: el.center.lat, lng: el.center.lon };
    }
  } catch {
    // Overpass が使えなくても、PLATEAU 属性と逆ジオコーディングで返せる
  }

  let address: string | undefined;
  if (!osmTags?.['addr:full']) {
    try {
      const rev = await reverseGeocode(point.lat, point.lng);
      if (rev) {
        address = rev.address;
        sources.push('nominatim');
      }
    } catch {
      /* 住所が取れなくても致命的ではない */
    }
  }

  if (plateauAttributes) sources.push('plateau');

  const heightFromOsm = osmTags?.height ? Number.parseFloat(osmTags.height) : undefined;
  const levels = osmTags?.['building:levels']
    ? Number.parseInt(osmTags['building:levels'], 10)
    : plateauAttributes?.storeysAboveGround;

  const buildingTag = osmTags?.building;
  const type =
    plateauAttributes?.usage ??
    (buildingTag ? (BUILDING_TYPE_LABELS[buildingTag] ?? buildingTag) : undefined);

  return {
    id: plateauAttributes?.gmlId ?? `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`,
    name: osmTags?.name ?? osmTags?.['name:ja'] ?? plateauAttributes?.name,
    lat: center.lat,
    lng: center.lng,
    height: plateauAttributes?.measuredHeight ?? heightFromOsm,
    levels: Number.isFinite(levels) ? levels : undefined,
    buildingType: type,
    address: osmTags?.['addr:full'] ?? address,
    tags: osmTags,
    sources: sources.length > 0 ? sources : ['plateau'],
  };
}
