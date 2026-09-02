import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BBox } from '@ijm/shared';
import { alignDeckHeights } from '../structure-merge';
import { classify, clipPathToBBox, toStructure, widthOf } from '../structures';

/** 20m ほどの短い橋（浜松の道路橋の長さ中央値は 10m） */
const shortWay = (tags: Record<string, string>) => ({
  type: 'way' as const,
  id: 124,
  tags,
  geometry: [
    { lat: 34.7, lon: 137.73 },
    { lat: 34.70018, lon: 137.73 },
  ],
});

const way = (tags: Record<string, string>, points = 3) => ({
  type: 'way' as const,
  id: 123,
  tags,
  geometry: Array.from({ length: points }, (_, i) => ({ lat: 34.7 + i * 0.001, lon: 137.73 })),
});

/**
 * 444m の長い way（5 点 × 111m）。
 *
 * bridge が付いていない構造物を高架として扱うには、
 * VIADUCT_MIN_LENGTH_M（250m）以上の長さが要る。
 * layer が付いているだけの短い way は、交差部の上下関係を
 * 表しているだけかもしれないので高架にしない。
 */
const longWay = (tags: Record<string, string>) => way(tags, 5);

test('橋でも高架でもないものは対象外', () => {
  assert.equal(classify({ highway: 'residential' }), null);
  assert.equal(classify({ highway: 'primary', layer: '0' }), null);
  assert.equal(classify({ highway: 'primary', bridge: 'no' }), null);
  // 地下は対象外（layer が負）
  assert.equal(classify({ highway: 'primary', layer: '-1' }), null);
});

test('layer が付いているだけのものは高架にしない', () => {
  // OSM の layer は「交差する相手との上下関係」であって、
  // 地面から浮いていることの根拠ではない。地上の線路が道路と
  // 交差するところにも、建物の中を通る通路にも付く。
  //
  // layer だけで判定していたときの実測（2026-09、東京駅周辺 4km 四方）:
  //   駅構内の階段や通路を歩道橋にしていた   162 本（9m の階段など）
  //   線路の交差部だけを高架にしていた        40 本（最短 8m）
  assert.equal(classify({ highway: 'steps', layer: '1' }, 9), null, '9m の階段');
  assert.equal(classify({ highway: 'footway', layer: '1' }, 20), null, '20m の通路');
  assert.equal(classify({ railway: 'rail', layer: '1' }, 8), null, '8m の交差部');
  assert.equal(classify({ highway: 'residential', layer: '1' }, 30), null, '生活道路');

  // bridge が付いていれば、短くても橋として建てる
  assert.equal(classify({ highway: 'steps', bridge: 'yes' }, 9), 'footbridge');
  assert.equal(classify({ railway: 'rail', bridge: 'yes' }, 8), 'rail-bridge');
});

test('トンネル・屋内のものは高架にしない', () => {
  // tunnel が付いているのに layer > 0 のことがある（人工地盤の下など）。
  // 実測では、こうしたものを 92 本ぶん高架として建てていた
  assert.equal(classify({ highway: 'footway', tunnel: 'yes', layer: '2' }, 400), null);
  assert.equal(
    classify({ highway: 'footway', tunnel: 'building_passage', layer: '1' }, 400),
    null,
    '建物を貫く通路',
  );
  assert.equal(classify({ railway: 'rail', tunnel: 'yes', bridge: 'yes' }, 400), null);
  assert.equal(classify({ highway: 'footway', indoor: 'yes', bridge: 'yes' }, 400), null);

  // tunnel=no は打ち消しなので対象に残す
  assert.equal(classify({ railway: 'rail', tunnel: 'no', bridge: 'yes' }, 50), 'rail-bridge');

  // covered は落とさない。覆いのある高架が実在する（東北新幹線）
  assert.equal(
    classify({ railway: 'rail', covered: 'yes', bridge: 'viaduct' }, 542),
    'rail-elevated',
  );
});

test('鉄道の高架と橋を区別する', () => {
  // bridge が無くても、長く続いて上の層にあれば市街地の高架。
  // OSM ではそうした高架に bridge が付いていないことがある
  assert.equal(classify({ railway: 'rail', layer: '1' }, 400), 'rail-elevated');
  // bridge タグがあれば橋として扱う
  assert.equal(classify({ railway: 'rail', bridge: 'yes' }), 'rail-bridge');
  assert.equal(classify({ railway: 'rail', bridge: 'yes', layer: '1' }), 'rail-bridge');
  // 側線やホームは景観への寄与が小さいので除外する
  assert.equal(classify({ railway: 'siding', layer: '1' }, 400), null);
  assert.equal(classify({ railway: 'platform', layer: '1' }, 800), null, '駅のホーム');
  assert.equal(classify({ railway: 'platform_edge', layer: '1' }, 800), null);
});

test('駅構内の通路を歩道橋にしない', () => {
  // 歩道橋やペデストリアンデッキには bridge が付く。
  // bridge が無いまま上の層にある歩行者用の道は、駅の構内通路や
  // ビルの中の通路であることがほとんど。
  // 実測（2026-09、東京駅周辺 4km 四方）では 400m 前後の footway が
  // 17 本あり、名前が「JR秋葉原駅;3階;5番線」のようにホーム上の通路だった
  assert.equal(classify({ highway: 'footway', layer: '3' }, 286), null);
  assert.equal(classify({ highway: 'pedestrian', layer: '2' }, 434), null);
  assert.equal(classify({ highway: 'steps', layer: '1' }, 400), null);

  // bridge があれば、覆いが掛かっていても建てる（駅の跨線橋は実在する）
  assert.equal(
    classify({ highway: 'steps', bridge: 'yes', covered: 'yes', layer: '1' }, 44),
    'footbridge',
  );
});

test('道路は種別によって高架と橋を分ける', () => {
  // 都市高速は長く続くものだけ高架にする
  assert.equal(classify({ highway: 'motorway', layer: '1' }, 400), 'road-elevated');
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
  const l1 = toStructure(longWay({ railway: 'rail', layer: '1' }));
  const l3 = toStructure(longWay({ railway: 'rail', layer: '3' }));
  assert.ok(l1 && l3);
  assert.ok(l3.deckHeight > l1.deckHeight, 'layer が高いほど持ち上がるべき');
});

test('橋は何をまたぐかで高さが決まる', () => {
  // OSM では川の橋にも layer=1 が付く（水路が layer 0 だから）。
  // 浜松の道路橋 57 本は長さ中央値 10m で、その大半が馬込川などを渡る橋だった。
  // layer だけで高さを決めると、川の橋が 5m 浮いて道路から離れてしまう
  // way は南北に伸びるので、川は東西に横切らせる
  const river = [
    { lat: 34.7008, lng: 137.7280 },
    { lat: 34.7008, lng: 137.7320 },
  ];
  const overWater = toStructure(way({ highway: 'residential', bridge: 'yes', layer: '1' }), [river]);
  const overRoad = toStructure(way({ highway: 'residential', bridge: 'yes', layer: '1' }), []);
  assert.ok(overWater && overRoad);

  // 川を渡る橋は前後の道路と同じ高さ
  assert.ok(overWater.deckHeight < 2, `川の橋が ${overWater.deckHeight}m は浮きすぎ`);
  // 道路をまたぐ橋は建築限界ぶん持ち上がる
  assert.ok(overRoad.deckHeight > 5, `跨道橋が ${overRoad.deckHeight}m では低すぎ`);
});

test('つながっている構造物は路面の高さが揃う', () => {
  // 市街地はラーメン高架橋、川をまたぐ区間は橋と造りが変わる。
  // 造りだけで高さを決めると、境目で 7m を超える段差になる
  const at = (lat: number, lng: number) => ({ lat, lng });
  const viaduct = toStructure(way({ railway: 'rail', layer: '1' }, 40));
  assert.ok(viaduct);
  const bridge = {
    ...viaduct,
    id: 'bridge',
    kind: 'rail-bridge' as const,
    form: 'girder' as const,
    deckHeight: 1.8,
    girderDepth: 1.8,
    // 高架の終点から続く
    path: [
      viaduct.path[viaduct.path.length - 1],
      at(viaduct.path[viaduct.path.length - 1].lat + 0.0005, 137.73),
    ],
  };
  const aligned = alignDeckHeights([viaduct, bridge]);
  assert.equal(aligned[0].deckHeight, aligned[1].deckHeight, '軌道面は連続していること');
  assert.equal(aligned[1].deckHeight, viaduct.deckHeight, '高いほうに合わせる');
  // 一方で桁の高さは形式ごとに違う（＝桁下は変わる）
  assert.notEqual(aligned[0].girderDepth, aligned[1].girderDepth);
});

test('形状が 2 点未満のものは捨てる', () => {
  assert.equal(toStructure(way({ railway: 'rail', bridge: 'yes' }, 1)), null);
  assert.ok(toStructure(way({ railway: 'rail', bridge: 'yes' }, 2)));
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
  const s = toStructure(longWay({ railway: 'rail', layer: '1' }));
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
  const road = toStructure(longWay({ highway: 'motorway', layer: '1' }));
  assert.ok(road && s.parapetHeight > road.parapetHeight);
});

test('桁橋の桁高は支間長の 1/16〜1/20 に収まる', () => {
  // 高架道路は bridge が付いていないことがあるので、長い way で作る
  const cases: { tags: Record<string, string>; long?: boolean }[] = [
    { tags: { railway: 'rail', bridge: 'yes' } },
    { tags: { highway: 'motorway', layer: '1' }, long: true },
    { tags: { highway: 'primary', bridge: 'yes' } },
  ];
  for (const { tags, long } of cases) {
    const s = toStructure(long ? longWay(tags) : way(tags));
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
  const low = toStructure(longWay({ railway: 'rail', layer: '1' }));
  const high = toStructure(longWay({ railway: 'rail', layer: '3' }));
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

test('短い橋は床版橋にして橋脚を立てない', () => {
  // 浜松の道路橋は長さ中央値 10m。両岸の橋台で支えており、
  // 川の中に橋脚は立っていない。箱桁と橋脚を付けると実物と違ううえに重い
  const short = toStructure(shortWay({ highway: 'secondary', bridge: 'yes' }));
  assert.ok(short);
  assert.equal(short.form, 'slab', '短い橋は床版橋');
  assert.equal(short.girderDepth, 0, '桁を持たない');
  assert.equal(short.pierSpacing, 0, '橋脚を立てない');
  // 床版橋は桁が無いぶん版が厚い
  assert.ok(short.deckThickness > 0.4);

  // 支間を超える長さなら桁橋になり、橋脚が入る
  const long = toStructure(way({ highway: 'secondary', bridge: 'yes' }));
  assert.ok(long);
  assert.equal(long.form, 'girder');
  assert.ok(long.pierSpacing > 0);

  // 高架は連続した橋脚で支えられている
  const elevated = toStructure(longWay({ railway: 'rail', layer: '1' }));
  assert.ok(elevated && elevated.pierSpacing > 0);
});
