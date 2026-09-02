/**
 * OSM の way を実際の構造物の単位にまとめる処理の検証。
 *
 * 浜松の実測（2026-08）が出発点:
 *   東海道新幹線 15 本 / 東海道本線 8 本の way に分かれており、
 *   上下線の中心線間隔は 3.8〜4.3m。
 *   そのまま 1 本ずつ橋にすると 110 組の床版が重なっていた。
 *   一方、東海道本線と東海道新幹線の高架は 13.2m 離れた別の構造物なので、
 *   これはまとめてはいけない。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElevatedStructure, LatLng } from '@ijm/shared';
import { consolidateStructures, mergeParallel, stitchStructures } from '../structure-merge';

const BASE = { lat: 34.7047, lng: 137.7342 };
const M = 111_320;
const COS = Math.cos((BASE.lat * Math.PI) / 180);

/** 東へ伸びる直線。offsetNorth は北へのずれ (m) */
function line(offsetNorth: number, fromM: number, toM: number, points = 6): LatLng[] {
  return Array.from({ length: points }, (_, i) => ({
    lat: BASE.lat + offsetNorth / M,
    lng: BASE.lng + (fromM + ((toM - fromM) * i) / (points - 1)) / (M * COS),
  }));
}

function rail(id: string, path: LatLng[], over: Partial<ElevatedStructure> = {}): ElevatedStructure {
  return {
    id,
    kind: 'rail-elevated',
    form: 'rigid-frame',
    path,
    width: 4.4,
    layer: 1,
    deckThickness: 0.35,
    girderDepth: 1.0,
    deckHeight: 9.35,
    pierSpacing: 8.9,
    pierSize: 0.9,
    parapetHeight: 2.0,
    ...over,
  };
}

/** 2 本の中心線の距離 (m)。まとめ結果の位置を確かめる */
const northOf = (s: ElevatedStructure): number => (s.path[0].lat - BASE.lat) * M;

test('平行に走る複線を 1 本の高架にまとめる', () => {
  // 新幹線の上下線に相当。間隔 4.0m
  const merged = mergeParallel([
    rail('up', line(0, 0, 400)),
    rail('down', line(4, 0, 400)),
  ]);

  assert.equal(merged.length, 1, '2 本の way が 1 つの構造物になる');
  const s = merged[0];
  // 幅 = 軌道の広がり 4.0m + 縁までの余裕 2.2m × 2
  assert.ok(Math.abs(s.width - (4 + 4.4)) < 0.3, `幅 ${s.width.toFixed(2)}m`);
  // 中心線は 2 本の真ん中に来る
  assert.ok(Math.abs(northOf(s) - 2) < 0.3, `中心 ${northOf(s).toFixed(2)}m`);
  assert.equal(s.tracks, 2);
  assert.deepEqual(s.sourceIds?.sort(), ['down', 'up']);
});

test('離れて走る別の路線はまとめない', () => {
  // 浜松の東海道本線と東海道新幹線は 13.2m 離れた別の構造物
  const merged = mergeParallel([
    rail('honsen', line(0, 0, 400)),
    rail('shinkansen', line(13.2, 0, 400)),
  ]);
  assert.equal(merged.length, 2, '別々の高架のまま');
});

test('隣り合う軌道が続けば 3 線・4 線もまとまる', () => {
  const merged = mergeParallel([
    rail('t1', line(0, 0, 400)),
    rail('t2', line(4, 0, 400)),
    rail('t3', line(8, 0, 400)),
    rail('t4', line(12, 0, 400)),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tracks, 4);
  assert.ok(Math.abs(merged[0].width - (12 + 4.4)) < 0.3);
  assert.ok(Math.abs(northOf(merged[0]) - 6) < 0.3, '中心は 4 線の真ん中');
});

test('広がりすぎる束は横に切り分ける', () => {
  // 駅構内のように軌道が扇状に広がると、順につながって
  // ありえない幅の 1 枚板になってしまう。
  // 丸ごと諦めると重なりが戻るので、横に並んだ順で切り分ける
  const wide = Array.from({ length: 12 }, (_, i) => rail(`t${i}`, line(i * 4, 0, 400)));
  const merged = mergeParallel(wide);

  assert.ok(merged.length > 1, '巨大な 1 枚板を作らない');
  assert.ok(merged.length < wide.length, 'まとめられるところはまとめる');
  for (const s of merged) {
    assert.ok(s.width <= 26, `幅 ${s.width.toFixed(1)}m は上限を超えている`);
  }
  // すべての way がどれかに含まれている（取りこぼさない）
  const covered = merged.flatMap((s) => s.sourceIds ?? [s.id]);
  assert.equal(new Set(covered).size, wide.length);
});

test('道路橋に併設された歩道は同じ床版にまとめる', () => {
  // OSM では別の way だが、実物では同じ橋の上にある。
  // 別々に建てると橋が二重に見える（浜松では残っていた重なりの大半がこれ）
  const road = rail('road', line(0, 0, 120), {
    kind: 'road-bridge',
    form: 'girder',
    width: 9,
    deckHeight: 4.65,
    girderDepth: 1.4,
    parapetHeight: 1.0,
  });
  const walk = rail('walk', line(5.7, 0, 120), {
    kind: 'footbridge',
    form: 'slab',
    width: 3.5,
    deckHeight: 5.45,
    girderDepth: 0,
    parapetHeight: 1.2,
  });
  const merged = mergeParallel([road, walk]);

  assert.equal(merged.length, 1);
  // 造りは道路橋のまま（歩道の造りに引きずられない）
  assert.equal(merged[0].kind, 'road-bridge');
  assert.equal(merged[0].form, 'girder');
  // 床版は歩道ぶん広がる
  assert.ok(merged[0].width > 9, `幅 ${merged[0].width.toFixed(1)}m`);
});

test('高さが違う道路と歩道はまとめない', () => {
  // 高架道路の下をくぐる歩道橋など、別々の構造物
  const expressway = rail('exp', line(0, 0, 400), {
    kind: 'road-elevated',
    form: 'girder',
    width: 9,
    deckHeight: 8.9,
  });
  const walk = rail('walk', line(5, 0, 400), {
    kind: 'footbridge',
    form: 'slab',
    width: 3.5,
    deckHeight: 5.45,
  });
  assert.equal(mergeParallel([expressway, walk]).length, 2);
});

test('向きが違えば近くてもまとめない', () => {
  // 交差する線路。近づく点はあるが別の構造物
  const crossing = rail('cross', [
    { lat: BASE.lat - 200 / M, lng: BASE.lng + 200 / (M * COS) },
    { lat: BASE.lat + 200 / M, lng: BASE.lng + 200 / (M * COS) },
  ]);
  const merged = mergeParallel([rail('main', line(0, 0, 400)), crossing]);
  assert.equal(merged.length, 2);
});

test('種別や上下関係が違うものはまとめない', () => {
  const merged = mergeParallel([
    rail('rail', line(0, 0, 400)),
    rail('road', line(4, 0, 400), { kind: 'road-bridge', form: 'girder' }),
    rail('upper', line(8, 0, 400), { layer: 2 }),
  ]);
  assert.equal(merged.length, 3);
});

test('端点でつながる way を 1 本の線につなぐ', () => {
  // 区間ごとに別々の縦断勾配を引くと接続部が段差になる
  const a = rail('a', line(0, 0, 300), { name: '東海道本線' });
  const b = rail('b', line(0, 300, 700), { name: '東海道本線' });
  const stitched = stitchStructures([a, b]);

  assert.equal(stitched.length, 1);
  const path = stitched[0].path;
  // 端点が重複せずにつながっている
  assert.equal(path.length, a.path.length + b.path.length - 1);
  assert.ok(path[0].lng < path[path.length - 1].lng, '東へ向かう 1 本の線');
  assert.deepEqual(stitched[0].sourceIds?.sort(), ['a', 'b']);
});

test('向きが逆でもつなぐ', () => {
  const a = rail('a', line(0, 0, 300), { name: '線' });
  const reversed = rail('b', [...line(0, 300, 700)].reverse(), { name: '線' });
  assert.equal(stitchStructures([a, reversed]).length, 1);
});

test('名前や造りが違う way はつながない', () => {
  const a = rail('a', line(0, 0, 300), { name: '東海道本線' });
  const b = rail('b', line(0, 300, 700), { name: '東海道新幹線' });
  assert.equal(stitchStructures([a, b]).length, 2);
});

test('離れている way はつながない', () => {
  const a = rail('a', line(0, 0, 300));
  const b = rail('b', line(0, 320, 700));
  assert.equal(stitchStructures([a, b]).length, 2);
});

test('縦につないでから横にまとめる', () => {
  // 上下線がそれぞれ 2 区間に分かれている、という実データによくある形
  const list = [
    rail('up-1', line(0, 0, 300), { name: '本線' }),
    rail('up-2', line(0, 300, 700), { name: '本線' }),
    rail('down-1', line(4, 0, 300), { name: '本線' }),
    rail('down-2', line(4, 300, 700), { name: '本線' }),
  ];
  const result = consolidateStructures(list);
  assert.equal(result.length, 1, '4 本の way が 1 つの高架になる');
  assert.equal(result[0].sourceIds?.length, 4);
  assert.ok(Math.abs(result[0].width - 8.4) < 0.3);
});

test('まとめる相手がいなければそのまま返す', () => {
  const only = [rail('a', line(0, 0, 400))];
  assert.deepEqual(consolidateStructures(only), only);
  assert.deepEqual(consolidateStructures([]), []);
});

test('線にならない構造物が混ざっても落ちない', () => {
  // 端点を読むところで落ちていた。toStructure は 2 点未満を弾くが、
  // 呼び出し経路が増えたときに壊れないよう、ここでも外しておく
  const good: ElevatedStructure = {
    id: 'good',
    kind: 'rail-elevated',
    form: 'rigid-frame',
    path: [
      { lat: 34.7, lng: 137.73 },
      { lat: 34.7, lng: 137.74 },
    ],
    width: 11,
    layer: 1,
    deckThickness: 0.35,
    girderDepth: 1,
    deckHeight: 9.35,
    pierSpacing: 8.9,
    pierSize: 0.9,
    parapetHeight: 2,
  };
  const out = consolidateStructures([
    { ...good, id: 'empty', path: [] },
    { ...good, id: 'single', path: [{ lat: 34.7, lng: 137.73 }] },
    good,
  ]);
  assert.equal(out.length, 1, '線になるものだけが残る');
  assert.equal(out[0].id, 'good');
});
