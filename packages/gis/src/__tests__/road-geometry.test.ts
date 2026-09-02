/**
 * 道路・線路・信号の組み立ての検証。
 *
 * ここは描画エンジンに触れない純粋な変換なので、
 * 入力を与えて出力の寸法をそのまま測れる。
 *
 * 浜松駅周辺 3km 四方の実測（2026-08）にもとづく前提:
 *   道路 2,011 本のうち車線数が入っているのは 7%、速度制限は 3%、幅は 0%。
 *   足りないぶんは道路構造令の標準値で補うが、
 *   速度制限だけは推測せず、入っているときだけ返す。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GroundRibbon, LatLng } from '@ijm/shared';
import {
  LANE_MARKING_MAX_HEIGHT_M,
  buildRoadScene,
  crossingShapes,
  detailForHeight,
  laneCountOf,
  nearestRoad,
  railShapes,
  roadClassOf,
  roadShapes,
  roadWidthOf,
  signalShapes,
  speedLimitOf,
  stitchRoads,
  type RoadPiece,
} from '../road-geometry';

const line: LatLng[] = [
  { lat: 34.7047, lng: 137.7342 },
  { lat: 34.7047, lng: 137.7352 },
];

const road = (over: Partial<RoadPiece> = {}): RoadPiece => ({
  id: 'r1',
  cls: 'tertiary',
  path: line,
  width: 7.5,
  lanes: 2,
  oneway: false,
  elevated: false,
  underground: false,
  ...over,
});

const ribbons = (shapes: ReturnType<typeof roadShapes>): GroundRibbon[] =>
  shapes.filter((s): s is GroundRibbon => s.kind === 'ribbon');

test('OSM の highway を描き分けの種別に落とす', () => {
  assert.equal(roadClassOf({ highway: 'residential' }), 'residential');
  assert.equal(roadClassOf({ highway: 'trunk_link' }), 'trunk');
  assert.equal(roadClassOf({ highway: 'unclassified' }), 'tertiary');
  // 横断歩道は footway だが、描き方がまったく違うので分ける
  assert.equal(roadClassOf({ highway: 'footway', footway: 'crossing' }), 'crossing');
  assert.equal(roadClassOf({ highway: 'footway' }), 'footway');
  // 道路でないものは対象外
  assert.equal(roadClassOf({ building: 'yes' }), null);
});

test('車線数は実データを優先し、無ければ種別と一方通行から決める', () => {
  assert.equal(laneCountOf('tertiary', { lanes: '4' }), 4);
  // 3 級道路の標準は片側 1 車線。対面通行なら 2
  assert.equal(laneCountOf('tertiary', {}), 2);
  assert.equal(laneCountOf('tertiary', { oneway: 'yes' }), 1);
  // 自動車専用道路は片側 3 車線
  assert.equal(laneCountOf('motorway', {}), 6);
  // 生活道路は対面でも 1 車線ぶんの幅しかない
  assert.equal(laneCountOf('residential', {}), 2);
});

test('幅は実データ → 車線数 → 種別の順に決まる', () => {
  assert.equal(roadWidthOf('tertiary', { width: '12.5' }), 12.5);
  // 車線数が実データで入っていれば、そこから求める（1 車線 3.0m + 路肩 0.5m × 2）
  assert.equal(roadWidthOf('tertiary', { lanes: '4' }), 4 * 3 + 1);
  // 入っていなければ種別の標準幅。
  // 車線数の補完値から逆算すると、生活道路も 3 級道路も同じ幅になってしまう
  assert.equal(roadWidthOf('tertiary', {}), 7.5);
  assert.equal(roadWidthOf('residential', {}), 5.5);
  assert.ok(
    roadWidthOf('residential', {}) < roadWidthOf('tertiary', {}),
    '生活道路は 3 級道路より狭い',
  );
  // 歩道は車線の考え方をしない
  assert.equal(roadWidthOf('footway', {}), 2.2);
});

test('速度制限は入っているときだけ返す', () => {
  assert.equal(speedLimitOf({ maxspeed: '40' }), 40);
  assert.equal(speedLimitOf({ maxspeed: '40 km/h' }), 40);
  // 推測はしない。標識の値を creating するのは誤情報になる
  assert.equal(speedLimitOf({}), undefined);
  assert.equal(speedLimitOf({ maxspeed: 'JP:urban' }), undefined);
});

test('車道は舗装の上に区画線を重ねる', () => {
  const shapes = ribbons(roadShapes(road({ lanes: 4, width: 13 })));

  const pavement = shapes.find((s) => s.order === 0);
  assert.ok(pavement, '舗装が無い');
  assert.equal(pavement.width, 13);

  // 外側線は左右 1 本ずつ
  assert.equal(shapes.filter((s) => s.order === 1).length, 2, '外側線');
  // 対面通行なので中央線が 1 本
  assert.equal(shapes.filter((s) => s.order === 3).length, 1, '中央線');
  // 片側 2 車線なので、車線境界線が左右 1 本ずつ
  const lanes = shapes.filter((s) => s.order === 2);
  assert.equal(lanes.length, 2, '車線境界線');
  for (const l of lanes) assert.deepEqual(l.dash, [8, 12], '車線境界線は破線');
});

test('1 車線の道と一方通行には中央線を引かない', () => {
  // 住宅街の道。中央線のある生活道路は実際には無い
  const narrow = ribbons(roadShapes(road({ cls: 'residential', lanes: 1, width: 5.5 })));
  assert.equal(narrow.filter((s) => s.order === 3).length, 0);

  const oneway = ribbons(roadShapes(road({ lanes: 2, oneway: true })));
  assert.equal(oneway.filter((s) => s.order === 3).length, 0);
});

test('歩道には区画線を引かない', () => {
  const shapes = ribbons(roadShapes(road({ cls: 'footway', lanes: 0, width: 2.2 })));
  assert.equal(shapes.length, 1, '舗装だけ');
});

test('高架と地下の道路は地表に描かない', () => {
  assert.equal(roadShapes(road({ elevated: true })).length, 0);
  assert.equal(roadShapes(road({ underground: true })).length, 0);
});

test('横断歩道は縞模様になる', () => {
  const shapes = crossingShapes(road({ cls: 'crossing' }));
  assert.equal(shapes.length, 1);
  const zebra = shapes[0] as GroundRibbon;
  // 45cm の白帯を 45cm 間隔で並べるのが道路標示の標準
  assert.deepEqual(zebra.dash, [0.45, 0.45]);
});

test('地表の線路は道床とレールで組む', () => {
  const shapes = railShapes(
    { id: 'rail', path: line, tracks: 2, elevated: false, underground: false },
    () => 10,
  );
  // 線路 1 本につき 道床 1 + レール 2
  assert.equal(shapes.length, 2 * 3);

  const beds = shapes.filter((s) => s.id?.includes('bed'));
  assert.equal(beds.length, 2, '複線ぶんの道床');
  for (const bed of beds) {
    assert.equal(bed.kind, 'extrusion');
    if (bed.kind !== 'extrusion') continue;
    // 道床は台形。上底が下底より狭い
    const bottom = bed.section.filter((p) => p.y === 0);
    const top = bed.section.filter((p) => p.y > 0);
    assert.ok(
      Math.abs(bottom[1].x - bottom[0].x) > Math.abs(top[1].x - top[0].x),
      '道床は台形',
    );
    assert.equal(bed.path[0].alt, 10, '地表の高さに載る');
  }

  const rails = shapes.filter((s) => s.id?.includes('#rail'));
  assert.equal(rails.length, 4, '複線ぶんのレール');
  for (const r of rails) {
    if (r.kind !== 'extrusion') continue;
    assert.equal(r.path[0].alt, 10.4, 'レールは道床の上');
  }
});

test('高架の線路は地表に描かない（高架側が建てる）', () => {
  const shapes = railShapes(
    { id: 'rail', path: line, tracks: 1, elevated: true, underground: false },
    () => 0,
  );
  assert.equal(shapes.length, 0);
});

test('信号は柱と灯器で組む', () => {
  const shapes = signalShapes(
    { id: 'n1', kind: 'traffic_signal', position: { lat: 34.7, lng: 137.73 } },
    () => 5,
  );
  assert.equal(shapes.length, 2);
  const [pole, head] = shapes;
  assert.equal(pole.kind, 'box');
  if (pole.kind !== 'box' || head.kind !== 'box') return;
  // 柱は 5m。灯器はその頭
  assert.equal(pole.size.z, 5);
  assert.ok(head.centre.alt! > pole.centre.alt!, '灯器は柱より高い');
  // 3 位の横型灯器（幅 0.95m）
  assert.ok(head.size.x > head.size.y, '灯器は横長');
});

test('横断歩道や停止線は信号として組み立てない', () => {
  assert.equal(
    signalShapes({ id: 'n', kind: 'crossing', position: { lat: 34.7, lng: 137.73 } }, () => 0)
      .length,
    0,
  );
});

test('OSM の要素から道路・線路・信号を取り出す', () => {
  const scene = buildRoadScene([
    {
      type: 'way',
      id: 1,
      tags: { highway: 'tertiary', name: '駅南大通り', lanes: '4', maxspeed: '40' },
      geometry: [
        { lat: 34.7047, lon: 137.7342 },
        { lat: 34.7047, lon: 137.7352 },
      ],
    },
    {
      type: 'way',
      id: 2,
      tags: { railway: 'rail', tracks: '2' },
      geometry: [
        { lat: 34.705, lon: 137.7342 },
        { lat: 34.705, lon: 137.7352 },
      ],
    },
    {
      type: 'node',
      id: 3,
      lat: 34.7048,
      lon: 137.7345,
      tags: { highway: 'traffic_signals', name: '駅南交差点' },
    },
    // 道路でも線路でもないものは無視する
    { type: 'way', id: 4, tags: { building: 'yes' }, geometry: [] },
  ]);

  assert.equal(scene.roads.length, 1);
  assert.equal(scene.roads[0].name, '駅南大通り');
  assert.equal(scene.roads[0].lanes, 4);
  assert.equal(scene.roads[0].speedLimit, 40);

  assert.equal(scene.rails.length, 1);
  assert.equal(scene.rails[0].tracks, 2);

  assert.equal(scene.points.length, 1);
  assert.equal(scene.points[0].kind, 'traffic_signal');
  assert.equal(scene.points[0].name, '駅南交差点');
});

test('現在地にいちばん近い道を選ぶ', () => {
  // 東西に走る 2 本の道。北の道の上にいる
  const north = road({ id: 'north', path: line, speedLimit: 40 });
  const south = road({
    id: 'south',
    speedLimit: 60,
    path: line.map((p) => ({ ...p, lat: p.lat - 0.0005 })), // 約 56m 南
  });

  const onNorth = nearestRoad([north, south], { lat: 34.7047, lng: 137.7347 });
  assert.equal(onNorth?.id, 'north');
  assert.equal(onNorth?.speedLimit, 40);

  // 線分の端より外にいても、いちばん近い点までの距離で測る
  const beyondEnd = nearestRoad([north], { lat: 34.7047, lng: 137.7353 });
  assert.equal(beyondEnd?.id, 'north', '線分の延長上でも拾う');

  // どの道からも遠ければ返さない。間違った道の制限速度を出すほうが害が大きい
  assert.equal(nearestRoad([north, south], { lat: 34.71, lng: 137.7347 }), null);
});

test('歩道の上にいても車の制限速度は出さない', () => {
  const footway = road({ id: 'foot', cls: 'footway', lanes: 0, width: 2.2 });
  assert.equal(nearestRoad([footway], { lat: 34.7047, lng: 137.7347 }), null);
});

// ---- 細切れの道をつなぐ ------------------------------------------------

const M = 111_320;
/** 東へ伸びる線分を、始点と長さから作る */
const seg = (startM: number, lengthM: number, points = 2): LatLng[] => {
  const cos = Math.cos((34.7047 * Math.PI) / 180);
  return Array.from({ length: points }, (_, i) => ({
    lat: 34.7047,
    lng: 137.7342 + (startM + (i * lengthM) / (points - 1)) / (M * cos),
  }));
};

test('交差点で切れた同じ道をつなぐ', () => {
  // OSM は 1 本の通りを交差点ごとに別の way にする。
  // 浜松駅周辺 1km 四方で道路 1,817 本になっていた（2026-09 実測）
  const a = road({ id: 'a', name: '駅南大通り', path: seg(0, 50) });
  const b = road({ id: 'b', name: '駅南大通り', path: seg(50, 50) });
  const c = road({ id: 'c', name: '駅南大通り', path: seg(100, 50) });

  const stitched = stitchRoads([a, b, c]);
  assert.equal(stitched.length, 1, '3 本が 1 本になる');
  // つなぎ目の点は重複させない（2 + 1 + 1）
  assert.equal(stitched[0].path.length, 4);
  // 全長は変わらない
  const total = stitched[0].path;
  const cos = Math.cos((34.7047 * Math.PI) / 180);
  const length = (total[total.length - 1].lng - total[0].lng) * M * cos;
  assert.ok(Math.abs(length - 150) < 0.5, `全長 ${length.toFixed(1)}m`);
});

test('向きが逆に登録されていてもつなぐ', () => {
  // way の向きは OSM の入力順で決まる。同じ通りでも逆向きのことがある
  const a = road({ id: 'a', name: '通り', path: seg(0, 50) });
  const b = road({ id: 'b', name: '通り', path: [...seg(50, 50)].reverse() });

  const stitched = stitchRoads([a, b]);
  assert.equal(stitched.length, 1);
  assert.equal(stitched[0].path.length, 3);
  // 座標が単調に増えている（折り返していない）
  const lngs = stitched[0].path.map((p) => p.lng);
  for (let i = 1; i < lngs.length; i += 1) {
    assert.ok(lngs[i] > lngs[i - 1], '逆向きの取り込みで折り返している');
  }
});

test('分岐点ではつながない', () => {
  // 端点に 3 本が集まるところ。どちらへ延ばしても実際とは違う線形になる
  const a = road({ id: 'a', name: undefined, path: seg(0, 50) });
  const b = road({ id: 'b', name: undefined, path: seg(50, 50) });
  const branch = road({
    id: 'branch',
    name: undefined,
    // 同じ端点から北へ分かれる
    path: [
      { lat: 34.7047, lng: seg(50, 0)[0].lng },
      { lat: 34.7047 + 50 / M, lng: seg(50, 0)[0].lng },
    ],
  });

  const stitched = stitchRoads([a, b, branch]);
  assert.equal(stitched.length, 3, '分岐しているのにつないでいる');
});

test('種別や幅が違えばつながない', () => {
  // 描き方が変わるところで 1 本にすると、幅が途中で変わる道を表現できない
  const a = road({ id: 'a', name: '通り', cls: 'tertiary', width: 7.5, path: seg(0, 50) });
  const b = road({ id: 'b', name: '通り', cls: 'residential', width: 5.5, path: seg(50, 50) });
  assert.equal(stitchRoads([a, b]).length, 2);
});

test('名前が違えばつながない', () => {
  const a = road({ id: 'a', name: '駅南大通り', path: seg(0, 50) });
  const b = road({ id: 'b', name: '旭町通り', path: seg(50, 50) });
  assert.equal(stitchRoads([a, b]).length, 2);
});

test('速度制限が違えばつながない', () => {
  // つなぐと、どちらの制限速度を出すべきか分からなくなる
  const a = road({ id: 'a', name: '通り', speedLimit: 40, path: seg(0, 50) });
  const b = road({ id: 'b', name: '通り', speedLimit: 60, path: seg(50, 50) });
  assert.equal(stitchRoads([a, b]).length, 2);
});

test('つないだ道でも速度制限を引ける', () => {
  const a = road({ id: 'a', name: '通り', speedLimit: 40, path: seg(0, 50) });
  const b = road({ id: 'b', name: '通り', speedLimit: 40, path: seg(50, 50) });
  const [joined] = stitchRoads([a, b]);
  assert.equal(joined.speedLimit, 40);
  // つないだ後半のところでも引ける
  const found = nearestRoad([joined], { lat: 34.7047, lng: seg(75, 0)[0].lng });
  assert.equal(found?.speedLimit, 40);
});

test('つながらない道はそのまま返す', () => {
  const lone = road({ id: 'lone', path: seg(0, 50) });
  const far = road({ id: 'far', path: seg(500, 50) });
  const out = stitchRoads([lone, far]);
  assert.equal(out.length, 2);
  // 触っていないものは同じ実体を返す（無駄な複製を作らない）
  assert.equal(out[0], lone);
});

test('住宅街の道には外側線を引かない', () => {
  // 幅 4〜5.5m の生活道路に白線は引かれていない。
  // すべての車道に引いていたのは実際と違ううえ、
  // 浜松 1km 四方の実測（2026-09）で全頂点の 39% を占めていた
  const local = ribbons(roadShapes(road({ cls: 'residential', lanes: 2, width: 5.5 })));
  assert.equal(local.filter((s) => s.order === 1).length, 0, '生活道路の外側線');
  assert.equal(local.filter((s) => s.order === 0).length, 1, '舗装は引く');

  // 区画内の通路も同じ
  assert.equal(
    ribbons(roadShapes(road({ cls: 'service', lanes: 2, width: 4 }))).filter(
      (s) => s.order === 1,
    ).length,
    0,
  );

  // 幹線には引く
  for (const cls of ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'] as const) {
    assert.equal(
      ribbons(roadShapes(road({ cls, lanes: 2, width: 9 }))).filter((s) => s.order === 1)
        .length,
      2,
      `${cls} の外側線`,
    );
  }
});

// ---- 上空では区画線を描かない ------------------------------------------

test('上空から見ているときは区画線を組み立てない', () => {
  // 幅 15cm の線は上空からは分離して見えず、灰色の帯にしかならない。
  // 部品を減らしているのではなく、見えないものを描いていない
  const plain = { laneMarkings: false };
  const shapes = ribbons(roadShapes(road({ lanes: 4, width: 13 }), plain));
  assert.equal(shapes.length, 1, '舗装だけになる');
  assert.equal(shapes[0].order, 0);

  // 近づけば元どおり出る
  const close = ribbons(roadShapes(road({ lanes: 4, width: 13 })));
  assert.ok(close.length > 1, '近くでは区画線が出る');
});

test('上空では横断歩道の縞も組み立てない', () => {
  assert.equal(crossingShapes(road({ cls: 'crossing' }), { laneMarkings: false }).length, 0);
  assert.equal(crossingShapes(road({ cls: 'crossing' })).length, 1);
});

test('詳細度はカメラ高度で決まる', () => {
  // 800m を境にする。街区の形が分かればよい高さ
  assert.equal(detailForHeight(0).laneMarkings, true);
  assert.equal(detailForHeight(400).laneMarkings, true);
  assert.equal(detailForHeight(LANE_MARKING_MAX_HEIGHT_M).laneMarkings, true);
  assert.equal(detailForHeight(LANE_MARKING_MAX_HEIGHT_M + 1).laneMarkings, false);
  assert.equal(detailForHeight(5000).laneMarkings, false);
});

test('上空でも線路と信号は出す', () => {
  // 線路の道床は幅 4.4m、信号の灯器は 0.95m。どちらも上空から見える
  assert.equal(
    railShapes({ id: 'r', path: line, tracks: 1, elevated: false, underground: false }, () => 0)
      .length,
    3,
  );
  assert.equal(
    signalShapes({ id: 'n', kind: 'traffic_signal', position: line[0] }, () => 0).length,
    2,
  );
});

// ---- 壊れたデータへの備え ----------------------------------------------

test('OSM の極端な値をそのまま使わない', () => {
  // OSM のタグは自由入力で、入力ミスや荒らしで極端な値が入ることがある。
  // tracks=1000000000 をそのまま使うと線路を 10 億本組み立てようとして
  // ブラウザが固まる（実際に固まることを確かめた）
  const scene = buildRoadScene([
    {
      type: 'way',
      id: 1,
      tags: { railway: 'rail', tracks: '1000000000' },
      geometry: [
        { lat: 34.7, lon: 137.73 },
        { lat: 34.7, lon: 137.74 },
      ],
    },
    {
      type: 'way',
      id: 2,
      tags: { highway: 'motorway', lanes: '99999', width: '50000' },
      geometry: [
        { lat: 34.7, lon: 137.73 },
        { lat: 34.7, lon: 137.74 },
      ],
    },
  ]);

  // 世界最大級の駅でも 30 本程度（東京駅は 20 面 20 線）
  assert.ok(scene.rails[0].tracks <= 40, `線路 ${scene.rails[0].tracks} 本`);
  // 最多はカナダのハイウェイ 401 で往復 18 車線
  assert.ok(scene.roads[0].lanes <= 24, `車線 ${scene.roads[0].lanes}`);
  // 道路の幅は最大でも 100m 程度
  assert.ok(scene.roads[0].width <= 100, `幅 ${scene.roads[0].width}m`);

  // 組み立てても現実的な個数に収まる
  const shapes = railShapes(scene.rails[0], () => 0);
  assert.ok(shapes.length <= 40 * 3, `形 ${shapes.length} 個`);
});

test('線路数の上限は呼び出し側が忘れても効く', () => {
  // RoadPiece を直接組み立てる経路もあるので、描く側でも守る
  const shapes = railShapes(
    { id: 'x', path: line, tracks: 1e9, elevated: false, underground: false },
    () => 0,
  );
  assert.ok(shapes.length > 0 && shapes.length <= 40 * 3);
});

test('幅の無い道路は描かない', () => {
  // 幅 0 の帯は面にならない。0 や負の値が来たら何も出さない
  assert.equal(roadShapes(road({ width: 0 })).length, 0);
  assert.equal(roadShapes(road({ width: -5 })).length, 0);
});

test('地形の高さが取れなくても NaN を出さない', () => {
  // 地形の取得に失敗すると NaN が返ることがある。
  // そのまま使うと座標がすべて NaN になり、描画側では
  // 「何も出ない」という形でしか分からない
  const rails = railShapes(
    { id: 'x', path: line, tracks: 1, elevated: false, underground: false },
    () => Number.NaN,
  );
  for (const s of rails) {
    if (s.kind !== 'extrusion') continue;
    for (const p of s.path) assert.ok(Number.isFinite(p.alt), '線路の高さが NaN');
  }

  const signals = signalShapes(
    { id: 'n', kind: 'traffic_signal', position: line[0] },
    () => Number.NaN,
  );
  for (const s of signals) {
    if (s.kind !== 'box') continue;
    assert.ok(Number.isFinite(s.centre.alt), '信号の高さが NaN');
  }
});
