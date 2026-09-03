/**
 * 建物モデルの見え方の選択。
 *
 * PLATEAU は同じ地域について、少なくとも 3 通りの配信を持っている。
 *
 *   {area}-bldg-maxlod2-latest            LOD2 ＋ 実写テクスチャ
 *   {area}-bldg-maxlod2-notexture-latest  LOD2（屋根形状はある。テクスチャだけ無い）
 *   {area}-bldg-maxlod1-latest            LOD1（高さだけの箱）
 *
 * これまでは都市ごとに 1 つを決め打ちしていた。
 * 東京はテクスチャ付き、浜松はテクスチャ無しである。
 * ところが浜松の見え方（用途で塗り分けた無彩色の街）は、テクスチャの
 * 貼り合わせのむらが無いぶん形が読み取りやすく、通信量も少ない。
 * 「東京でも選べるようにして」という要望はここから来ている。
 *
 * 実測（2026-09, 東京都 area=13 の tileset.json）:
 *   maxlod2           62 市区町村  19,858 byte
 *   maxlod2-notexture 45 市区町村  15,037 byte
 *   maxlod1           62 市区町村  19,858 byte
 * 中心 5 区（千代田・中央・港・新宿・渋谷）は 3 つとも揃っている。
 *
 * データの実量（千代田区、b3dm を等間隔に 19 枚取って実測）:
 *
 *   LOD2 テクスチャあり  633 枚  平均 695KB/枚  区全体でおよそ 440MB
 *   LOD2 テクスチャなし  633 枚  平均 345KB/枚  区全体でおよそ 218MB
 *   LOD1 箱型             20 枚  平均 4.65MB/枚 区全体でおよそ  93MB
 *
 * テクスチャを外すと通信量はほぼ半分になる。タイルの分かれ方は同じなので、
 * 範囲で絞る効き方も変わらない。
 *
 * 一方 LOD1 は総量こそ最小だが、四分木が浅く 1 枚が 4.65MB もある。
 * 「箱型にすれば通信が軽い」とは限らない（視界に 3 枚入れば 14MB）。
 * 軽いのは頂点数と描画のほうで、そこは桁違いに減る。
 *
 * LOD1 のバッチテーブルにも `bldg:usage` と `bldg:measuredHeight` が入っている
 * ことを実測で確認済み（千代田区 data19.b3dm）。箱型でも用途で塗り分けられる。
 *
 * この選択は「何を描くか」の決定であって描画エンジンの都合ではないので、
 * Cesium を import しないこの層に置く（Swift へ移すときもそのまま使える）。
 */

import type { City } from './cities';
import { isDirectTileset, type PlateauTilesetSpec } from './plateau';

/** 建物モデルの見え方 */
export type BuildingModelMode =
  /** LOD2 ＋ 実写テクスチャ。整備されている都市の既定 */
  | 'textured'
  /** LOD2 のジオメトリのみ。用途属性で塗り分ける（浜松と同じ見え方） */
  | 'untextured'
  /** LOD1 の箱。高さだけを持つ最も軽い表現 */
  | 'block';

export const BUILDING_MODEL_MODES: {
  id: BuildingModelMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'textured',
    label: '実写テクスチャ',
    description: '屋根形状に実際の航空写真を貼った LOD2。最も情報量が多い',
  },
  {
    id: 'untextured',
    label: '用途で塗り分け',
    description: '屋根形状はそのまま、色は建物用途から決める LOD2。通信量はおよそ半分',
  },
  {
    id: 'block',
    label: '箱型',
    description: '高さだけの LOD1。頂点数が最も少なく、描画が軽い',
  },
];

export const DEFAULT_BUILDING_MODEL: BuildingModelMode = 'textured';

/** 値が建物モデルの選択かどうか */
export function isBuildingModelMode(value: unknown): value is BuildingModelMode {
  return value === 'textured' || value === 'untextured' || value === 'block';
}

/**
 * その都市で選べる見え方。
 *
 * 配信 URL を直接指定している都市（浜松・姫路）は、市区町村コード単位の
 * まとめ配信が無いため個別の tileset.json を URL で指している。
 * URL は特定の LOD・特定のテクスチャ有無の実体そのものを指すので、
 * 差し替えても別のデータにはならない。選択肢は 1 つだけになる。
 *
 * `texturedBuildings === false` の都市は、そもそも実写テクスチャが
 * 配信されていない（配布 ZIP にも画像が無い）ので textured を出さない。
 */
export function availableBuildingModes(city: City): BuildingModelMode[] {
  if (isDirectTileset(city.near)) return ['untextured'];
  if (city.texturedBuildings === false) return ['untextured', 'block'];
  return ['textured', 'untextured', 'block'];
}

/**
 * 要求された見え方を、その都市で実際に選べるものへ寄せる。
 *
 * 都市を切り替えたときに、前の都市でしか選べない値が残ることがある。
 * 「近いもの」へ落とす順序は textured → untextured → block。
 * 選べないからといって既定へ飛ばすと、箱型を選んでいた人が
 * 都市を移った拍子にテクスチャ付きへ跳ね上がって通信量が増える。
 */
export function resolveBuildingMode(city: City, requested: unknown): BuildingModelMode {
  const available = availableBuildingModes(city);
  if (isBuildingModelMode(requested) && available.includes(requested)) return requested;

  if (requested === 'textured') {
    // テクスチャが無いなら、形はそのままの untextured が最も近い
    return available.includes('untextured') ? 'untextured' : available[0];
  }
  if (requested === 'block') {
    return available.includes('block') ? 'block' : available[available.length - 1];
  }
  return available.includes(DEFAULT_BUILDING_MODEL) ? DEFAULT_BUILDING_MODEL : available[0];
}

/**
 * 見え方の選択をデータ指定へ反映する。
 *
 * URL 直指定のデータセットには何もしない（URL が実体そのものを指しているため）。
 */
export function applyBuildingModel(
  spec: PlateauTilesetSpec,
  mode: BuildingModelMode,
): PlateauTilesetSpec {
  if (isDirectTileset(spec)) return spec;
  switch (mode) {
    case 'textured':
      // notexture を外す。付けたままだと選び直しても戻らない
      return { ...spec, notexture: undefined };
    case 'untextured':
      return { ...spec, notexture: true };
    case 'block':
      // LOD1 はもともとテクスチャを持たないので notexture は付けない
      // （`13-bldg-maxlod1-notexture-latest` という配信は存在しない）
      return { ...spec, lod: spec.lod.startsWith('max') ? 'maxlod1' : 'lod1', notexture: undefined };
  }
}

/**
 * 用途属性で塗り分ける必要があるか。
 *
 * 実写テクスチャがあるときは一切スタイルを当てない。
 * それが「事実どおりの色」そのものだからである。
 */
export function needsUsageColouring(mode: BuildingModelMode): boolean {
  return mode !== 'textured';
}

/**
 * 遠景 LOD1 を重ねる意味があるか。
 *
 * 箱型を選んだ時点で近景そのものが LOD1 なので、遠景を重ねると
 * まったく同じ箱を二重に描くことになる（深度が競合してちらつく）。
 */
export function needsFarLayer(mode: BuildingModelMode): boolean {
  return mode !== 'block';
}
