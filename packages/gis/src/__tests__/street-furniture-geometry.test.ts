/**
 * 街路樹・街灯・ベンチ・信号の寸法。
 *
 * 「木がリアルじゃない」という指摘への対応をここで固定する。
 * 以前は幹の円柱 1 本と球 1 個で、棒付きキャンディにしか見えなかった。
 * さらに寸法の決め方が map-engine（Cesium）の中にあり、
 * 生成した形を測ることも、Swift へ持っていくこともできなかった。
 *
 * 寸法の出典:
 *   街路樹 … 道路緑化技術基準（樹高 4〜12m、枝下高は歩道上 2.5m 以上）
 *   街灯   … 道路照明施設設置基準・同解説（取付高さ、オーバーハング）
 *   信号   … 交通信号灯器の設置基準（灯器 0.94×0.35m、下端 5.0m 以上）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LatLng, RevolvedShape, SpheroidShape } from '@ijm/shared';
import {
  benchShapes,
  lampShapes,
  trafficSignalShapes,
  treeFormOf,
  treeShapes,
} from '../street-furniture-geometry';

const AT: LatLng = { lat: 34.7047, lng: 137.7342 };
const GROUND = 12;
const M_PER_DEG = 111_320;

/** 2 点の水平距離 (m) */
function metres(a: LatLng, b: LatLng): number {
  const cos = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * M_PER_DEG, (b.lng - a.lng) * M_PER_DEG * cos);
}

test('木は幹と、重ねた樹冠のかたまりでできている', () => {
  // 球 1 個だと棒付きキャンディにしか見えない
  const shapes = treeShapes(AT, { ground: GROUND, blobs: 5 });
  const trunk = shapes.filter((s): s is RevolvedShape => s.kind === 'revolved');
  const leaves = shapes.filter((s): s is SpheroidShape => s.kind === 'spheroid');

  assert.equal(trunk.length, 1, '幹が 1 本でない');
  assert.equal(leaves.length, 5, '樹冠のかたまりが積まれていない');

  // 幹は根元が太く、上へ行くほど細い
  assert.ok(trunk[0].bottomRadius > trunk[0].topRadius, '幹が円柱のまま');
  // 幹は地面から立つ
  assert.equal(trunk[0].base.alt, GROUND);

  // かたまりは同じ高さに重なっていない（1 個の球に見えてしまう）
  const heights = leaves.map((l) => l.centre.alt ?? 0).sort((a, b) => a - b);
  assert.ok(heights[heights.length - 1] - heights[0] > 1, '樹冠が縦に積まれていない');
  // 水平にもずれていて、輪郭が不揃いになる
  assert.ok(
    leaves.some((l) => metres(AT, l.centre) > 0.1),
    '樹冠が一直線に並んでいる',
  );
});

test('枝下高は歩道の通行に必要な高さを確保する', () => {
  // 道路緑化技術基準: 歩道上の枝下高は 2.5m 以上
  for (const height of ['4', '6', '8', '12']) {
    const shapes = treeShapes(AT, { ground: GROUND, tags: { height } });
    const leaves = shapes.filter((s): s is SpheroidShape => s.kind === 'spheroid');
    const lowest = Math.min(...leaves.map((l) => (l.centre.alt ?? 0) - l.heightRadius));
    assert.ok(
      lowest - GROUND >= 2.0,
      `樹高 ${height}m で枝が ${(lowest - GROUND).toFixed(1)}m まで下がっている`,
    );
  }
});

test('OSM に樹高があればそれを使う', () => {
  const tall = treeShapes(AT, { ground: GROUND, tags: { height: '13' } });
  const short = treeShapes(AT, { ground: GROUND, tags: { height: '4.5' } });
  const topOf = (shapes: ReturnType<typeof treeShapes>) =>
    Math.max(
      ...shapes.map((s) =>
        s.kind === 'spheroid'
          ? (s.centre.alt ?? 0) + s.heightRadius
          : s.kind === 'revolved'
            ? (s.base.alt ?? 0) + s.height
            : 0,
      ),
    );
  assert.ok(topOf(tall) - topOf(short) > 5, '樹高のタグが効いていない');
});

test('樹高が壊れたタグでも実在する範囲に収まる', () => {
  // OSM のタグは自由入力。height=300 の街路樹は無い
  for (const height of ['300', '-5', 'とても高い', '0']) {
    const shapes = treeShapes(AT, { ground: GROUND, tags: { height } });
    const top = Math.max(
      ...shapes.map((s) =>
        s.kind === 'spheroid' ? (s.centre.alt ?? 0) + s.heightRadius : 0,
      ),
    );
    assert.ok(top - GROUND < 20, `樹高 ${height} で ${(top - GROUND).toFixed(0)}m になっている`);
    assert.ok(top > GROUND, `樹高 ${height} で木が消えている`);
  }
});

test('樹種で樹形を変える', () => {
  // 日本の街路樹はイチョウ・ケヤキが多く、樹形が遠目にも違う
  assert.equal(treeFormOf({ genus: 'Ginkgo' }), 'columnar', 'イチョウ');
  assert.equal(treeFormOf({ species: 'Zelkova serrata' }), 'vase', 'ケヤキ');
  assert.equal(treeFormOf({ leaf_type: 'needleleaved' }), 'needleleaf');
  assert.equal(treeFormOf({ genus: 'Prunus' }), 'broadleaf', 'サクラ');
  // 何も分からなければ広葉樹（日本の街路樹の 9 割以上）
  assert.equal(treeFormOf({}), 'broadleaf');

  // 針葉樹は円錐 1 つ
  const pine = treeShapes(AT, { ground: GROUND, tags: { leaf_type: 'needleleaved' } });
  const cones = pine.filter((s): s is RevolvedShape => s.kind === 'revolved');
  assert.equal(cones.length, 2, '幹と円錐の 2 つでない');
  assert.equal(cones[1].topRadius, 0, '樹冠が円錐になっていない');
  assert.equal(pine.filter((s) => s.kind === 'spheroid').length, 0);
});

test('同じ木は何度組み立てても同じ形になる', () => {
  // 位置から決まる擬似乱数を使う。毎回変わると、範囲を取り直すたびに
  // 街路樹の形が変わってちらつく
  const a = JSON.stringify(treeShapes(AT, { ground: GROUND }));
  const b = JSON.stringify(treeShapes(AT, { ground: GROUND }));
  assert.equal(a, b);
});

test('遠いときは樹冠のかたまりを減らす', () => {
  const near = treeShapes(AT, { ground: GROUND, blobs: 5 }).length;
  const far = treeShapes(AT, { ground: GROUND, blobs: 1 }).length;
  assert.ok(far < near);
  assert.ok(far >= 2, '幹と樹冠が残っていない');
});

test('街灯は車道側へ灯具を張り出す', () => {
  // 道路照明施設設置基準: オーバーハングは車道側へ 1〜2m
  const shapes = lampShapes(AT, { ground: GROUND, headingDeg: 90 });
  const pole = shapes.find((s): s is RevolvedShape => s.kind === 'revolved');
  const head = shapes.find((s) => s.id?.endsWith('#head'));
  assert.ok(pole && head && head.kind === 'box');
  if (!pole || head?.kind !== 'box') return;

  assert.equal(pole.base.alt, GROUND, 'ポールが地面から立っていない');
  assert.ok(pole.bottomRadius > pole.topRadius, 'ポールが先細りでない');
  const overhang = metres(AT, head.centre);
  assert.ok(overhang > 0.8 && overhang < 3, `張り出しが ${overhang.toFixed(1)}m`);
});

test('ベンチは座面と背もたれで組む', () => {
  const shapes = benchShapes(AT, { ground: GROUND, headingDeg: 0 });
  assert.equal(shapes.length, 2);
  const seat = shapes[0];
  if (seat.kind !== 'box') return assert.fail('座面が箱でない');
  // JIS の公園用ベンチは座高 0.40m
  assert.ok(Math.abs((seat.centre.alt ?? 0) - GROUND - 0.4) < 0.01);
});

test('信号は車道の上へ灯器を張り出す', () => {
  // 柱だけだと遠目には棒が立っているだけで、信号と分からない
  const shapes = trafficSignalShapes(AT, { ground: GROUND, headingDeg: 0, kerbOffsetM: 5.1 });
  const pole = shapes.find((s): s is RevolvedShape => s.kind === 'revolved');
  const head = shapes.find((s) => s.id?.endsWith('#head'));
  assert.ok(pole && head?.kind === 'box');
  if (!pole || head?.kind !== 'box') return;

  // 灯器の下端は車道上 5.0m 以上
  const bottom = (head.centre.alt ?? 0) - head.size.z / 2 - GROUND;
  assert.ok(bottom >= 5.0 - 0.01, `灯器の下端が ${bottom.toFixed(2)}m`);
  // 柱から離れている（アームの先）
  assert.ok(metres(pole.base, head.centre) > 2);
  // 南北の道なら、アームは東西へ張り出す
  assert.ok(Math.abs(head.centre.lng - AT.lng) > Math.abs(head.centre.lat - AT.lat));

  // 柱は路肩に立ち、灯器は車道の上へ戻る。
  // OSM のノードは車道の中心線上にあるので、寄せないと道の真ん中に柱が生える
  assert.ok(metres(AT, pole.base) > 5, `柱が車道の中にある: ${metres(AT, pole.base).toFixed(1)}m`);
  assert.ok(metres(AT, head.centre) < 5, `灯器が車道の外にある: ${metres(AT, head.centre).toFixed(1)}m`);
});

test('路肩の寄せを指定しなければ、柱はノードの位置に立つ', () => {
  // 道の幅が分からないときに勝手に動かすと、実在しない位置になる
  const shapes = trafficSignalShapes(AT, { ground: GROUND, headingDeg: 0 });
  const pole = shapes.find((s): s is RevolvedShape => s.kind === 'revolved');
  assert.ok(pole);
  assert.ok(metres(AT, pole.base) < 0.01);
});

test('歩行者用灯器は求めたときだけ付ける', () => {
  const without = trafficSignalShapes(AT, { ground: GROUND }).length;
  const withPed = trafficSignalShapes(AT, { ground: GROUND, pedestrian: true }).length;
  assert.equal(withPed, without + 1);
});
