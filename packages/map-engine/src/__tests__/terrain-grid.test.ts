/**
 * 地表の高さの格子と補間の検証。
 *
 * 線路の道床がこの高さに載る。最近傍で返すと 100m ごとに
 * 階段状の継ぎ目ができるので、双線形で補間できていることを確かめる。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import type { BBox } from '@ijm/shared';
import { TerrainHeights } from '../terrain-grid';

const BBOX: BBox = [137.73, 34.7, 137.74, 34.71];

test('地形が無いときはすべて 0 を返す', async () => {
  const heights = await TerrainHeights.sample(new Cesium.EllipsoidTerrainProvider(), BBOX);
  assert.equal(heights.at({ lat: 34.705, lng: 137.735 }), 0);
});

test('terrainProvider を渡さなくても落ちない', async () => {
  const heights = await TerrainHeights.sample(undefined, BBOX);
  assert.equal(heights.at({ lat: 34.705, lng: 137.735 }), 0);
});

/**
 * 標高の比較は 1mm まで見れば十分。
 *
 * 緯度経度の引き算は 2 進小数で割り切れないので、
 * 格子点ちょうどを指しても最後の桁がずれる（34.71 - 34.7 が
 * 0.00999999999999801 になる）。厳密な一致で測る意味は無い。
 */
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `${label}: ${actual} は ${expected} と違う`);

test('格子の 4 点から双線形に補間する', () => {
  // 2×2 の格子を直接作り、補間だけを検証する。
  // 実際の地形取得はネットワークに依存するので、ここでは切り離す
  const grid = makeGrid([137.73, 34.7], 0.01, 0.01, 2, 2, [0, 10, 20, 30]);

  // 格子点そのもの
  near(grid.at({ lng: 137.73, lat: 34.7 }), 0, '南西');
  near(grid.at({ lng: 137.74, lat: 34.7 }), 10, '南東');
  near(grid.at({ lng: 137.73, lat: 34.71 }), 20, '北西');
  near(grid.at({ lng: 137.74, lat: 34.71 }), 30, '北東');

  // 中央は 4 点の平均
  near(grid.at({ lng: 137.735, lat: 34.705 }), 15, '中央');
  // 東西方向だけ半分進んだところ
  near(grid.at({ lng: 137.735, lat: 34.7 }), 5, '南辺の中央');

  // 段差ではなく、連続して変わること。
  // 最近傍だと 0 → 10 が階段状に飛ぶ
  const a = grid.at({ lng: 137.7325, lat: 34.7 });
  const b = grid.at({ lng: 137.7375, lat: 34.7 });
  assert.ok(a > 0 && a < 5, `1/4 地点 ${a}`);
  assert.ok(b > 5 && b < 10, `3/4 地点 ${b}`);
});

test('範囲の外は端の値を使う', () => {
  const grid = makeGrid([137.73, 34.7], 0.01, 0.01, 2, 2, [0, 10, 20, 30]);
  // 西や南へはみ出しても、いちばん近い端の値になる（外挿はしない）
  near(grid.at({ lng: 137.72, lat: 34.7 }), 0, '西へはみ出す');
  near(grid.at({ lng: 137.75, lat: 34.71 }), 30, '東へはみ出す');
});

/**
 * 検証用に格子を直接組み立てる。
 *
 * TerrainHeights の構築子は非公開（取得の経路をひとつに保つため）なので、
 * 同じ形のオブジェクトを作って補間だけを見る。
 */
function makeGrid(
  origin: [number, number],
  stepLng: number,
  stepLat: number,
  cols: number,
  rows: number,
  values: number[],
): TerrainHeights {
  const grid = Object.create(TerrainHeights.prototype) as TerrainHeights;
  Object.assign(grid, {
    minLng: origin[0],
    minLat: origin[1],
    stepLng,
    stepLat,
    cols,
    rows,
    values: Float64Array.from(values),
  });
  return grid;
}
