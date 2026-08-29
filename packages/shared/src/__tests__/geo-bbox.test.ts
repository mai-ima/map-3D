import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBox } from '../types';
import { bboxAround, bboxIntersects, distanceMeters } from '../geo';
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
