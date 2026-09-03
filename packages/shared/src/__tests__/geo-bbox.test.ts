import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBox } from '../types';
import {
  bboxAround,
  bboxIntersects,
  clampNumberParam,
  distanceMeters,
  parseBBoxParam,
  parseLatLngParam,
  readLatLng,
  parseNumberParam,
} from '../geo';
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

test('数値のクエリで「指定なし」と「0」を取り違えない', () => {
  // Number(null) は 0 になる。素朴に書くと、lat も lng も無い要求が
  // 「緯度 0・経度 0（大西洋）」として通ってしまう。実際に通っていた
  assert.equal(parseNumberParam(null), null, '未指定');
  assert.equal(parseNumberParam(''), null, '空文字');
  assert.equal(parseNumberParam('   '), null, '空白だけ');
  assert.equal(parseNumberParam('abc'), null, '数値でない');
  assert.equal(parseNumberParam('0'), 0, '0 は 0 として読む');
  assert.equal(parseNumberParam('-12.5'), -12.5);

  // 範囲の外は読めなかったものとして扱う
  assert.equal(parseNumberParam('91', { min: -90, max: 90 }), null);
  assert.equal(parseNumberParam('-91', { min: -90, max: 90 }), null);
  assert.equal(parseNumberParam('90', { min: -90, max: 90 }), 90, '端は含む');
});

test('半径や件数は範囲に丸める', () => {
  // Math.min(Number('abc'), 20) は NaN になる。件数が NaN のまま
  // 外部への問い合わせに渡っていた
  assert.equal(clampNumberParam(null, 500, 10, 3000), 500, '未指定なら既定値');
  assert.equal(clampNumberParam('abc', 500, 10, 3000), 500, '読めなければ既定値');
  assert.equal(clampNumberParam('-5', 500, 10, 3000), 10, '下限に丸める');
  assert.equal(clampNumberParam('99999999', 500, 10, 3000), 3000, '上限に丸める');
  assert.equal(clampNumberParam('300', 500, 10, 3000), 300);
});

test('緯度経度のクエリは地球上のものだけ受ける', () => {
  assert.deepEqual(parseLatLngParam('35.68', '139.76'), { lat: 35.68, lng: 139.76 });
  assert.equal(parseLatLngParam(null, null), null, '未指定');
  assert.equal(parseLatLngParam('35.68', null), null, '片方だけ');
  assert.equal(parseLatLngParam('999', '999'), null, '地球上に無い');
  assert.equal(parseLatLngParam('91', '139'), null, '緯度が範囲外');
  assert.equal(parseLatLngParam('35', '181'), null, '経度が範囲外');
  // 0,0 は大西洋上の実在する座標なので、値としては受ける
  assert.deepEqual(parseLatLngParam('0', '0'), { lat: 0, lng: 0 });
});

test('JSON 本文の座標は、型も形も確かめてから使う', () => {
  // クエリ文字列と違い、本文には配列も null も NaN も入ってくる。
  // そのまま外部への問い合わせに渡すと NaN を含む URL を組み立てて投げてしまう
  assert.deepEqual(readLatLng({ lat: 34.7048, lng: 137.7345 }), { lat: 34.7048, lng: 137.7345 });

  assert.equal(readLatLng(null), null, 'null');
  assert.equal(readLatLng(undefined), null, '未指定');
  assert.equal(readLatLng('34.7,137.7'), null, '文字列');
  assert.equal(readLatLng([34.7, 137.7]), null, '配列');
  assert.equal(readLatLng({ lat: '34.7', lng: '137.7' }), null, '数値でない');
  assert.equal(readLatLng({ lat: Number.NaN, lng: 137.7 }), null, 'NaN');
  assert.equal(readLatLng({ lat: 34.7, lng: Number.POSITIVE_INFINITY }), null, '無限大');
  assert.equal(readLatLng({ lat: 91, lng: 137.7 }), null, '緯度が範囲外');
  assert.equal(readLatLng({ lat: 34.7, lng: 181 }), null, '経度が範囲外');
  // 0,0（大西洋）は地球上の座標なので、ここでは通す。
  // 「指定が無い」ことと区別するのは呼び出し側の役目
  assert.deepEqual(readLatLng({ lat: 0, lng: 0 }), { lat: 0, lng: 0 });
});
