/**
 * 地理院タイルの定義の検証。
 *
 * 「縮小していくと日本地図が表示されない」という指摘の原因は、
 * minimumLevel を指定していなかったこと。
 *
 * 地理院タイルには **ズーム 0 と 1 が無い**。指定しないと Cesium は
 * ズーム 0 から読もうとして 404 になり、引いた状態で地球に何も
 * 貼られない。エラーも出ないので、画面が黒いことしか分からない。
 *
 * 実測（2026-09、cyberjapandata.gsi.go.jp）:
 *   z=0, z=1          … 全レイヤ 404
 *   z=2 以上          … seamlessphoto / std / pale は世界中で 200
 *                       （北米 5/7/12・欧州 5/16/10・豪州 5/28/18 で確認）
 *   blank             … 日本国内のみ 200。z=2〜4 と国外は 404
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_IMAGERY_ID,
  GSI_IMAGERY,
  JAPAN_BOUNDS,
  getImagery,
  tilesToCoverGlobe,
} from '../gsi';

test('すべてのレイヤがズーム 1 以下を要求しない', () => {
  for (const imagery of GSI_IMAGERY) {
    assert.ok(
      imagery.minimumLevel >= 2,
      `${imagery.id}: minimumLevel ${imagery.minimumLevel} ではズーム 0/1 を読みに行って 404 になる`,
    );
    assert.ok(
      imagery.minimumLevel < imagery.maximumLevel,
      `${imagery.id}: 最小と最大が逆転している`,
    );
  }
});

test('引いたときのタイル枚数が起動の負担にならない', () => {
  // minimumLevel を上げるほど全球を覆う枚数が増える（4^n 枚）。
  // ズーム 2 で 16 枚、5 で 1,024 枚。
  assert.equal(tilesToCoverGlobe(2), 16);
  assert.equal(tilesToCoverGlobe(5), 1024);

  // 既定のレイヤは 16 枚で覆えること。
  // 起動直後に 1,000 枚を読みに行くようでは、引いた瞬間に固まる
  const base = getImagery(DEFAULT_IMAGERY_ID);
  assert.ok(
    tilesToCoverGlobe(base.minimumLevel) <= 16,
    `既定の ${base.id} は ${tilesToCoverGlobe(base.minimumLevel)} 枚必要`,
  );
});

test('日本国内にしか無いレイヤは提供範囲を持つ', () => {
  // 白地図は国外が 404。範囲を区切らないと、世界を映したときに
  // 大量の 404 を出しながら何も描かれない
  const blank = getImagery('blank');
  assert.deepEqual(blank.coverage, JAPAN_BOUNDS);
  assert.equal(blank.minimumLevel, 5, '白地図はズーム 5 から');

  // 世界中で使えるレイヤには範囲を付けない（付けると国外が真っ黒になる）
  for (const id of ['seamlessphoto', 'std', 'pale']) {
    assert.equal(getImagery(id).coverage, undefined, `${id} は世界中で使える`);
  }
});

test('提供範囲は日本を覆う', () => {
  const [minLng, minLat, maxLng, maxLat] = JAPAN_BOUNDS;
  // 南西端（与那国島）と北東端（択捉島）が入っていること
  assert.ok(minLng < 123.0 && minLat < 24.5, '南西諸島が入っていない');
  assert.ok(maxLng > 148.8 && maxLat > 45.5, '北海道・北方領土が入っていない');
  // 浜松と東京は当然入る
  for (const [lng, lat, name] of [
    [137.7342, 34.7047, '浜松'],
    [139.7671, 35.6812, '東京'],
  ] as const) {
    assert.ok(
      lng > minLng && lng < maxLng && lat > minLat && lat < maxLat,
      `${name} が範囲の外`,
    );
  }
});

test('知らない ID を渡したら既定のレイヤを返す', () => {
  assert.equal(getImagery('存在しない').id, GSI_IMAGERY[0].id);
});
