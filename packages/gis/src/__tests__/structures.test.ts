import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBox } from '@ijm/shared';
import { classify, clipPathToBBox, toStructure, widthOf } from '../structures';

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
  // 線路数から。OSM の way は原則 1 本が線路 1 本なので、既定は単線ぶん。
  // 軌道中心から床版の縁まで 2.2m、軌道の間隔は 4.1m
  assert.equal(widthOf('rail-elevated', {}), 4.4);
  assert.equal(widthOf('rail-elevated', { tracks: '2' }), 8.5);
  // 情報が無ければ種別ごとの標準値
  assert.equal(widthOf('footbridge', {}), 3.5);
});

test('高い layer ほど路面を高くする', () => {
  const l1 = toStructure(way({ railway: 'rail', layer: '1' }));
  const l3 = toStructure(way({ railway: 'rail', layer: '3' }));
  assert.ok(l1 && l3);
  assert.ok(l3.deckHeight > l1.deckHeight, 'layer が高いほど持ち上がるべき');
});

test('同じ路線なら構造形式が変わっても路面の高さは同じ', () => {
  // 市街地はラーメン高架橋、川をまたぐ区間は桁橋になる。
  // 桁下を基準に高さを決めると、この境目で路面が段差になる
  const viaduct = toStructure(way({ railway: 'rail', layer: '1' }, 40));
  const bridge = toStructure(way({ railway: 'rail', bridge: 'yes' }));
  assert.ok(viaduct && bridge);
  assert.equal(viaduct.form, 'rigid-frame');
  assert.equal(bridge.form, 'girder');
  assert.equal(viaduct.deckHeight, bridge.deckHeight, '軌道面は連続していること');
  // 一方で桁の高さは形式ごとに違う（＝桁下は変わる）
  assert.notEqual(viaduct.girderDepth, bridge.girderDepth);
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

test('鉄道高架はラーメン高架橋の実寸で組む', () => {
  const s = toStructure(way({ railway: 'rail', layer: '1' }));
  assert.ok(s);
  assert.equal(s.form, 'rigid-frame', '都市部の鉄道高架はラーメン高架橋');

  // 径間 8.6〜8.9m。ここが長すぎると柱がまばらになり、
  // ラーメン高架橋には見えなくなる（以前は 22m にしていた）
  assert.ok(s.pierSpacing >= 8 && s.pierSpacing <= 9.5, `径間 ${s.pierSpacing}m は実物と違う`);

  // 縦梁の高さは径間の 1/8〜1/9
  const ratio = s.pierSpacing / s.girderDepth;
  assert.ok(ratio >= 7 && ratio <= 10, `縦梁が径間の 1/${ratio.toFixed(1)} は実物と違う`);

  // 梁下高 8.0〜8.5m。路面から版と梁を引いた高さ
  const beamBottom = s.deckHeight - s.deckThickness - s.girderDepth;
  assert.ok(beamBottom >= 8 && beamBottom <= 8.5, `梁下 ${beamBottom.toFixed(2)}m`);

  // 防音壁は高欄より高い
  const road = toStructure(way({ highway: 'motorway', layer: '1' }));
  assert.ok(road && s.parapetHeight > road.parapetHeight);
});

test('桁橋の桁高は支間長の 1/16〜1/20 に収まる', () => {
  const cases: Record<string, string>[] = [
    { railway: 'rail', bridge: 'yes' },
    { highway: 'motorway', layer: '1' },
    { highway: 'primary', bridge: 'yes' },
  ];
  for (const tags of cases) {
    const s = toStructure(way(tags));
    assert.ok(s);
    assert.equal(s.form, 'girder', `${JSON.stringify(tags)} は桁橋`);
    // pierSpacing が 0（橋脚を立てない短い橋）でも桁高は支間相当で決める
    const span = s.pierSpacing > 0 ? s.pierSpacing : 30;
    const ratio = span / s.girderDepth;
    assert.ok(ratio >= 15 && ratio <= 22, `桁高が支間の 1/${ratio.toFixed(1)} は実物と違う`);
  }
});

test('歩道橋は桁を持たない薄い床版', () => {
  const s = toStructure(way({ highway: 'footway', bridge: 'yes' }));
  assert.ok(s);
  assert.equal(s.form, 'slab');
  assert.equal(s.girderDepth, 0);
  // 柱は細い
  assert.ok(s.pierSize < 1);
});

test('高い高架ほど柱を太くする', () => {
  // 高さ 10m を超えるラーメン高架橋は柱の中間につなぎ梁が入る。
  // 細長い柱のままだと拡大したときに頼りなく見える
  const low = toStructure(way({ railway: 'rail', layer: '1' }));
  const high = toStructure(way({ railway: 'rail', layer: '3' }));
  assert.ok(low && high);
  assert.ok(high.deckHeight > 12);
  assert.ok(high.pierSize > low.pierSize);
});

test('長く続く鉄道の橋はラーメン高架橋として扱う', () => {
  // 浜松の実データ: 東海道本線 1,776m / 東海道新幹線 1,374m が
  // どちらも bridge=yes + layer=1 の 1 本の way で入っている。
  // これを支間 30m の桁橋として組むと、実物とまるで違う見た目になる
  assert.equal(classify({ railway: 'rail', bridge: 'yes', layer: '1' }, 1776), 'rail-elevated');
  // 川をまたぐ程度の長さなら桁橋のまま
  assert.equal(classify({ railway: 'rail', bridge: 'yes', layer: '1' }, 120), 'rail-bridge');
  // viaduct と明記されていれば長さによらず高架
  assert.equal(classify({ railway: 'rail', bridge: 'viaduct' }, 60), 'rail-elevated');
  // 道路で高架として扱うのは自動車専用道路だけ。
  // 一般道は長い橋でも路面の高さが桁橋と変わらないので、ここを広げると
  // 普通の橋との接続部が段差になる
  assert.equal(classify({ highway: 'motorway', bridge: 'yes', layer: '1' }, 900), 'road-elevated');
  assert.equal(classify({ highway: 'primary', bridge: 'yes', layer: '1' }, 900), 'road-bridge');
  assert.equal(classify({ highway: 'primary', bridge: 'yes', layer: '1' }, 90), 'road-bridge');
});

test('表示範囲の外へ伸びた経路を切り落とす', () => {
  const bbox: BBox = [137.73, 34.7, 137.74, 34.71];
  // 範囲をまたいで東西に伸びる経路（マージンは約 250m = 0.0023 度）
  const path = [
    { lat: 34.705, lng: 137.7 },
    { lat: 34.705, lng: 137.72 },
    { lat: 34.705, lng: 137.735 },
    { lat: 34.705, lng: 137.75 },
    { lat: 34.705, lng: 137.77 },
  ];
  const runs = clipPathToBBox(path, bbox);
  assert.equal(runs.length, 1);
  // 範囲内の点に加えて、出入りの直前・直後の点も残る（切り口を隠すため）
  assert.deepEqual(
    runs[0].map((p) => p.lng),
    [137.72, 137.735, 137.75],
  );

  // 範囲を出て再び入る経路は区間に分かれる
  const zigzag = [
    { lat: 34.705, lng: 137.735 },
    { lat: 34.8, lng: 137.735 },
    { lat: 34.706, lng: 137.736 },
  ];
  assert.equal(clipPathToBBox(zigzag, bbox).length, 2);

  // まるごと範囲内なら何も変わらない
  const inside = [
    { lat: 34.702, lng: 137.732 },
    { lat: 34.708, lng: 137.738 },
  ];
  assert.deepEqual(clipPathToBBox(inside, bbox), [inside]);

  // まるごと範囲外なら何も返さない
  assert.deepEqual(
    clipPathToBBox(
      [
        { lat: 35.5, lng: 139.7 },
        { lat: 35.6, lng: 139.8 },
      ],
      bbox,
    ),
    [],
  );
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
