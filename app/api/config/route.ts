import { NextResponse } from 'next/server';
import {
  BASE_ATTRIBUTION_IDS,
  CITIES,
  DEFAULT_CITY_ID,
  PLATEAU_TERRAIN_URL,
  cityTilesetUrls,
  resolveAttributions,
  type PublicConfig,
} from '@ijm/shared';
import { GSI_IMAGERY } from '@ijm/gis';
import { isAIConfigured } from '@ijm/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * クライアントに渡してよい公開設定のみを返す。
 * API キーや外部エンドポイントの認証情報はここに含めない。
 */
export function GET() {
  const config: PublicConfig = {
    defaultCityId: DEFAULT_CITY_ID,
    cities: CITIES.map((city) => {
      const urls = cityTilesetUrls(city);
      return {
        id: city.id,
        name: city.name,
        nameEn: city.nameEn,
        center: city.center,
        bbox: city.bbox,
        buildingTilesetUrl: urls.near,
        farBuildingTilesetUrl: urls.far,
        initialHeight: city.initialHeight,
      };
    }),
    imagery: GSI_IMAGERY.map((i) => ({
      id: i.id,
      label: i.label,
      urlTemplate: i.urlTemplate,
      attribution: i.attribution,
    })),
    terrainUrl: process.env.PLATEAU_TERRAIN_URL ?? PLATEAU_TERRAIN_URL,
    features: {
      routing: true,
      poi: true,
      ai: isAIConfigured(),
      weather: true,
    },
    attributions: resolveAttributions([...BASE_ATTRIBUTION_IDS, 'valhalla', 'nominatim', 'overpass']),
  };

  return NextResponse.json(config, {
    headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' },
  });
}
