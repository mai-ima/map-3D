/**
 * PLATEAU の 3D Tiles 配信 URL の組み立てと、LOD の扱い。
 *
 * 都市データ（cities.ts）から URL 生成の知識を分離してある。
 * PLATEAU 側の命名規則が変わったときに直す場所をここ 1 箇所にするため。
 *
 * URL 仕様:
 *   {base}/3dtiles/{area}-{feature}-{lod}[-notexture]-{year}/tileset.json
 *     area   : 都道府県コード(2桁) / 市区町村コード(5桁) / "all"
 *     feature: bldg（建物）/ brid（橋梁）/ tran（道路）/ veg（植生）/ frn（都市設備）など
 *     lod    : lod1..lod4（その LOD ちょうど）/ maxlod1..maxlod4（利用可能な最大 LOD）
 *     year   : 西暦 または "latest"
 *
 * 実測（2026-08-29 時点、東京都 = area 13）:
 *   maxlod2 / maxlod3 / maxlod4 … いずれも同じ内容が返る（62 市区町村）。
 *     「max」系は利用可能な最大 LOD を意味し、LOD3 以上が無い地域は LOD2 が入る。
 *   lod3 … 港区・台東区・墨田区の 3 区のみ
 *   lod4 … 台東区のみ
 *   brid 21 件 / frn 13 件 / veg 13 件 / tran 0 件
 *
 * つまり LOD3・LOD4 は「広域のベースを置き換えるもの」ではなく
 * 「整備済みの区にだけ重ねる詳細レイヤ」として扱うのが実態に合う。
 */

export const PLATEAU_3DTILES_BASE = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
export const PLATEAU_TERRAIN_URL = 'https://tile.plateauview.mlit.go.jp/terrain';

/** 地物タイプ。PLATEAU の CityGML における feature type に対応する */
export type PlateauFeatureType =
  | 'bldg' // 建築物
  | 'brid' // 橋梁
  | 'tran' // 道路
  | 'veg' // 植生
  | 'frn' // 都市設備
  | 'luse' // 土地利用
  | 'urf'; // 都市計画決定情報

/** LOD 指定。`maxlodN` は「利用可能な最大 LOD（N 以下）」を意味する */
export type PlateauLod =
  | 'lod1'
  | 'lod2'
  | 'lod3'
  | 'lod4'
  | 'maxlod1'
  | 'maxlod2'
  | 'maxlod3'
  | 'maxlod4';

/** LOD の詳しさ。フォールバック順の決定に使う */
export const LOD_LEVEL: Record<PlateauLod, number> = {
  lod1: 1,
  maxlod1: 1,
  lod2: 2,
  maxlod2: 2,
  lod3: 3,
  maxlod3: 3,
  lod4: 4,
  maxlod4: 4,
};

/** LOD ごとの説明（UI 表示用） */
export const LOD_DESCRIPTION: Record<number, string> = {
  1: '箱型（高さのみ）',
  2: '屋根形状＋実写テクスチャ',
  3: '窓・扉などの開口部',
  4: '室内空間',
};

export interface PlateauTilesetSpec {
  /** 都道府県コード or 市区町村コード or "all" */
  area: string;
  featureType?: PlateauFeatureType;
  lod: PlateauLod;
  /** テクスチャ無し版を使う（LOD1 は元々テクスチャを持たないので指定しない） */
  notexture?: boolean;
  year?: string;
  /**
   * 配信 URL を直接指定する。
   *
   * datacatalog の `{area}-{feature}-{lod}` 形式でまとめて配信されていない都市がある。
   * 例えば浜松市は市区町村コード単位のまとめ配信が無く、区ごとに個別の
   * tileset.json が配信されている（GraphQL API から取得できる）。
   * その場合はここに URL を直接書く。
   *
   * URL 指定のデータセットは既に単一の区・単一の地物に絞られているため、
   * BFF 側での市区町村フィルタは行わない。
   */
  url?: string;
}

export function plateauDatasetId(spec: PlateauTilesetSpec): string {
  return [
    spec.area,
    spec.featureType ?? 'bldg',
    spec.lod,
    ...(spec.notexture ? ['notexture'] : []),
    spec.year ?? 'latest',
  ].join('-');
}

export function plateauTilesetUrl(spec: PlateauTilesetSpec): string {
  if (spec.url) return spec.url;
  return `${PLATEAU_3DTILES_BASE}/${plateauDatasetId(spec)}/tileset.json`;
}

/** 直接 URL 指定のデータセットか（BFF での市区町村フィルタが不要なもの） */
export function isDirectTileset(spec: PlateauTilesetSpec): boolean {
  return Boolean(spec.url);
}

/**
 * 指定 LOD から順に下位 LOD へ落としていく候補列を返す。
 *
 * LOD3・LOD4 は整備範囲が狭く、未整備の地域では中身が空の tileset が返る
 * （HTTP 200 で children が 0 件）。存在しない前提で候補を並べておき、
 * 実際に中身があったものを採用する（判定は BFF 側で行う）。
 *
 * @param minLevel これ未満の LOD には落とさない。
 *   詳細レイヤ（ベースの LOD2 に重ねるもの）が LOD2 まで落ちると
 *   ベースと同じものを二重に読み込むことになるため、下限を指定する。
 */
export function lodFallbackChain(spec: PlateauTilesetSpec, minLevel = 1): PlateauTilesetSpec[] {
  // URL を直接指定している場合、その URL が指すのは特定 LOD の実体そのもの。
  // LOD を差し替えても別の URL にはならないので、フォールバックは行わない。
  if (spec.url) return [spec];

  const level = LOD_LEVEL[spec.lod];
  const exact: PlateauLod[] = ['lod1', 'lod2', 'lod3', 'lod4'];
  const chain: PlateauTilesetSpec[] = [spec];
  const floor = Math.max(1, Math.min(minLevel, level));

  for (let l = level - 1; l >= floor; l -= 1) {
    const lod = spec.lod.startsWith('max') ? (`maxlod${l}` as PlateauLod) : exact[l - 1];
    chain.push({ ...spec, lod });
  }
  return chain;
}
