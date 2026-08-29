/**
 * データ出典・ライセンス定義。
 *
 * ライセンス表示は「書き忘れ」が規約違反に直結するため、
 * データソースを使う側が id を宣言し、UI が自動で列挙する構造にしている。
 * 新しいデータソースを追加するときは、必ずここに定義を足すこと。
 */

import type { DataSource } from './types';

export const DATA_SOURCES: Record<string, DataSource> = {
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
  plateau: {
    id: 'plateau',
    label: 'Project PLATEAU',
    attribution: '3D都市モデル Project PLATEAU（国土交通省）',
    license: 'CC BY 4.0',
    url: 'https://www.mlit.go.jp/plateau/',
  },
  'plateau-terrain': {
    id: 'plateau-terrain',
    label: 'PLATEAU-Terrain',
    attribution: 'PLATEAU | Mapterhorn | 国土地理院',
    license: 'CC BY 4.0 相当（配信サービスの表示に従う）',
    url: 'https://docs.plateauview.mlit.go.jp/datasets/terrain/',
  },
  gsi: {
    id: 'gsi',
    label: '地理院タイル',
    attribution: '出典：国土地理院（地理院タイル）',
    license: '国土地理院コンテンツ利用規約（出典明示で利用可）',
    url: 'https://maps.gsi.go.jp/development/ichiran.html',
  },
  valhalla: {
    id: 'valhalla',
    label: 'Valhalla',
    attribution: 'Routing by Valhalla（データは OpenStreetMap 由来）',
    license: 'MIT（ソフトウェア） / ODbL 1.0（データ）',
    url: 'https://valhalla.github.io/valhalla/',
  },
  osrm: {
    id: 'osrm',
    label: 'OSRM',
    attribution: 'Routing by OSRM（データは OpenStreetMap 由来）',
    license: 'BSD-2-Clause（ソフトウェア） / ODbL 1.0（データ）',
    url: 'https://project-osrm.org/',
  },
  nominatim: {
    id: 'nominatim',
    label: 'Nominatim',
    attribution: 'Geocoding by Nominatim（© OpenStreetMap contributors）',
    license: 'ODbL 1.0',
    url: 'https://nominatim.org/',
  },
  overpass: {
    id: 'overpass',
    label: 'Overpass API',
    attribution: 'POI データ: © OpenStreetMap contributors（Overpass API 経由）',
    license: 'ODbL 1.0',
    url: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
  },
  cesium: {
    id: 'cesium',
    label: 'CesiumJS',
    attribution: 'Rendered with CesiumJS',
    license: 'Apache-2.0',
    url: 'https://cesium.com/platform/cesiumjs/',
  },
};

export function resolveAttributions(ids: string[]): DataSource[] {
  const seen = new Set<string>();
  const out: DataSource[] = [];
  for (const id of ids) {
    const src = DATA_SOURCES[id];
    if (src && !seen.has(id)) {
      seen.add(id);
      out.push(src);
    }
  }
  return out;
}

export function attributionStrings(ids: string[]): string[] {
  return resolveAttributions(ids).map((s) => s.attribution);
}

/** 3D 表示で常時必要になる出典 */
export const BASE_ATTRIBUTION_IDS = ['plateau', 'plateau-terrain', 'gsi', 'osm', 'cesium'];
