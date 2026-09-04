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
import type { GroundRibbon, LatLng, SceneShape } from '@ijm/shared';
import {
  LANE_MARKING_MAX_HEIGHT_M,
  buildRoadScene,
  crossingShapes,
  detailForHeight,
  laneCountOf,
  nearestRoad,
  railShapes,
  railDetailForHeight,
  levelRailHeights,
  type RailPiece,
  roadClassOf,
  roadShapes,
  roadWidthOf,
  signalShapes,
  speedLimitOf,
  stitchRoads,
  type RoadPiece,
  buildIntersections,
  stopLineShapes,
  FULL_DETAIL,
  type RoadPoint,

  splitAtIntersections,
} from '../road-geometry';
import { classify } from '../structures';

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
  // 枕木は距離で出し分けるので、ここでは骨組みだけを見る
  const shapes = railShapes(
    { id: 'rail', path: line, tracks: 2, elevated: false, underground: false },
    () => 10,
    { sleeperStep: 0, catenaryStep: 0 },
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
    // 道床は路盤に食い込ませてある（上面が地表に出るように）
    assert.ok((bed.path[0].alt ?? 0) < 10, '道床の下端が路盤より上にある');
    assert.ok(
      Math.abs((bed.path[0].alt ?? 0) + Math.max(...bed.section.map((p) => p.y)) - 10.4) < 0.01,
      '道床の上面が路盤 + 0.4m にない',
    );
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

test('信号は柱・アーム・灯器で組み、道路の向きに合わせる', () => {
  // 実物の車両用信号は車道の上へ灯器を張り出している。
  // 柱だけだと遠目には細い棒が立っているだけで、信号と分からない。
  // 向きも真北に固定していたため、交差点のどの方向を制御しているのか
  // 分からず、灯器を真横から見ることになっていた
  const shapes = signalShapes(
    {
      id: 'n1',
      kind: 'traffic_signal',
      position: { lat: 34.7, lng: 137.73 },
      headingDeg: 90, // 東西の道
      roadWidth: 9,
    },
    () => 5,
  );
  const pole = shapes.find((s) => s.kind === 'revolved');
  const arm = shapes.find((s) => s.id?.endsWith('#arm'));
  const head = shapes.find((s) => s.id?.endsWith('#head'));
  assert.ok(pole && arm && head, '柱・アーム・灯器が揃っていない');
  if (pole.kind !== 'revolved' || head.kind !== 'box') return;

  // 灯器の下端は車道上 5.0m 以上（警察庁の設置基準）
  const bottom = (head.centre.alt ?? 0) - head.size.z / 2;
  assert.ok(bottom - 5 >= 5.0 - 0.01, `灯器が低い: 路面から ${bottom - 5}m`);
  // 3 位の横型灯器（幅 0.94m × 高さ 0.35m）
  assert.ok(Math.abs(head.size.y - 0.94) < 0.01, '灯器の幅が実寸でない');
  assert.ok(Math.abs(head.size.z - 0.35) < 0.01, '灯器の高さが実寸でない');
  // 灯器は柱から離れて車道の上にある
  const away = Math.hypot(
    (head.centre.lat - pole.base.lat) * 111_320,
    (head.centre.lng - pole.base.lng) * 111_320 * Math.cos((34.7 * Math.PI) / 180),
  );
  assert.ok(away > 2, `灯器が柱の真上にある: ${away.toFixed(1)}m`);
  // 東西の道なら、アームは南北へ張り出す
  assert.ok(Math.abs(head.centre.lat - pole.base.lat) > Math.abs(head.centre.lng - pole.base.lng));

  // 柱は車道の中心ではなく路肩に立つ。
  // OSM の highway=traffic_signals は車道の中心線上のノードに付くので、
  // そのまま立てると道の真ん中に柱が生える
  const fromNode = Math.hypot(
    (pole.base.lat - 34.7) * 111_320,
    (pole.base.lng - 137.73) * 111_320 * Math.cos((34.7 * Math.PI) / 180),
  );
  assert.ok(fromNode > 9 / 2, `柱が車道の中にある: 中心線から ${fromNode.toFixed(1)}m`);
  // 灯器は車道の上（中心線の近く）に戻ってくる
  const headFromNode = Math.hypot(
    (head.centre.lat - 34.7) * 111_320,
    (head.centre.lng - 137.73) * 111_320 * Math.cos((34.7 * Math.PI) / 180),
  );
  assert.ok(headFromNode < 9 / 2, `灯器が車道の外にある: ${headFromNode.toFixed(1)}m`);
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
  // 線路の道床は幅 4.4m、信号の灯器は 0.95m。どちらも上空から見える。
  // 上空では枕木と架線柱を落とすので、残るのは道床 1 + レール 2
  assert.equal(
    railShapes(
      { id: 'r', path: line, tracks: 1, elevated: false, underground: false },
      () => 0,
      railDetailForHeight(1000),
    ).length,
    3,
  );
  assert.ok(
    signalShapes({ id: 'n', kind: 'traffic_signal', position: line[0] }, () => 0).length >= 3,
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

  // 組み立てても現実的な個数に収まる。
  // 枕木は way 全体で上限を掛けて線路の本数で割るので、本数が増えても膨らまない
  const shapes = railShapes(scene.rails[0], () => 0);
  assert.ok(shapes.length <= 40 * 3 + 600, `形 ${shapes.length} 個`);
});

test('線路数の上限は呼び出し側が忘れても効く', () => {
  // RoadPiece を直接組み立てる経路もあるので、描く側でも守る
  const shapes = railShapes(
    { id: 'x', path: line, tracks: 1e9, elevated: false, underground: false },
    () => 0,
  );
  assert.ok(shapes.length > 0 && shapes.length <= 40 * 3 + 600, `形 ${shapes.length} 個`);
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

test('地表に描かない判定は、高架を建てる判定と揃っている', () => {
  // 揃っていないと、どちらからも描かれない道や線路ができる。
  // 実際にそうなっていた。高架の判定を「layer > 0」から
  // 「bridge があるか、250m 以上続いて上の層にある」に直したとき、
  // 地表側は古いままだったので、layer=1 の短い線路が
  // 高架としても建てられず、地表にも描かれなくなっていた。
  const way = (tags: Record<string, string>, lengthM: number) => {
    // 東へ lengthM だけ伸びる経路
    const cos = Math.cos((34.7 * Math.PI) / 180);
    return {
      type: 'way' as const,
      id: 1,
      tags,
      geometry: [
        { lat: 34.7, lon: 137.73 },
        { lat: 34.7, lon: 137.73 + lengthM / (111_320 * cos) },
      ],
    };
  };

  const cases: [Record<string, string>, number, boolean, string][] = [
    // [タグ, 長さ, 地表に描くか, 説明]
    [{ railway: 'rail', layer: '1' }, 8, true, '8m の交差部は高架にならないので地表に描く'],
    [{ railway: 'rail', layer: '1' }, 100, true, '100m でも高架にはならない'],
    [{ railway: 'rail', layer: '1' }, 400, false, '400m の高架は構造物側が建てる'],
    [{ railway: 'rail', bridge: 'yes' }, 30, false, '橋は構造物側が建てる'],
    [{ railway: 'rail' }, 400, true, 'ただの地上の線路'],
    [{ highway: 'residential', layer: '1' }, 30, true, 'layer が付いた生活道路'],
    [{ highway: 'residential', bridge: 'yes' }, 20, false, '橋は構造物側'],
    [{ highway: 'motorway', layer: '1' }, 400, false, '長い都市高速は構造物側'],
  ];

  for (const [tags, lengthM, drawOnGround, why] of cases) {
    const scene = buildRoadScene([way(tags, lengthM)]);
    const piece = tags.railway ? scene.rails[0] : scene.roads[0];
    assert.ok(piece, `${why}: 要素が取れていない`);
    assert.equal(piece.elevated, !drawOnGround, why);
    // 高架として建てられるかと、地表に描かないかが一致していること
    assert.equal(classify(tags, lengthM) !== null, piece.elevated, `${why}: 判定が食い違う`);
  }
});

// ---- 交差点 ------------------------------------------------------------
//
// 「車道の線や交差点の再現度が低すぎる」という指摘への対応。
//
// 実物の区画線は交差点の中まで引かれておらず、手前の停止線で切れている。
// 切らずに引くと、交差する道の白線どうしが交差点の中央で重なり、
// 上から見ると白線が格子状に走って見える。
//
// 出典: 道路標識、区画線及び道路標示に関する命令 別表第 4（203 停止線、
// 幅 0.3〜0.45m）。停止線は横断歩道（幅 3〜4m）の手前に引かれる。

/** 真東西に走る道と、それに南から突き当たる道 */
function crossRoads() {
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const east = (m: number) => ({ lat: 34.7, lng: 137.73 + m / (111_320 * cos) });
  const centre = east(0);
  const mainRoad: RoadPiece = {
    id: 'main',
    cls: 'primary',
    // 西 → 交差点 → 東
    path: [east(-60), centre, east(60)],
    width: 9.5,
    lanes: 4,
    oneway: false,
    elevated: false,
    underground: false,
  };
  const side: RoadPiece = {
    id: 'side',
    cls: 'residential',
    // 南から突き当たる
    path: [{ lat: 34.7 - 60 / 111_320, lng: 137.73 }, centre],
    width: 5.5,
    lanes: 2,
    oneway: false,
    elevated: false,
    underground: false,
  };
  return { mainRoad, side, centre };
}

test('道が 3 本ぶん集まる点を交差点とみなす', () => {
  const { mainRoad, side, centre } = crossRoads();
  const found = buildIntersections([mainRoad, side]);
  assert.equal(found.size, 1, '交差点が 1 か所でない');
  const node = [...found.values()][0];
  assert.ok(Math.abs(node.point.lat - centre.lat) < 1e-9);
  // 広いほうの道（9.5m）の半分 + 停止線の手前ぶん
  assert.ok(node.radius > 9.5 / 2, `広がりが狭い: ${node.radius}m`);
  assert.equal(node.signalised, false);
});

test('way が途中で分かれているだけの点は交差点にしない', () => {
  // 同じ道が 2 本の way に分かれているだけなら、区画線を切ってはいけない
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const east = (m: number) => ({ lat: 34.7, lng: 137.73 + m / (111_320 * cos) });
  const a: RoadPiece = {
    id: 'a', cls: 'primary', path: [east(-60), east(0)],
    width: 9.5, lanes: 4, oneway: false, elevated: false, underground: false,
  };
  const b: RoadPiece = { ...a, id: 'b', path: [east(0), east(60)] };
  assert.equal(buildIntersections([a, b]).size, 0);
});

test('歩道は車道の交差点を作らない', () => {
  const { mainRoad, centre } = crossRoads();
  const footway: RoadPiece = {
    id: 'foot', cls: 'footway',
    path: [{ lat: 34.7 - 60 / 111_320, lng: 137.73 }, centre],
    width: 2.2, lanes: 0, oneway: false, elevated: false, underground: false,
  };
  assert.equal(buildIntersections([mainRoad, footway]).size, 0);
});

test('区画線は交差点の手前で切れる（舗装は切らない）', () => {
  const { mainRoad, side } = crossRoads();
  const found = buildIntersections([mainRoad, side]);
  const shapes = roadShapes(mainRoad, FULL_DETAIL, found);

  const pavement = shapes.find((s) => s.id === 'main');
  assert.ok(pavement && pavement.kind === 'ribbon');
  if (pavement?.kind !== 'ribbon') return;
  // 舗装は交差点の中まで続く（アスファルトは切れていない）
  assert.equal(pavement.path.length, mainRoad.path.length);

  // 中央線は交差点の手前で終わる
  const centreLine = shapes.find((s) => s.kind === 'ribbon' && s.order === 3 && !s.id);
  assert.ok(centreLine && centreLine.kind === 'ribbon', '中央線が無い');
  if (centreLine?.kind !== 'ribbon') return;
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const node = { lat: 34.7, lng: 137.73 };
  const nearest = Math.min(
    ...centreLine.path.map((p) =>
      Math.hypot((p.lat - node.lat) * 111_320, (p.lng - node.lng) * 111_320 * cos),
    ),
  );
  assert.ok(nearest > 4, `中央線が交差点に入り込んでいる: ${nearest.toFixed(1)}m`);
});

test('交差点を渡さなければ、区画線は端まで引く', () => {
  // 交差点が分からないときに勝手に切ると、道の途中で線が消える
  const { mainRoad } = crossRoads();
  const shapes = roadShapes(mainRoad, FULL_DETAIL);
  const centreLine = shapes.find((s) => s.kind === 'ribbon' && s.order === 3 && !s.id);
  assert.ok(centreLine?.kind === 'ribbon' && centreLine.path.length === mainRoad.path.length);
});

test('道の途中の交差点でも区画線を分断する', () => {
  // 交差点は道の端だけでなく途中にもある。途中で切らないと、
  // その道の白線だけが交差点を突っ切ることになる
  const { mainRoad, side } = crossRoads();
  const found = buildIntersections([mainRoad, side]);
  const pieces = splitAtIntersections(mainRoad.path, found);
  assert.equal(pieces.length, 2, '交差点の前後に分かれていない');
  // どちらの区間も交差点から離れている
  const cos = Math.cos((34.7 * Math.PI) / 180);
  for (const piece of pieces) {
    const nearest = Math.min(
      ...piece.map((p) =>
        Math.hypot((p.lat - 34.7) * 111_320, (p.lng - 137.73) * 111_320 * cos),
      ),
    );
    assert.ok(nearest > 4, `交差点に入り込んでいる: ${nearest.toFixed(1)}m`);
  }
});

test('信号のある交差点には停止線を引く', () => {
  const { mainRoad, side, centre } = crossRoads();
  const signal: RoadPoint = { id: 's', kind: 'traffic_signal', position: centre };
  const found = buildIntersections([mainRoad, side], [signal]);
  assert.equal([...found.values()][0].signalised, true);

  // 突き当たる側は 1 本（交差点はこの道の端）
  const sideStops = stopLineShapes(side, found);
  assert.equal(sideStops.length, 1, '突き当たりに停止線が無い');
  // 通り抜ける道は、交差点の手前と奥で 2 本
  const stops = stopLineShapes(mainRoad, found);
  assert.equal(stops.length, 2, '通り抜ける道の停止線が 2 本でない');
  const line = sideStops[0];
  assert.ok(line.kind === 'ribbon');
  if (line.kind !== 'ribbon') return;
  // 幅 0.45m（区画線 203 停止線）
  assert.ok(Math.abs(line.width - 0.45) < 0.01);
  // 道を横切る向きに、進入車線ぶん（対面通行なので半分）
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const span = Math.hypot(
    (line.path[0].lat - line.path[1].lat) * 111_320,
    (line.path[0].lng - line.path[1].lng) * 111_320 * cos,
  );
  assert.ok(Math.abs(span - 5.5 / 2) < 0.2, `停止線の長さが ${span.toFixed(2)}m`);
});

test('信号の無い交差点には停止線を引かない', () => {
  const { mainRoad, side } = crossRoads();
  const found = buildIntersections([mainRoad, side]);
  assert.equal(stopLineShapes(side, found).length, 0);
});

/**
 * 信号と交差点の突き合わせ。
 *
 * 素朴に「すべての信号との距離を測る」と、交差点候補 × 信号数の掛け算になる。
 * 東京駅周辺 1km 四方の実測（2026-09）では候補が約 3 万点・信号が約 400 個で、
 * 1,200 万回の距離計算になり、これだけで 13.7ms（1 フレームの 8 割）かかっていた。
 *
 * 25m の格子に入れて周囲 9 マスだけ見る形にしたので、
 * 「格子の境目にある信号を取りこぼさないこと」をここで固定する。
 * 速くなったが結果が変わった、では意味がない。
 */
test('格子の境目にある信号も同じ交差点として拾う', () => {
  const { mainRoad, side, centre } = crossRoads();
  const cos = Math.cos((centre.lat * Math.PI) / 180);
  const move = (northM: number, eastM: number) => ({
    lat: centre.lat + northM / 111_320,
    lng: centre.lng + eastM / (111_320 * cos),
  });

  // 交差点の周り 8 方向に、判定の境目（25m）のすぐ内側で置く。
  // 格子は 25m 幅なので、どの向きでも必ず隣のマスにまたがる
  for (const [northM, eastM] of [
    [24, 0],
    [-24, 0],
    [0, 24],
    [0, -24],
    [17, 17],
    [-17, 17],
    [17, -17],
    [-17, -17],
  ] as const) {
    const signal: RoadPoint = {
      id: `s-${northM}-${eastM}`,
      kind: 'traffic_signal',
      position: move(northM, eastM),
    };
    const found = buildIntersections([mainRoad, side], [signal]);
    assert.equal(
      [...found.values()][0].signalised,
      true,
      `北 ${northM}m・東 ${eastM}m の信号を取りこぼした`,
    );
  }
});

test('離れた信号は別の交差点のものとして扱う', () => {
  // 交差点の幅は片側 2 車線でも 15m 前後。25m 以上離れていれば別の交差点
  const { mainRoad, side, centre } = crossRoads();
  const cos = Math.cos((centre.lat * Math.PI) / 180);
  const signal: RoadPoint = {
    id: 'far',
    kind: 'traffic_signal',
    position: { lat: centre.lat, lng: centre.lng + 40 / (111_320 * cos) },
  };
  const found = buildIntersections([mainRoad, side], [signal]);
  assert.equal([...found.values()][0].signalised, false);
});

test('信号でない点は交差点の判定に混ざらない', () => {
  const { mainRoad, side, centre } = crossRoads();
  const crossing: RoadPoint = { id: 'c', kind: 'crossing', position: centre };
  const found = buildIntersections([mainRoad, side], [crossing]);
  assert.equal([...found.values()][0].signalised, false);
});

test('同じノードを共有する道は同じ交差点にまとまる', () => {
  // 座標のキーの作り方を変えた（toFixed から整数への丸めへ）。
  // OSM で同じノードを共有する way はまったく同じ値を持つので、
  // 丸め方が変わってもまとまり方は変わらない
  const { mainRoad, side } = crossRoads();
  const found = buildIntersections([mainRoad, side]);
  assert.equal(found.size, 1, '同じ点が 2 つの交差点に分かれている');
});

/**
 * 線路が地面に埋まる問題と、線路まわりのリアルさ。
 *
 * **なぜ埋まっていたか。**
 * 道路は `GroundPrimitive`（地形にクランプ）で描くので絶対に埋まらないが、
 * 線路は立体なので絶対高さで置く。その高さを 100m 格子の標高から
 * 補間していたため、実際の地面とずれると沈む。
 *
 * 実測（2026-09-04、東京駅周辺の線路上 12 点、国土地理院の標高 API と
 * 100m 格子の双線形補間を比較）:
 *
 *   差の絶対値の中央値 0.08m / 最大 0.25m
 *   格子のほうが高い（＝線路が埋まる）点 6 / 12
 *
 * 道床の高さは 0.4m しかないので、0.25m 沈むと 6 割が地面に入る。
 * 東京駅周辺は標高 3m 前後の平地でこれなので、起伏があればもっと沈む。
 *
 * さらに、標高をそのまま頂点に当てると線路が地面の凹凸をなぞって波打つ。
 * 実物の線路は路盤で平されていて、勾配は連続で緩やかに変わる。
 */

/** 東西にまっすぐ n 点の線路 */
function straightRail(points: number, tags: Partial<RailPiece> = {}): RailPiece {
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const path = Array.from({ length: points }, (_, i) => ({
    lat: 34.7,
    lng: 137.73 + (i * 40) / (111_320 * cos),
  }));
  return {
    id: 'rail',
    path,
    tracks: 1,
    elevated: false,
    underground: false,
    ...tags,
  };
}

test('線路は地面の凹凸をなぞらない', () => {
  // 実物の線路は路盤で平されている。標高をそのまま当てると波打つ
  const rail = straightRail(9);
  // 1 点おきに 1.5m の段差がある地形（測量の誤差やビルの屋根を拾ったときの形）
  const bumpy = (p: LatLng) => {
    const i = Math.round((p.lng - 137.73) * 111_320 * Math.cos((34.7 * Math.PI) / 180) / 40);
    return i % 2 === 0 ? 10 : 11.5;
  };
  const levels = levelRailHeights(rail.path, bumpy);

  // 隣り合う点の差が、元の 1.5m よりはっきり小さくなっている
  let maxStep = 0;
  for (let i = 1; i < levels.length; i += 1) {
    maxStep = Math.max(maxStep, Math.abs(levels[i] - levels[i - 1]));
  }
  assert.ok(maxStep < 1.0, `段差が ${maxStep.toFixed(2)}m 残っている`);
  // 平しても、全体の高さの水準は変わらない（勝手に持ち上げない）
  const mean = levels.reduce((s, v) => s + v, 0) / levels.length;
  assert.ok(Math.abs(mean - 10.75) < 0.4, `水準がずれた: ${mean.toFixed(2)}m`);
});

test('線路の縦断勾配は基準の上限を超えない', () => {
  // 出典: 鉄道に関する技術上の基準を定める省令の解釈基準 第 15 条
  // 本線の最急勾配 35‰。40m 間隔なら 1 点あたり 1.4m まで
  const rail = straightRail(6);
  // 崖のような地形（40m で 20m 上がる ＝ 500‰）
  const cliff = (p: LatLng) => {
    const i = Math.round((p.lng - 137.73) * 111_320 * Math.cos((34.7 * Math.PI) / 180) / 40);
    return i * 20;
  };
  const levels = levelRailHeights(rail.path, cliff, 'rail');
  for (let i = 1; i < levels.length; i += 1) {
    const grade = Math.abs(levels[i] - levels[i - 1]) / 40;
    assert.ok(grade <= 0.035 + 1e-6, `${i} 番目の勾配が ${(grade * 1000).toFixed(0)}‰`);
  }
});

test('路面電車は急な勾配を許す', () => {
  // 併用軌道は道路の勾配に従うので、本線と同じには平せない
  const rail = straightRail(5);
  const slope = (p: LatLng) => {
    const i = Math.round((p.lng - 137.73) * 111_320 * Math.cos((34.7 * Math.PI) / 180) / 40);
    return i * 2;
  };
  const asRail = levelRailHeights(rail.path, slope, 'rail');
  const asTram = levelRailHeights(rail.path, slope, 'tram');
  const rise = (v: number[]) => v[v.length - 1] - v[0];
  assert.ok(rise(asTram) > rise(asRail), '路面電車のほうが緩められている');
});

test('道床は路盤に食い込ませて、上面が地表に出るようにする', () => {
  // 地形の標高は格子から補間するので数十センチずれる（実測で最大 0.25m）。
  // 下端を沈めておかないと、道床 0.4m がまるごと地面に入る
  const shapes = railShapes(straightRail(4), () => 10);
  const bed = shapes.find((s) => s.id?.includes('#bed'));
  assert.ok(bed && bed.kind === 'extrusion');
  if (!bed || bed.kind !== 'extrusion') return;

  const bottom = bed.path[0].alt ?? 0;
  assert.ok(bottom < 10, `道床の下端が路盤より上にある: ${bottom}`);
  // 断面の一番上が、路盤から 0.4m 出ている
  const top = bottom + Math.max(...bed.section.map((p) => p.y));
  assert.ok(Math.abs(top - 10.4) < 0.01, `道床の上面が ${top.toFixed(2)}m`);
  // 地形が 0.25m 高く出ても、上面は地表より上に残る
  assert.ok(top > 10.25, '実測の最大のずれで埋まってしまう');
});

test('レールは道床の上面に載る', () => {
  const shapes = railShapes(straightRail(4), () => 10);
  const rails = shapes.filter((s) => s.id?.includes('#rail'));
  assert.equal(rails.length, 2, 'レールが 2 本でない');
  for (const r of rails) {
    if (r.kind !== 'extrusion') return assert.fail('レールが押し出しでない');
    assert.ok(Math.abs((r.path[0].alt ?? 0) - 10.4) < 0.01, 'レールが浮くか埋まっている');
  }
});

test('軌間は種別で変わる', () => {
  // 出典: 在来線 1,067mm（狭軌）/ 新幹線 1,435mm（標準軌）
  const gaugeOf = (rail: RailPiece) => {
    const rails = railShapes(rail, () => 0).filter((s) => s.id?.includes('#rail'));
    const [a, b] = rails.map((r) => (r.kind === 'extrusion' ? r.path[0] : null));
    if (!a || !b) return 0;
    const cos = Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * 111_320 * cos);
  };
  assert.ok(Math.abs(gaugeOf(straightRail(3)) - 1.067) < 0.02, '在来線の軌間');
  assert.ok(
    Math.abs(gaugeOf(straightRail(3, { highspeed: true })) - 1.435) < 0.02,
    '新幹線の軌間',
  );
});

test('枕木を実寸で並べる', () => {
  // 出典: PC まくらぎ 2.0m × 0.24m × 0.2m。
  // 在来線 1 級線は 1km あたり 1,850 本 ＝ 間隔 0.54m
  const shapes = railShapes(straightRail(3), () => 10);
  const ties = shapes.filter((s) => s.id?.includes('#tie'));
  assert.ok(ties.length > 100, `枕木が ${ties.length} 本しかない`);

  const tie = ties[0];
  if (tie.kind !== 'box') return assert.fail('枕木が箱でない');
  assert.ok(Math.abs(tie.size.x - 0.24) < 0.01, '枕木の幅');
  assert.ok(Math.abs(tie.size.y - 2.0) < 0.01, '枕木の長さ');
  assert.ok(Math.abs(tie.size.z - 0.2) < 0.01, '枕木の厚み');

  // 間隔が 0.54m 前後
  const cos = Math.cos((34.7 * Math.PI) / 180);
  const dist = (a: SceneShape, b: SceneShape) => {
    if (a.kind !== 'box' || b.kind !== 'box') return 0;
    return Math.hypot(
      (b.centre.lat - a.centre.lat) * 111_320,
      (b.centre.lng - a.centre.lng) * 111_320 * cos,
    );
  };
  assert.ok(Math.abs(dist(ties[0], ties[1]) - 0.54) < 0.05, '枕木の間隔');
});

test('遠いときは枕木を描かない', () => {
  // 幅 0.24m は 250m 離れると 1 画素を割る。描いても見えない
  const near = railShapes(straightRail(3), () => 10, railDetailForHeight(50));
  const mid = railShapes(straightRail(3), () => 10, railDetailForHeight(150));
  const far = railShapes(straightRail(3), () => 10, railDetailForHeight(400));
  const ties = (list: ReturnType<typeof railShapes>) =>
    list.filter((s) => s.id?.includes('#tie')).length;

  assert.ok(ties(near) > ties(mid), '中距離で減っていない');
  assert.equal(ties(far), 0, '遠いのに枕木を描いている');
  // 減っても道床とレールは残る
  assert.ok(far.length >= 3, '線路そのものが消えた');
});

test('間引きは 2 の冪で行う', () => {
  // 半端な比率だと、詳細度が戻ったときに枕木が横滑りして見える
  const near = railDetailForHeight(50).sleeperStep;
  const mid = railDetailForHeight(150).sleeperStep;
  assert.ok(Math.abs(mid / near - 2) < 1e-6, `${near} → ${mid}`);
});

test('架線柱は電化されている線路にだけ立てる', () => {
  // OSM に electrified が無い線路に架線柱を立てるのは、
  // 実在しない構造物を作ることになる
  const withoutTag = railShapes(straightRail(20), () => 10);
  assert.equal(withoutTag.filter((s) => s.id?.includes('#pole')).length, 0);

  const notElectric = railShapes(straightRail(20, { electrified: false }), () => 10);
  assert.equal(notElectric.filter((s) => s.id?.includes('#pole')).length, 0);

  const electric = railShapes(straightRail(20, { electrified: true }), () => 10);
  const poles = electric.filter((s) => s.id?.includes('#pole'));
  assert.ok(poles.length > 0, '電化区間なのに架線柱が無い');

  // 出典: 電車線路設備の標準（架線 5.0m 以上、柱の頂部は 6.5m 前後）
  const pole = poles[0];
  if (pole.kind !== 'revolved') return assert.fail('架線柱が回転体でない');
  assert.ok(Math.abs(pole.height - 6.5) < 0.01, '架線柱の高さ');
  assert.ok(Math.abs((pole.base.alt ?? 0) - 10) < 0.01, '架線柱が浮くか埋まっている');
});

test('架線柱は線路の外に立てる', () => {
  // 建築限界の中に柱を立てると、車両とぶつかる
  const rail = straightRail(20, { electrified: true, tracks: 2 });
  const shapes = railShapes(rail, () => 10);
  const poles = shapes.filter((s) => s.id?.includes('#pole'));
  const cos = Math.cos((34.7 * Math.PI) / 180);

  for (const pole of poles.slice(0, 4)) {
    if (pole.kind !== 'revolved') continue;
    // 線路の中心線（緯度 34.7）からの距離
    const offset = Math.abs(pole.base.lat - 34.7) * 111_320;
    // 複線の外側 + 建築限界の余裕。軌道中心の間隔 4.1m の半分 + 1.9m
    assert.ok(offset > 3.5, `柱が線路に近すぎる: ${offset.toFixed(1)}m`);
    assert.ok(offset < 8, `柱が離れすぎている: ${offset.toFixed(1)}m`);
    void cos;
  }
});

test('高架と地下の線路は地表に描かない', () => {
  assert.equal(railShapes(straightRail(4, { elevated: true }), () => 10).length, 0);
  assert.equal(railShapes(straightRail(4, { underground: true }), () => 10).length, 0);
});

test('地形が取れなくても線路は出る', () => {
  // 標高が NaN で返ることがある。平地として扱う
  const shapes = railShapes(straightRail(4), () => Number.NaN);
  assert.ok(shapes.length > 0);
  for (const s of shapes) {
    if (s.kind === 'extrusion') {
      for (const p of s.path) assert.ok(Number.isFinite(p.alt ?? 0), '高さが NaN');
    }
  }
});
