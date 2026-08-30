/**
 * 都市レジストリ。
 *
 * 全国展開は「このファイルにエントリを 1 つ追加する」だけで完結する設計にしている。
 * アプリは起動時にすべての都市を読み込むことはせず、選択された都市の
 * カメラ周辺に入ったときにだけ 3D Tiles を attach する。
 *
 * PLATEAU の URL 組み立てと LOD の扱いは plateau.ts に分離してある
 * （配信側の命名規則が変わったときに直す場所を 1 箇所にするため）。
 */

import type { BBox, LatLng } from './types';
import { plateauTilesetUrl, type PlateauTilesetSpec } from './plateau';

// 既存の import 経路を壊さないよう、ここからも再エクスポートしておく
export { PLATEAU_3DTILES_BASE, PLATEAU_TERRAIN_URL, plateauTilesetUrl } from './plateau';
export type { PlateauTilesetSpec } from './plateau';

/** 建物以外の地物レイヤ */
export interface CityOverlay {
  id: string;
  label: string;
  spec: PlateauTilesetSpec;
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
  /**
   * 近景モデルが実写テクスチャを持つか。
   *
   * PLATEAU の LOD2 は自治体・年度でテクスチャの有無が違う。
   * 東京都（2025 年度）は WebP テクスチャを埋め込んでいるが、
   * 浜松市（2023 年度）はジオメトリのみ（配布 ZIP にも画像が無い）。
   * テクスチャが無い都市では、建物の用途属性で塗り分けて見た目を補う。
   * 既定は true（テクスチャ付きとして扱い、色は一切いじらない）。
   */
  texturedBuildings?: boolean;
  /** 遠景用（軽量 LOD1、テクスチャ無し） */
  far?: PlateauTilesetSpec;
  /**
   * 詳細モデル（LOD3 = 開口部、LOD4 = 室内）。
   *
   * 整備範囲が非常に狭く、広域のベースを置き換えるものではないため、
   * 「整備済みの区にだけ重ねる追加レイヤ」として扱う。
   * 未整備の場合は中身が空の tileset が返るので、BFF 側で判定して無視する。
   */
  detail?: PlateauTilesetSpec;
  /** 建物以外の地物（橋梁・都市設備・植生など）。任意で重ねられる */
  overlays?: CityOverlay[];
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
    // LOD4（室内）は台東区のみ、LOD3（開口部）は港区・台東区・墨田区のみ整備済み
    // （2026-08 時点の実測 / npm run survey:lod で確認できる）。
    // LOD4 を要求し、無ければ LOD3 に落ちる。LOD2 までは落とさない（ベースと重複するため）。
    detail: { area: '13', lod: 'lod4' },
    overlays: [
      { id: 'bridge', label: '橋梁', spec: { area: '13', featureType: 'brid', lod: 'maxlod2' } },
      { id: 'furniture', label: '都市設備', spec: { area: '13', featureType: 'frn', lod: 'maxlod2' } },
      { id: 'vegetation', label: '植生', spec: { area: '13', featureType: 'veg', lod: 'maxlod2' } },
    ],
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
    /**
     * 姫路市。
     *
     * 以前はここに神戸市を置いていたが、PLATEAU には神戸市のデータが存在しない。
     * 兵庫県 (28) のまとめ配信に入っているのは姫路・加古川・三木・朝来・たつのの
     * 5 市だけで、コンポジットの範囲も東経 134.42〜135.17 と、神戸 (135.18) に届かない。
     * そのため神戸を選ぶと必ず「3D 都市データを読み込めませんでした」になっていた。
     * 実際に整備されている姫路市に差し替えている（確認: npm run survey:city -- 28201）。
     *
     * 姫路市は区ごとではなく市単位で配信されているので URL を直接指定する。
     */
    id: 'himeji',
    name: '姫路',
    nameEn: 'Himeji',
    prefectureCode: '28',
    cityCodes: ['28201'],
    // 姫路駅（OpenStreetMap の実測値）
    center: { lat: 34.82965, lng: 134.69023 },
    // 3D Tiles が実際にカバーする範囲（tileset.json の boundingVolume より）
    bbox: [134.46069, 34.64105, 134.80906, 35.09027],
    near: {
      area: '28201',
      lod: 'lod2',
      url: 'https://assets.cms.plateau.reearth.io/assets/0e/d29649-6196-4d81-97c7-41cc343b0942/28201_himeji-shi_city_2023_citygml_2_op_bldg_3dtiles_lod2/tileset.json',
    },
    far: {
      area: '28201',
      lod: 'lod1',
      url: 'https://assets.cms.plateau.reearth.io/assets/7e/feb981-bc38-4e5e-b6de-162d40d6bfe8/28201_himeji-shi_city_2023_citygml_2_op_bldg_3dtiles_lod1/tileset.json',
    },
    initialHeight: 1200,
    districts: [
      {
        id: 'himeji-station',
        name: '姫路駅',
        center: { lat: 34.82965, lng: 134.69023 },
        height: 600,
        heading: 0,
        description: '大手前通りがまっすぐ姫路城へ伸びる',
      },
      {
        id: 'himeji-castle',
        name: '姫路城',
        center: { lat: 34.83945, lng: 134.69391 },
        height: 700,
        heading: 180,
        description: '現存天守。世界文化遺産',
      },
    ],
  },
  {
    /**
     * 浜松市（旧中区）。
     *
     * 浜松市は datacatalog の `{市区町村コード}-bldg-{lod}` 形式ではまとめ配信されておらず、
     * 区ごとに個別の tileset.json が配信されている（PLATEAU の GraphQL API から取得できる）。
     * そのため URL を直接指定している。取得方法は npm run survey:city -- 22130 を参照。
     *
     * 単一区のデータセットなので、東京のように市区町村単位で絞り込む必要がなく、
     * 読み込むタイル量も桁違いに少ない。
     *
     * 旧中区は 2024 年 1 月の区再編で中央区に統合されたが、
     * PLATEAU のデータは再編前の区割り（22131 naka-ku）で整備されている。
     */
    id: 'hamamatsu',
    name: '浜松（中区）',
    nameEn: 'Hamamatsu',
    prefectureCode: '22',
    cityCodes: ['22131'],
    // 浜松駅（OpenStreetMap の実測値）
    center: { lat: 34.704715, lng: 137.734228 },
    // 旧中区の 3D Tiles が実際にカバーする範囲（tileset.json の boundingVolume より）
    bbox: [137.68085, 34.68036, 137.76112, 34.78313],
    near: {
      area: '22131',
      lod: 'lod2',
      url: 'https://assets.cms.plateau.reearth.io/assets/8e/e64279-974c-4b98-861d-1d2fa7c6a327/22130_hamamatsu-shi_city_2023_citygml_2_op_bldg_3dtiles_22131_naka-ku_lod2/tileset.json',
    },
    far: {
      area: '22131',
      lod: 'lod1',
      url: 'https://assets.cms.plateau.reearth.io/assets/8d/01deb7-3c29-4faf-9d15-818d79158d52/22130_hamamatsu-shi_city_2023_citygml_2_op_bldg_3dtiles_22131_naka-ku_lod1/tileset.json',
    },
    // 2023 年度データのため実写テクスチャを持たない。
    // 建物の用途属性（bldg:usage）と実測高さで塗り分けて補う。
    texturedBuildings: false,
    // 市街地が平坦で見晴らしがよいため、東京より低い高度から始める
    initialHeight: 1100,
    districts: [
      {
        id: 'hamamatsu-station',
        name: '浜松駅',
        center: { lat: 34.704715, lng: 137.734228 },
        height: 550,
        heading: 315,
        description: '新幹線が停まる市の玄関口。北口に駅前広場が広がる',
      },
      {
        id: 'act-city',
        name: 'アクトシティ',
        center: { lat: 34.70611, lng: 137.736585 },
        height: 520,
        heading: 200,
        description: '高さ 212m のアクトタワー。市内で最も高い建物',
      },
      {
        id: 'kajimachi',
        name: '鍛冶町・ザザシティ',
        center: { lat: 34.70458, lng: 137.728678 },
        height: 450,
        heading: 45,
        description: '駅前から続く中心市街地',
      },
      {
        id: 'entetsu',
        name: '遠鉄百貨店',
        center: { lat: 34.703791, lng: 137.733152 },
        height: 430,
        heading: 340,
        description: '浜松駅北口に隣接する百貨店',
      },
      {
        id: 'city-hall',
        name: '浜松市役所',
        center: { lat: 34.710907, lng: 137.726325 },
        height: 600,
        heading: 160,
      },
      {
        id: 'hamamatsu-castle',
        name: '浜松城公園',
        center: { lat: 34.712221, lng: 137.724196 },
        height: 500,
        heading: 120,
        description: '徳川家康が築いた浜松城の跡地',
      },
    ],
    notes:
      '旧中区の建築物モデル（LOD2・テクスチャ付き）を区単位で読み込む。単一区のため読み込み量が少なく、動作が軽い。',
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
