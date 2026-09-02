import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBox } from '../types';
import { bboxAround, bboxIntersects, distanceMeters, parseBBoxParam } from '../geo';
import { CITIES, getCity } from '../cities';

test('bboxIntersects は重なりを正しく判定する', () => {
  const a: BBox = [139.7, 35.65, 139.8, 35.7];
  assert.equal(bboxIntersects(a, [139.75, 35.66, 139.85, 35.72]), true, '一部重なり');
  assert.equal(bboxIntersects(a, [139.72, 35.66, 139.75, 35.68]), true, '内包');
  assert.equal(bboxIntersects(a, [139.8, 35.7, 139.9, 35.8]), true, '角で接する');
  assert.equal(bboxIntersects(a, [139.81, 35.65, 139.9, 35.7]), false, '東に外れる');
  assert.equal(bboxIntersects(a, [139.7, 35.71, 139.8, 35.8]), false, '北に外れる');
});

test('bboxAround は指定した半径の範囲を作る', () => {
  const center = { lat: 35.681236, lng: 139.767125 };
  const bbox = bboxAround(center, 3000);

  // 中心から各辺までがおよそ 3km になっている
  const north = distanceMeters(center, { lat: bbox[3], lng: center.lng });
  const east = distanceMeters(center, { lat: center.lat, lng: bbox[2] });
  assert.ok(Math.abs(north - 3000) < 60, `北方向 ${north}m`);
  assert.ok(Math.abs(east - 3000) < 60, `東方向 ${east}m`);

  // 中心を含む
  assert.equal(bboxIntersects(bbox, [center.lng, center.lat, center.lng, center.lat]), true);
});

test('近景の読み込み範囲は都市 bbox より狭い', () => {
  // 起動時に都市全域を読まないことが前提（PLATEAU は市区町村単位で配信されるため、
  // 範囲を絞らないと東京都なら 62 市区町村ぶんの tileset を展開してしまう）
  const tokyo = getCity('tokyo');
  assert.ok(tokyo);
  const near = bboxAround(tokyo.center, 3000);
  const [cMinLng, cMinLat, cMaxLng, cMaxLat] = tokyo.bbox;
  const cityArea = (cMaxLng - cMinLng) * (cMaxLat - cMinLat);
  const nearArea = (near[2] - near[0]) * (near[3] - near[1]);
  assert.ok(nearArea < cityArea * 0.4, '近景の初期範囲が都市 bbox に対して広すぎる');
});

test('全都市の bbox は中心を含む', () => {
  for (const city of CITIES) {
    const [minLng, minLat, maxLng, maxLat] = city.bbox;
    assert.ok(
      city.center.lng >= minLng && city.center.lng <= maxLng,
      `${city.id}: 中心の経度が bbox の外`,
    );
    assert.ok(
      city.center.lat >= minLat && city.center.lat <= maxLat,
      `${city.id}: 中心の緯度が bbox の外`,
    );
  }
});

test('bbox のクエリを読むときに不正なものを弾く', () => {
  // 3 つの API（roads / structures / furniture）が同じ検証をしていたが、
  // furniture だけ抜けがあり、逆転した bbox や巨大な範囲を通していた。
  // 面積で「広すぎる」を見ていたため、逆転すると面積が負になってすり抜ける
  assert.deepEqual(parseBBoxParam('137.72,34.69,137.74,34.71'), [137.72, 34.69, 137.74, 34.71]);

  assert.equal(parseBBoxParam(null), null, '未指定');
  assert.equal(parseBBoxParam(''), null, '空文字');
  assert.equal(parseBBoxParam('abc'), null, '数値でない');
  assert.equal(parseBBoxParam('1,2,3'), null, '3 つしかない');
  assert.equal(parseBBoxParam('1,2,3,4,5'), null, '5 つある');
  assert.equal(parseBBoxParam('NaN,NaN,NaN,NaN'), null, 'NaN');

  // 地球上に存在しない座標
  assert.equal(parseBBoxParam('200,100,201,101'), null, '経度 200 度');
  assert.equal(parseBBoxParam('-181,0,-180,1'), null, '経度 -181 度');
  assert.equal(parseBBoxParam('0,-91,1,-90'), null, '緯度 -91 度');

  // 南西と北東が逆
  assert.equal(parseBBoxParam('137.74,34.71,137.72,34.69'), null, '完全に逆');
  assert.equal(parseBBoxParam('137.74,34.69,137.72,34.71'), null, '経度だけ逆');
  assert.equal(parseBBoxParam('137.72,34.71,137.74,34.69'), null, '緯度だけ逆');
  assert.equal(parseBBoxParam('137.72,34.69,137.72,34.71'), null, '幅が 0');
});

test('bbox の大きさに上限をかけられる', () => {
  const limits = { maxSpanLng: 0.04, maxSpanLat: 0.032 };
  assert.ok(parseBBoxParam('137.72,34.69,137.75,34.715', limits), '上限内');
  assert.equal(parseBBoxParam('137.72,34.69,137.78,34.715', limits), null, '東西が広すぎる');
  assert.equal(parseBBoxParam('137.72,34.69,137.75,34.75', limits), null, '南北が広すぎる');
  // 上限を渡さなければ大きさは見ない
  assert.ok(parseBBoxParam('100,20,150,45'), '上限なしなら通る');
});
