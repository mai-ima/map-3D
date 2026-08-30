/**
 * 建物の配色を検証する。
 *
 * 3D Tiles のスタイル式は文字列なので、型検査では誤りを見つけられない。
 * 実際に浜松で次の 2 つを踏んだ:
 *
 *   ${bldg:usage}      … コロンは識別子に使えず、式のパースで例外。
 *                        Cesium3DTileStyle の生成時に投げるため、
 *                        建物が 1 棟も表示されなくなる
 *   ${['bldg:usage']}  … パースは通るが常に undefined。黙って全棟同じ色になる
 *
 * どちらも「生成できること」だけでは検出できない。
 * PLATEAU の実データと同じ属性名を持つ地物で評価して、
 * 用途と高さがちゃんと色に反映されているかまで確かめる。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import { untexturedBuildingStyle } from '../building-style';
import { farTilesetStyle } from '../buildings';

/**
 * PLATEAU のバッチテーブルを模した地物。
 * 属性名は実際の b3dm から読み取ったもの（コロン付き）。
 */
function feature(props: Record<string, unknown>): Cesium.Cesium3DTileFeature {
  return {
    getProperty: (name: string) => props[name],
    getPropertyInherited: (name: string) => props[name],
    hasProperty: (name: string) => name in props,
  } as unknown as Cesium.Cesium3DTileFeature;
}

function colorOf(
  style: Cesium.Cesium3DTileStyle,
  props: Record<string, unknown>,
): Cesium.Color {
  const color = style.color?.evaluateColor(feature(props), new Cesium.Color());
  assert.ok(color, `色を評価できない: ${JSON.stringify(props)}`);
  return color;
}

/** 明るさ（0〜1）。高さによる濃淡を比べるのに使う */
const luminance = (c: Cesium.Color): number => c.red * 0.3 + c.green * 0.59 + c.blue * 0.11;

test('スタイルを生成できる', () => {
  // 式のパースに失敗するとここで例外になり、建物が 1 棟も出なくなる
  assert.doesNotThrow(() => untexturedBuildingStyle());
});

test('用途ごとに違う色になる', () => {
  const style = untexturedBuildingStyle();
  const h = 12;
  const colors = new Map<string, string>();
  for (const usage of ['住宅', '商業施設', '業務施設', '工場', '文教厚生施設']) {
    const hex = colorOf(style, {
      'bldg:usage': usage,
      'bldg:measuredHeight': h,
    }).toCssHexString();
    colors.set(usage, hex);
  }
  // 属性を参照できていないと、全部が同じ「不明」の色になる
  assert.equal(new Set(colors.values()).size, colors.size, `用途で色が変わっていない: ${[...colors]}`);

  // 業務施設は青みを、商業施設は暖色を持たせている
  const office = colorOf(style, { 'bldg:usage': '業務施設', 'bldg:measuredHeight': h });
  const shop = colorOf(style, { 'bldg:usage': '商業施設', 'bldg:measuredHeight': h });
  assert.ok(office.blue > office.red, '業務施設は青み寄り');
  assert.ok(shop.red > shop.blue, '商業施設は暖色寄り');
});

test('高い建物ほど明るくなる', () => {
  const style = untexturedBuildingStyle();
  const at = (height: number) =>
    luminance(colorOf(style, { 'bldg:usage': '住宅', 'bldg:measuredHeight': height }));

  const low = at(5);
  const mid = at(25);
  const high = at(60);
  assert.ok(low < mid, `5m (${low.toFixed(3)}) < 25m (${mid.toFixed(3)})`);
  assert.ok(mid < high, `25m (${mid.toFixed(3)}) < 60m (${high.toFixed(3)})`);

  // 段ではなく連続で変わる（同じ用途でも階数の違いが分かる）
  assert.notEqual(at(21), at(24));

  // 上限を超えても際限なく明るくならない
  assert.equal(at(60), at(200));
});

test('属性が欠けていても色が決まる', () => {
  const style = untexturedBuildingStyle();
  // 高さだけ無い / 用途だけ無い / 両方無い、のいずれでも評価できること。
  // 算術が undefined に当たると実行時例外になり、タイルの描画が止まる
  assert.ok(colorOf(style, { 'bldg:usage': '住宅' }));
  assert.ok(colorOf(style, { 'bldg:measuredHeight': 9 }));
  assert.ok(colorOf(style, {}));
  // 未知の用途でも落ちない
  assert.ok(colorOf(style, { 'bldg:usage': '該当なし', 'bldg:measuredHeight': 9 }));
});

test('建物は不透明のまま', () => {
  // color(...) にスカラを掛けるとアルファまで掛かってしまう。
  // わずかでも 1.0 を割ると半透明パスに回り、描画が重くなる
  const style = untexturedBuildingStyle();
  for (const height of [0, 5, 20, 45, 60, 200]) {
    for (const usage of ['住宅', '商業施設', undefined]) {
      const props: Record<string, unknown> = { 'bldg:measuredHeight': height };
      if (usage) props['bldg:usage'] = usage;
      assert.equal(colorOf(style, props).alpha, 1, `${usage ?? '用途なし'} ${height}m`);
    }
  }
});

test('遠景 LOD1 は高さで濃淡が付く', () => {
  const style = farTilesetStyle();
  const at = (height: number) =>
    luminance(colorOf(style, { 'bldg:measuredHeight': height }));

  // 高い建物ほど暗く（遠景では超高層が塊に見えないよう沈める）
  assert.ok(at(200) < at(100));
  assert.ok(at(100) < at(50));
  assert.ok(at(50) < at(10));

  // 高さが無くても評価できる
  assert.ok(colorOf(style, {}));
  // 属性名を間違えていると、どの高さでも同じ色になる
  assert.notEqual(at(10), at(200));
});

test('多い用途ほど早く判定される', () => {
  // 条件は上から順に評価され、最初に一致したところで止まる。
  // 浜松では住宅系だけで 7 割を占めるので、ここが後ろにあると
  // 1 棟あたりの評価回数がそのまま増える
  const conditions = (untexturedBuildingStyle().color as unknown as {
    _conditions: [string, string][];
  })._conditions;

  const indexOf = (usage: string) => conditions.findIndex(([c]) => c.includes(`'${usage}'`));
  assert.ok(indexOf('住宅') >= 0, '住宅の条件がある');
  assert.ok(indexOf('住宅') < indexOf('商業施設'));
  assert.ok(indexOf('商業施設') < indexOf('防衛施設'));

  // 用途 1 つにつき「高さあり」「高さなし」の 2 条件 + 未知の用途 2 条件
  assert.equal(conditions.length, 16 * 2 + 2);
});
