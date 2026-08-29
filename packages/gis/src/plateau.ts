/**
 * PLATEAU 配信サービスのクライアント。
 *
 * 配信サービスは「実験的」でありサービス継続は保証されないため、
 * URL は設定で差し替え可能にし、自前ホストへ切り替えられるようにしている。
 * https://docs.plateauview.mlit.go.jp/
 */

import type { City } from '@ijm/shared';
import { PLATEAU_TERRAIN_URL, plateauTilesetUrl } from '@ijm/shared';
import { fetchWithTimeout } from './config';

export const PLATEAU_CATALOG_API = 'https://api.plateauview.mlit.go.jp/datacatalog';

export interface PlateauDataset {
  name?: string;
  url?: string;
  composite_url?: string;
  type?: string;
  city_code?: string;
  city_name?: string;
  year?: number;
  format?: string;
  format_version?: string;
}

export interface PlateauEndpoints {
  tilesetBase: string;
  terrainUrl: string;
}

export function getPlateauEndpoints(
  env: Record<string, string | undefined> = process.env,
): PlateauEndpoints {
  return {
    tilesetBase: env.PLATEAU_TILESET_BASE ?? `${PLATEAU_CATALOG_API}/3dtiles`,
    terrainUrl: env.PLATEAU_TERRAIN_URL ?? PLATEAU_TERRAIN_URL,
  };
}

/** 都市定義から実際の 3D Tiles URL を組み立てる（自前ホストにも対応） */
export function resolveCityTilesets(
  city: City,
  endpoints: PlateauEndpoints = getPlateauEndpoints(),
): { near: string; far?: string } {
  const rebase = (url: string): string =>
    endpoints.tilesetBase === `${PLATEAU_CATALOG_API}/3dtiles`
      ? url
      : url.replace(`${PLATEAU_CATALOG_API}/3dtiles`, endpoints.tilesetBase);

  return {
    near: rebase(plateauTilesetUrl(city.near)),
    far: city.far ? rebase(plateauTilesetUrl(city.far)) : undefined,
  };
}

/** タイルセットが実際に配信されているかを確認する（都市追加時の検証用） */
export async function checkTilesetAvailability(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', timeoutMs: 15000 });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * データカタログ API から、指定した市区町村コードのデータセットを検索する。
 * レスポンスが大きい（2MB 超）ため、都市追加時のスクリプトからのみ使うこと。
 */
export async function fetchDatasets(cityCode?: string): Promise<PlateauDataset[]> {
  const res = await fetchWithTimeout(`${PLATEAU_CATALOG_API}/plateau-datasets`, {
    timeoutMs: 60000,
  });
  if (!res.ok) throw new Error(`PLATEAU データカタログの取得に失敗 (HTTP ${res.status})`);
  const json = (await res.json()) as {
    latest_datasets?: PlateauDataset[];
    composite_tilesets?: PlateauDataset[];
  };
  const all = [...(json.latest_datasets ?? []), ...(json.composite_tilesets ?? [])];
  return cityCode ? all.filter((d) => d.city_code === cityCode) : all;
}
