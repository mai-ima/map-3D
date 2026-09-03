/**
 * テクスチャを持たない建物モデルの見せ方（3D Tiles のスタイル式に直す）。
 *
 * **色そのものはここで決めていない。**
 * `packages/shared/src/building-colours.ts` が用途ごとの色と高さの補正を持ち、
 * ここはそれを Cesium3DTileStyle の式へ翻訳するだけにしてある。
 * Swift へ移すときは `buildingColour()` を 1 棟ずつ呼べばよく、
 * 同じ表を見るので見た目が食い違うことはない。
 */

import * as Cesium from 'cesium';
import {
  BUILDING_HEIGHT_COLOURS,
  BUILDING_HEIGHT_UNKNOWN_COLOUR,
  BUILDING_UNKNOWN_COLOUR,
  BUILDING_USAGE_COLOURS,
  hexToRgb,
} from '@ijm/shared';

/**
 * 属性の参照。
 *
 * PLATEAU のバッチテーブルの属性名にはコロンが入っている（実データで確認済み:
 * bldg:usage / bldg:measuredHeight）。3D Tiles のスタイル式では、
 * コロンを含む名前は `${feature['名前']}` の形でしか参照できない。
 *
 * `${bldg:usage}` と直接書くと式のパースに失敗して例外になり、
 * `${['bldg:usage']}` はパースこそ通るが常に undefined になる（黙って壊れる）。
 * どちらも実際に踏んだので、参照はここに集約して書き間違いを防ぐ。
 */
const USAGE = "${feature['bldg:usage']}";
const HEIGHT = "${feature['bldg:measuredHeight']}";

/**
 * 高さによる明度の係数を、スタイル式として書いたもの。
 * 値の意味は `buildingShade()` と同じ（0m で ×0.95、60m 以上で ×1.07）。
 */
const SHADE = `(0.95 + min(${HEIGHT}, 60.0) / 500.0)`;

/**
 * 高さが入っているか。
 *
 * スタイル式に defined() は無い（Cesium が用意しているのは isNaN と isFinite）。
 * 高さが未定義のまま min() に渡すと評価時に例外になり、そのタイルが描けなくなる。
 */
const HAS_HEIGHT = `!isNaN(${HEIGHT})`;

/**
 * 高さ補正を掛けた色。
 *
 * `color(...) * 係数` と書くとアルファまで掛かってしまい、
 * 建物がわずかに半透明になる（＝不透明で描けるはずのものが
 * 半透明パスに回り、描画が重くなる）。
 * 成分ごとに掛けて、アルファは 1.0 に固定する。
 */
function shaded(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const at = (v: number) => v.toFixed(4);
  return `vec4(${at(r)} * ${SHADE}, ${at(g)} * ${SHADE}, ${at(b)} * ${SHADE}, 1.0)`;
}

/**
 * テクスチャを持たない建物モデル向けのスタイル。
 *
 * 用途で塗り分けたうえで、実測高さに応じて明度を変える。
 * 高さが入っていない建物には補正を掛けられないので、
 * 用途ごとに「高さあり」「高さなし」の 2 条件を並べている。
 */
export function untexturedBuildingStyle(): Cesium.Cesium3DTileStyle {
  const conditions: [string, string][] = [];
  for (const [usage, color] of BUILDING_USAGE_COLOURS) {
    conditions.push([`${USAGE} === '${usage}' && ${HAS_HEIGHT}`, shaded(color)]);
    conditions.push([`${USAGE} === '${usage}'`, `color('${color}')`]);
  }
  conditions.push([HAS_HEIGHT, shaded(BUILDING_UNKNOWN_COLOUR)]);
  conditions.push(['true', `color('${BUILDING_UNKNOWN_COLOUR}')`]);

  return new Cesium.Cesium3DTileStyle({ color: { conditions } });
}

/**
 * 遠景 LOD1 用の中立色。
 *
 * LOD1 はテクスチャを持たない（＝色の情報が存在しない）ため、
 * 「実在しない色を創作しない」という方針に従い、彩度をほぼ持たない
 * コンクリート系の中立色のみを使い、高さでわずかな明度差を付けるにとどめる。
 */
export function farBuildingStyle(): Cesium.Cesium3DTileStyle {
  const conditions: [string, string][] = [
    [`isNaN(${HEIGHT})`, `color("${BUILDING_HEIGHT_UNKNOWN_COLOUR}")`],
  ];
  for (const [minHeight, hex] of BUILDING_HEIGHT_COLOURS) {
    conditions.push(
      minHeight > 0 ? [`${HEIGHT} >= ${minHeight}`, `color("${hex}")`] : ['true', `color("${hex}")`],
    );
  }
  return new Cesium.Cesium3DTileStyle({ color: { conditions } });
}
