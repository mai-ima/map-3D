/**
 * 形の記述を Cesium の描き方に振り分けるところの検証。
 *
 * ここを間違えると「区画線が面として描かれて遠くで消える」
 * 「横断歩道が 1 本の帯になって縞にならない」といったことが起きるが、
 * どれも実際に走らせて近づかないと気づけない。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LatLng, SceneShape } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import { batchShapes, dashPath } from '../scene-renderer';

const BASE = { lat: 34.7047, lng: 137.7342 };
const M_PER_DEG_LAT = 111_320;

/** 真東へ伸びる直線 */
function eastLine(lengthM: number, points = 2): LatLng[] {
  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  return Array.from({ length: points }, (_, i) => ({
    lat: BASE.lat,
    lng: BASE.lng + (i * lengthM) / (points - 1) / (M_PER_DEG_LAT * cos),
  }));
}

test('舗装は面、区画線は線として描く', () => {
  // 舗装 13m と、その上の中央線 0.15m
  const shapes: SceneShape[] = [
    { kind: 'ribbon', path: eastLine(100), width: 13, color: '#525255', order: 0 },
    { kind: 'ribbon', path: eastLine(100), width: 0.15, color: '#e8e4d8', order: 3 },
  ];
  const batches = batchShapes(shapes);

  // 舗装だけが面。0.15m の線を面で描くと、少し離れただけで 1 画素を割って消える
  assert.equal([...batches.corridors.values()].flat().length, 1, '面は舗装だけ');
  assert.equal(batches.lines.length, 1, '区画線は線');
  assert.equal(batches.dashed.length, 0);
});

test('面は重なり順ごとに分けてまとめる', () => {
  const shapes: SceneShape[] = [
    { kind: 'ribbon', path: eastLine(100), width: 13, color: '#525255', order: 0 },
    { kind: 'ribbon', path: eastLine(80), width: 9, color: '#525255', order: 0 },
    { kind: 'ribbon', path: eastLine(6), width: 4, color: '#d8d5cf', order: 4 },
  ];
  const batches = batchShapes(shapes);

  // 同じ order のものは 1 つのまとまりに入る（描画呼び出しを増やさない）
  assert.equal(batches.corridors.get(0)?.length, 2);
  assert.equal(batches.corridors.get(4)?.length, 1);
});

test('細い破線は線のまとまりに入れる', () => {
  const shapes: SceneShape[] = [
    {
      kind: 'ribbon',
      path: eastLine(100),
      width: 0.15,
      color: '#dcd9d0',
      dash: [8, 12],
      order: 2,
    },
  ];
  const batches = batchShapes(shapes);
  assert.equal(batches.dashed.length, 1);
  assert.equal(batches.lines.length, 0);
});

test('横断歩道は実寸の縞に切り分ける', () => {
  // 幅 4m・長さ 9m の横断歩道。45cm の白帯を 45cm 間隔で並べる
  const shapes: SceneShape[] = [
    {
      kind: 'ribbon',
      path: eastLine(9),
      width: 4,
      color: '#d8d5cf',
      dash: [0.45, 0.45],
      order: 4,
    },
  ];
  const batches = batchShapes(shapes);
  // 9m を 0.9m 周期で刻むので 10 本
  assert.equal(batches.corridors.get(4)?.length, 10, '縞の本数');
  assert.equal(batches.dashed.length, 0, '太い破線は線にしない');
});

test('立体は影を落とすかどうかで分ける', () => {
  const shapes: SceneShape[] = [
    // 線路の道床（影を落とす）
    {
      kind: 'extrusion',
      path: eastLine(50).map((p) => ({ ...p, alt: 10 })),
      section: [
        { x: -2.2, y: 0 },
        { x: 2.2, y: 0 },
        { x: 1.5, y: 0.4 },
        { x: -1.5, y: 0.4 },
      ],
      color: '#6e6a63',
    },
    // レール（影を落とさない。細すぎて影が意味を持たない）
    {
      kind: 'extrusion',
      path: eastLine(50).map((p) => ({ ...p, alt: 10.4 })),
      section: [
        { x: -0.035, y: 0 },
        { x: 0.035, y: 0 },
        { x: 0.035, y: 0.15 },
        { x: -0.035, y: 0.15 },
      ],
      color: '#8a8073',
      castsShadow: false,
    },
    // 信号の柱
    {
      kind: 'box',
      centre: { ...BASE, alt: 12.5 },
      headingDeg: 0,
      size: { x: 0.14, y: 0.14, z: 5 },
      color: '#5a5f63',
    },
  ];
  const batches = batchShapes(shapes);
  assert.equal(batches.solids.length, 2, '道床と柱');
  assert.equal(batches.flatSolids.length, 1, 'レール');
});

test('点が 1 つしかない経路や、同じ点が続く経路は捨てる', () => {
  const single: LatLng[] = [BASE];
  const repeated: LatLng[] = [BASE, BASE, BASE];
  const batches = batchShapes([
    { kind: 'ribbon', path: single, width: 8, color: '#525255' },
    { kind: 'ribbon', path: repeated, width: 8, color: '#525255' },
    { kind: 'ribbon', path: repeated, width: 0.15, color: '#e8e4d8' },
  ]);
  assert.equal([...batches.corridors.values()].flat().length, 0);
  assert.equal(batches.lines.length, 0);
});

test('dashPath は指定した長さで刻む', () => {
  // 10m の線を 2m 引いて 2m 空ける
  const pieces = dashPath(eastLine(10), 2, 2);
  assert.equal(pieces.length, 3, '2m の線が 3 本（0-2, 4-6, 8-10）');

  for (const piece of pieces) {
    let total = 0;
    for (let i = 0; i < piece.length - 1; i += 1) {
      total += distanceMeters(piece[i], piece[i + 1]);
    }
    assert.ok(Math.abs(total - 2) < 0.05, `1 本の長さ ${total.toFixed(2)}m`);
  }
});

test('dashPath は折れ線でも距離で刻む', () => {
  // 曲がっていても、頂点をまたいで同じ長さで刻めること。
  // 区間ごとに刻み直すと、頂点のたびに縞がずれる
  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  const bent: LatLng[] = [
    BASE,
    { lat: BASE.lat, lng: BASE.lng + 3 / (M_PER_DEG_LAT * cos) },
    { lat: BASE.lat + 3 / M_PER_DEG_LAT, lng: BASE.lng + 3 / (M_PER_DEG_LAT * cos) },
  ];
  const pieces = dashPath(bent, 2, 2);
  // 全長 6m を 4m 周期で刻むので、0-2m と 4-6m の 2 本
  assert.equal(pieces.length, 2);
});

test('dashPath は本数の上限で打ち切る', () => {
  // 上限が無いと、長い道に 0.45m 刻みで数千個できてしまう
  const pieces = dashPath(eastLine(1000), 0.45, 0.45, 40);
  assert.ok(pieces.length <= 40, `${pieces.length} 本`);
});
