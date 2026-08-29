/**
 * 都市レジストリ。
 *
 * 全国展開は「このファイルにエントリを 1 つ追加する」だけで完結する設計にしている。
 * アプリは起動時にすべての都市を読み込むことはせず、選択された都市（および隣接都市）の
 * bbox に入ったときにだけ 3D Tiles を attach する。
 *
 * PLATEAU の 3D Tiles URL 仕様:
 *   https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{area}-{type}-{lod}-{year}/tileset.json
 *   area: 都道府県コード(2桁) / 市区町村コード(5桁) / "all"
 *   lod : lod1 | lod2 | maxlod1 | maxlod2 (+ "-notexture")
 *   year: 西暦 または "latest"
 */

import type { BBox, LatLng } from './types';

export const PLATEAU_3DTILES_BASE = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
export const PLATEAU_TERRAIN_URL = 'https://tile.plateauview.mlit.go.jp/terrain';

export interface PlateauTilesetSpec {
  /** 都道府県コード or 市区町村コード or "all" */
  area: string;
  featureType?: 'bldg' | 'brid' | 'tran' | 'veg' | 'frn';
  lod: 'lod1' | 'lod2' | 'maxlod1' | 'maxlod2';
  notexture?: boolean;
  year?: string;
}

export function plateauTilesetUrl(spec: PlateauTilesetSpec): string {
  const parts = [
    spec.area,
    spec.featureType ?? 'bldg',
    spec.lod,
    ...(spec.notexture ? ['notexture'] : []),
    spec.year ?? 'latest',
  ];
  return `${PLATEAU_3DTILES_BASE}/${parts.join('-')}/tileset.json`;
}

/** 都市内の注目エリア（段階的に追加していく単位） */
export interface District {
  id: string;
  name: string;
  center: LatLng;
  /** 初期表示の高度 (m) */
  height: number;
  /** 初期方位 (度) */
  heading?: number;
  description?: string;
}

export interface City {
  id: string;
  name: string;
  nameEn: string;
  prefectureCode: string;
  /** 市区町村コード（PLATEAU の area 指定に使う） */
  cityCodes: string[];
  center: LatLng;
  bbox: BBox;
  /** 近景・中景用（テクスチャ付き LOD2 を含む） */
  near: PlateauTilesetSpec;
  /** 遠景用（軽量 LOD1、テクスチャ無し） */
  far?: PlateauTilesetSpec;
  initialHeight: number;
  districts: District[];
  /** データ整備状況のメモ（PLATEAU の整備差を UI に出すため） */
  notes?: string;
}

export const CITIES: readonly City[] = [
  {
    id: 'tokyo',
    name: '東京都心',
    nameEn: 'Tokyo',
    prefectureCode: '13',
    cityCodes: ['13101', '13102', '13103', '13104', '13113'],
    center: { lat: 35.681236, lng: 139.767125 },
    bbox: [139.6, 35.58, 139.85, 35.76],
    near: { area: '13', lod: 'maxlod2' },
    far: { area: '13', lod: 'maxlod1' },
    initialHeight: 1800,
    districts: [
      {
        id: 'tokyo-station',
        name: '東京駅',
        center: { lat: 35.681236, lng: 139.767125 },
        height: 700,
        heading: 285,
        description: '丸の内口・八重洲口を含む中心エリア',
      },
      {
        id: 'marunouchi',
        name: '丸の内',
        center: { lat: 35.6812, lng: 139.7625 },
        height: 600,
        heading: 0,
      },
      {
        id: 'imperial-palace',
        name: '皇居周辺',
        center: { lat: 35.6852, lng: 139.7528 },
        height: 1100,
        heading: 90,
      },
      {
        id: 'ginza',
        name: '銀座',
        center: { lat: 35.671989, lng: 139.765057 },
        height: 700,
        heading: 20,
      },
      {
        id: 'shibuya',
        name: '渋谷',
        center: { lat: 35.658034, lng: 139.701636 },
        height: 700,
        heading: 45,
      },
      {
        id: 'shinjuku',
        name: '新宿',
        center: { lat: 35.689592, lng: 139.700413 },
        height: 900,
        heading: 200,
      },
    ],
    notes: '東京 23 区は PLATEAU の LOD2（テクスチャ付き）整備範囲が広い。',
  },
  {
    id: 'yokohama',
    name: '横浜',
    nameEn: 'Yokohama',
    prefectureCode: '14',
    cityCodes: ['14100'],
    center: { lat: 35.454, lng: 139.6317 },
    bbox: [139.55, 35.38, 139.72, 35.53],
    near: { area: '14100', lod: 'maxlod2' },
    far: { area: '14', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'minatomirai', name: 'みなとみらい', center: { lat: 35.4577, lng: 139.6317 }, height: 900 },
      { id: 'yokohama-station', name: '横浜駅', center: { lat: 35.4658, lng: 139.6222 }, height: 700 },
    ],
  },
  {
    id: 'osaka',
    name: '大阪',
    nameEn: 'Osaka',
    prefectureCode: '27',
    cityCodes: ['27100'],
    center: { lat: 34.7025, lng: 135.4959 },
    bbox: [135.4, 34.6, 135.6, 34.78],
    near: { area: '27100', lod: 'maxlod2' },
    far: { area: '27', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'umeda', name: '梅田', center: { lat: 34.7025, lng: 135.4959 }, height: 800 },
      { id: 'namba', name: '難波', center: { lat: 34.6659, lng: 135.5011 }, height: 800 },
    ],
  },
  {
    id: 'kyoto',
    name: '京都',
    nameEn: 'Kyoto',
    prefectureCode: '26',
    cityCodes: ['26100'],
    center: { lat: 34.9858, lng: 135.7588 },
    bbox: [135.66, 34.9, 135.83, 35.09],
    near: { area: '26100', lod: 'maxlod2' },
    far: { area: '26', lod: 'maxlod1' },
    initialHeight: 1800,
    districts: [
      { id: 'kyoto-station', name: '京都駅', center: { lat: 34.9858, lng: 135.7588 }, height: 900 },
    ],
  },
  {
    id: 'nagoya',
    name: '名古屋',
    nameEn: 'Nagoya',
    prefectureCode: '23',
    cityCodes: ['23100'],
    center: { lat: 35.1709, lng: 136.8815 },
    bbox: [136.8, 35.1, 136.96, 35.24],
    near: { area: '23100', lod: 'maxlod2' },
    far: { area: '23', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'nagoya-station', name: '名古屋駅', center: { lat: 35.1709, lng: 136.8815 }, height: 800 },
    ],
  },
  {
    id: 'sapporo',
    name: '札幌',
    nameEn: 'Sapporo',
    prefectureCode: '01',
    cityCodes: ['01100'],
    center: { lat: 43.0686, lng: 141.3508 },
    bbox: [141.25, 42.98, 141.45, 43.14],
    near: { area: '01100', lod: 'maxlod2' },
    far: { area: '01', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'sapporo-station', name: '札幌駅', center: { lat: 43.0686, lng: 141.3508 }, height: 900 },
    ],
  },
  {
    id: 'fukuoka',
    name: '福岡',
    nameEn: 'Fukuoka',
    prefectureCode: '40',
    cityCodes: ['40130'],
    center: { lat: 33.5897, lng: 130.4207 },
    bbox: [130.33, 33.53, 130.48, 33.66],
    near: { area: '40130', lod: 'maxlod2' },
    far: { area: '40', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'hakata', name: '博多駅', center: { lat: 33.5897, lng: 130.4207 }, height: 800 },
    ],
  },
  {
    id: 'kobe',
    name: '神戸',
    nameEn: 'Kobe',
    prefectureCode: '28',
    cityCodes: ['28100'],
    center: { lat: 34.6796, lng: 135.1781 },
    bbox: [135.1, 34.62, 135.27, 34.75],
    // 神戸市 (28100) 単独の配信は空のため、県単位のコンポジットを使う
    near: { area: '28', lod: 'maxlod2' },
    far: { area: '28', lod: 'maxlod1' },
    initialHeight: 1600,
    districts: [
      { id: 'sannomiya', name: '三宮', center: { lat: 34.6947, lng: 135.1959 }, height: 800 },
    ],
  },
];

export const DEFAULT_CITY_ID = 'tokyo';

export function getCity(id: string): City | undefined {
  return CITIES.find((c) => c.id === id);
}

export function getDefaultCity(): City {
  return getCity(DEFAULT_CITY_ID) ?? CITIES[0];
}

/** 座標を含む都市を返す（bbox 判定） */
export function findCityAt(p: LatLng): City | undefined {
  return CITIES.find(
    (c) => p.lng >= c.bbox[0] && p.lat >= c.bbox[1] && p.lng <= c.bbox[2] && p.lat <= c.bbox[3],
  );
}

export function cityTilesetUrls(city: City): { near: string; far?: string } {
  return {
    near: plateauTilesetUrl(city.near),
    far: city.far ? plateauTilesetUrl(city.far) : undefined,
  };
}
