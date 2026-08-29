import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  guessPlaneZone,
  latLngToPlane,
  planeToLatLng,
  PLANE_ORIGINS,
} from '../coords';
import { distanceMeters, projectOnPolyline, cumulativeDistances, angleDelta, lerpAngle } from '../geo';
import { decodePolyline, encodePolyline } from '../polyline';

test('平面直角座標系: 原点は (0, 0) になる', () => {
  const origin = PLANE_ORIGINS[8]; // IX 系（東京）
  const xy = latLngToPlane({ lat: origin.lat, lng: origin.lng }, 9);
  assert.ok(Math.abs(xy.x) < 0.001, `x=${xy.x}`);
  assert.ok(Math.abs(xy.y) < 0.001, `y=${xy.y}`);
});

test('平面直角座標系: 往復変換で元の緯度経度に戻る（1cm 未満）', () => {
  const points = [
    { lat: 35.681236, lng: 139.767125 }, // 東京駅
    { lat: 34.7025, lng: 135.4959 }, // 梅田
    { lat: 43.0686, lng: 141.3508 }, // 札幌駅
    { lat: 26.2124, lng: 127.6809 }, // 那覇
  ];

  for (const p of points) {
    const zone = guessPlaneZone(p);
    const xy = latLngToPlane(p, zone);
    const back = planeToLatLng(xy);
    const error = distanceMeters(p, back);
    assert.ok(error < 0.01, `zone=${zone} 誤差 ${error.toFixed(4)}m`);
  }
});

test('平面直角座標系: 東京駅は IX 系で妥当な範囲に入る', () => {
  // 東京駅は IX 系原点(北緯36度, 東経139度50分)の南東側
  const xy = latLngToPlane({ lat: 35.681236, lng: 139.767125 }, 9);
  assert.ok(xy.x < 0, 'x（北方向）は原点より南なので負');
  assert.ok(xy.y < 0, 'y（東方向）は原点より西なので負');
  assert.ok(Math.abs(xy.x) < 40000, `x=${xy.x}`);
  assert.ok(Math.abs(xy.y) < 10000, `y=${xy.y}`);
});

test('系番号の推定: 主要都市が正しい系になる', () => {
  assert.equal(guessPlaneZone({ lat: 35.681236, lng: 139.767125 }), 9); // 東京
  assert.equal(guessPlaneZone({ lat: 34.7025, lng: 135.4959 }), 6); // 大阪
  assert.equal(guessPlaneZone({ lat: 43.0686, lng: 141.3508 }), 11); // 札幌
});

test('polyline6: エンコードとデコードが往復する', () => {
  const coords: [number, number][] = [
    [139.767125, 35.681236],
    [139.765057, 35.671989],
    [139.701636, 35.658034],
  ];
  const decoded = decodePolyline(encodePolyline(coords, 6), 6);
  assert.equal(decoded.length, coords.length);
  for (const [i, c] of coords.entries()) {
    assert.ok(Math.abs(decoded[i][0] - c[0]) < 1e-5);
    assert.ok(Math.abs(decoded[i][1] - c[1]) < 1e-5);
  }
});

test('距離計算: 東京駅〜銀座はおよそ 1.0km', () => {
  const d = distanceMeters({ lat: 35.681236, lng: 139.767125 }, { lat: 35.671989, lng: 139.765057 });
  assert.ok(d > 900 && d < 1200, `${d}m`);
});

test('折れ線への投影: 線分上の最近傍点を返す', () => {
  const coords: [number, number][] = [
    [139.76, 35.68],
    [139.77, 35.68],
  ];
  const cumulative = cumulativeDistances(coords);
  const result = projectOnPolyline({ lat: 35.681, lng: 139.765 }, coords, cumulative);
  assert.equal(result.segmentIndex, 0);
  assert.ok(Math.abs(result.point.lng - 139.765) < 1e-4);
  assert.ok(result.distance > 50 && result.distance < 200, `${result.distance}m`);
  assert.ok(result.distanceAlong > 0 && result.distanceAlong < cumulative[1]);
});

test('方位の補間: 0/360 の境界を最短方向で回る', () => {
  assert.equal(angleDelta(350, 10), 20);
  assert.equal(angleDelta(10, 350), -20);
  const mid = lerpAngle(350, 10, 0.5);
  assert.ok(Math.abs(mid - 0) < 1e-9 || Math.abs(mid - 360) < 1e-9, `mid=${mid}`);
});
