import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, toStructure, widthOf } from '../structures';

const way = (tags: Record<string, string>, points = 3) => ({
  type: 'way' as const,
  id: 123,
  tags,
  geometry: Array.from({ length: points }, (_, i) => ({ lat: 34.7 + i * 0.001, lon: 137.73 })),
});

test('橋でも高架でもないものは対象外', () => {
  assert.equal(classify({ highway: 'residential' }), null);
  assert.equal(classify({ highway: 'primary', layer: '0' }), null);
  assert.equal(classify({ highway: 'primary', bridge: 'no' }), null);
  // 地下は対象外（layer が負）
  assert.equal(classify({ highway: 'primary', layer: '-1' }), null);
});

test('鉄道の高架と橋を区別する', () => {
  // layer > 0 かつ bridge が無い = 高架
  assert.equal(classify({ railway: 'rail', layer: '1' }), 'rail-elevated');
  // bridge タグがあれば橋として扱う
  assert.equal(classify({ railway: 'rail', bridge: 'yes' }), 'rail-bridge');
  assert.equal(classify({ railway: 'rail', bridge: 'yes', layer: '1' }), 'rail-bridge');
  // 側線などは景観への寄与が小さいので除外する
  assert.equal(classify({ railway: 'siding', layer: '1' }), null);
});

test('道路は種別によって高架と橋を分ける', () => {
  assert.equal(classify({ highway: 'motorway', layer: '1' }), 'road-elevated');
  assert.equal(classify({ highway: 'motorway', bridge: 'yes' }), 'road-bridge');
  assert.equal(classify({ highway: 'primary', bridge: 'yes' }), 'road-bridge');
  assert.equal(classify({ highway: 'footway', bridge: 'yes' }), 'footbridge');
});

test('幅は実データを優先し、無ければ車線数から求める', () => {
  // width タグがあればそれを使う
  assert.equal(widthOf('road-bridge', { width: '14.5' }), 14.5);
  // 車線数から: 4 車線 × 3.25m + 路肩
  assert.equal(widthOf('road-bridge', { lanes: '4' }), 4 * 3.25 + 1.5);
  // 線路数から: 複線
  assert.equal(widthOf('rail-elevated', { tracks: '2' }), 9.5);
  // 情報が無ければ種別ごとの標準値
  assert.equal(widthOf('footbridge', {}), 3.5);
});

test('高い layer ほど桁下を高くする', () => {
  const l1 = toStructure(way({ railway: 'rail', layer: '1' }));
  const l3 = toStructure(way({ railway: 'rail', layer: '3' }));
  assert.ok(l1 && l3);
  assert.ok(l3.clearance > l1.clearance, 'layer が高いほど持ち上がるべき');
});

test('形状が 2 点未満のものは捨てる', () => {
  assert.equal(toStructure(way({ railway: 'rail', layer: '1' }, 1)), null);
  assert.ok(toStructure(way({ railway: 'rail', layer: '1' }, 2)));
});

test('OSM の形状をそのまま中心線として保持する', () => {
  const s = toStructure(way({ highway: 'motorway', layer: '2', lanes: '3' }, 5));
  assert.ok(s);
  assert.equal(s.path.length, 5, '形状を間引いたり補完したりしない');
  assert.equal(s.id, 'osm:way123');
  assert.equal(s.lanes, 3);
  assert.equal(s.kind, 'road-elevated');
});

test('一般道の橋には橋脚を立てない', () => {
  // 短い跨線橋に橋脚を並べると実物と違う見た目になる
  const bridge = toStructure(way({ highway: 'secondary', bridge: 'yes' }));
  assert.ok(bridge);
  assert.equal(bridge.pierSpacing, 0);

  // 高架は連続した橋脚で支えられている
  const elevated = toStructure(way({ railway: 'rail', layer: '1' }));
  assert.ok(elevated && elevated.pierSpacing > 0);
});
