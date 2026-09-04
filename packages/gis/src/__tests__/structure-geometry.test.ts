/**
 * 高架の寸法の検証（描画エンジンに依存しない層）。
 *
 * ここは形の記述（SceneShape）を直接測る。断面の座標と経路の高さを
 * そのまま読めるので、Cesium を通さずに設計値どおりかを確かめられる。
 *
 * 描画側（packages/map-engine）のテストは、この記述が Cesium の
 * 頂点として正しく置かれるかを見ている。二段構えにしてあるのは、
 * 「断面は正しいのに描くと上下が逆」という取り違えが実際に起きたため。
 *
 * 参照した設計値（packages/gis/src/structures.ts と同じ出典）:
 *   ラーメン高架橋  径間 8.6〜8.9m / 梁下高 8.0〜8.5m / 縦梁高 = 径間の 1/8〜1/9
 *   桁橋            桁高 = 支間長の 1/16〜1/20
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoxShape, ElevatedStructure, ExtrudedShape, SceneShape } from '@ijm/shared';
import {
  bayPositions,
  buildStructureShapes,
  heightProfile,
  girderOffsets,
  girderSection,
  parapetSection,
  pickIndices,
  pierStride,
  shade,
  slabSection,
} from '../structure-geometry';

const BASE = { lat: 34.7047, lng: 137.7342 };
const M_PER_DEG_LAT = 111_320;

/** 真東へ伸びる直線 */
function eastLine(lengthM: number, points = 9) {
  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  return Array.from({ length: points }, (_, i) => ({
    lat: BASE.lat,
    lng: BASE.lng + (i * lengthM) / (points - 1) / (M_PER_DEG_LAT * cos),
  }));
}

const railViaduct: ElevatedStructure = {
  id: 'rail',
  kind: 'rail-elevated',
  form: 'rigid-frame',
  path: eastLine(178),
  width: 11,
  layer: 1,
  deckThickness: 0.35,
  girderDepth: 1.0,
  deckHeight: 9.35,
  pierSpacing: 8.9,
  pierSize: 0.9,
  parapetHeight: 2.0,
};

/** 平地（標高 0）で組み立てる */
function build(structures: ElevatedStructure[], distances?: number[]) {
  return buildStructureShapes(structures, {
    ground: structures.map((s) => s.path.map(() => 0)),
    distances: distances ?? structures.map(() => 0),
  });
}

const isExtrusion = (s: SceneShape): s is ExtrudedShape => s.kind === 'extrusion';
const isBox = (s: SceneShape): s is BoxShape => s.kind === 'box';

const near = (actual: number, expected: number, tol: number, label: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: ${actual.toFixed(3)} は ${expected}±${tol} から外れている`,
  );

// ---- 断面 --------------------------------------------------------------

test('断面はどれも下端が y = 0 になっている', () => {
  // 描画側（PolylineVolumeGeometry）は断面を外接矩形で正規化し、
  // y の絶対値を無視して中心線から必ず上へ押し出す。
  // 下端を 0 にしておかないと、部材が意図した高さからずれる。
  // 「防音壁を立てたつもりが床版の裏にぶら下がっていた」のがこれ
  for (const [name, points] of [
    ['床版', slabSection(11, 0.35)],
    ['縦梁', girderSection(1.0, 1.0)],
    ['防音壁', parapetSection(2.0, 0.22, 0.5)],
  ] as const) {
    const minY = Math.min(...points.map((p) => p.y));
    assert.equal(minY, 0, `${name} の下端が 0 でない`);
  }
});

test('床版の断面は張り出しの先が薄い', () => {
  const points = slabSection(11, 0.35);
  const hw = 11 / 2;
  // 上面は幅いっぱい
  const top = points.filter((p) => Math.abs(p.y - 0.35) < 1e-9);
  near(Math.max(...top.map((p) => p.x)), hw, 0.01, '上面の端');
  // 下面（y = 0）は上面より内側。ここがハンチ（付け根の厚み）
  const bottom = points.filter((p) => p.y === 0);
  assert.ok(
    Math.max(...bottom.map((p) => p.x)) < hw,
    '下面が上面と同じ幅では、板がまっすぐ切り落とされて見える',
  );
});

test('縦梁の断面は下側がすぼまる', () => {
  const points = girderSection(2, 1.5);
  const top = points.filter((p) => Math.abs(p.y - 1.5) < 1e-9);
  const bottom = points.filter((p) => p.y === 0);
  assert.ok(
    Math.max(...bottom.map((p) => p.x)) < Math.max(...top.map((p) => p.x)),
    '桁は下側を絞る',
  );
});

test('防音壁の断面は地覆の上に細い壁が載る', () => {
  const height = 2.0;
  const points = parapetSection(height, 0.22, 0.5);
  // 足元（地覆）は壁より広い
  const footWidth = Math.max(...points.filter((p) => p.y === 0).map((p) => p.x)) * 2;
  const midY = height / 2;
  const wallWidth =
    Math.max(...points.filter((p) => Math.abs(p.y - midY) < 0.6).map((p) => p.x)) * 2;
  assert.ok(footWidth > wallWidth, '地覆が壁より細い');
  // 天端は指定した高さ
  near(Math.max(...points.map((p) => p.y)), height, 0.001, '壁の高さ');
});

// ---- 高さの積み上げ ----------------------------------------------------

test('高さは路面から下へ決まる', () => {
  const { deck, parapet } = build([railViaduct]);

  // 床版 1 + 縦梁（girderOffsets のぶん）
  const slab = deck.filter(isExtrusion)[0];
  // 中心線には床版の下面を渡す。下面 = 路面 - 版厚
  near(slab.path[0].alt!, 9.35 - 0.35, 0.001, '床版の下面');
  // 断面の高さが版厚
  near(Math.max(...slab.section.map((p) => p.y)), 0.35, 0.001, '版厚');

  // 縦梁の下面 = 床版の下面 - 梁高 = 梁下高。
  // 軌道（#slab / #rail）は床版の上に載るので、ここでは除く
  const girders = deck
    .filter(isExtrusion)
    .filter((g) => !g.id?.includes('#slab') && !g.id?.includes('#rail'))
    .slice(1);
  assert.ok(girders.length >= 2, '縦梁は左右 1 本ずつ以上');
  for (const g of girders) {
    near(g.path[0].alt!, 9.35 - 0.35 - 1.0, 0.001, '縦梁の下面（梁下高）');
    near(Math.max(...g.section.map((p) => p.y)), 1.0, 0.001, '梁高');
  }

  // 防音壁は床版の上面（＝路面）から立つ
  const walls = parapet.filter(isExtrusion);
  assert.equal(walls.length, 2, '左右の防音壁');
  for (const w of walls) {
    near(w.path[0].alt!, 9.35, 0.001, '防音壁は路面から立つ');
    near(Math.max(...w.section.map((p) => p.y)), 2.0, 0.001, '防音壁の高さ');
  }
});

test('起伏のある地形でも路面は波打たない', () => {
  // 20m ごとに 3m 上下する地形。そのままなぞると路面がでこぼこになる
  const path = eastLine(400, 21);
  const ground = path.map((_, i) => (i % 2 === 0 ? 0 : 3));
  const shapes = buildStructureShapes([{ ...railViaduct, path }], {
    ground: [ground],
    distances: [0],
  });
  const slab = shapes.deck.filter(isExtrusion)[0];
  const alts = slab.path.map((p) => p.alt!);

  // 隣り合う頂点の高低差が小さいこと（縦断勾配として自然な範囲）
  for (let i = 1; i < alts.length; i += 1) {
    assert.ok(
      Math.abs(alts[i] - alts[i - 1]) < 0.5,
      `路面が ${Math.abs(alts[i] - alts[i - 1]).toFixed(2)}m 跳ねている`,
    );
  }
  // どこでも地表より上（桁下高を割らない）
  for (let i = 0; i < alts.length; i += 1) {
    assert.ok(alts[i] >= ground[i], '路面が地表を割っている');
  }
});

// ---- 柱と橋台 ----------------------------------------------------------

test('ラーメン高架橋は横梁と柱が径間ごとに並ぶ', () => {
  const { frame } = build([railViaduct]);
  const boxes = frame.filter(isBox);

  // 径間 8.9m で 178m を割ると 20 径間 = 21 か所
  const bays = Math.round(178 / 8.9);
  const rows = girderOffsets(railViaduct).length;
  assert.equal(boxes.length, (bays + 1) * (1 + rows), '横梁 1 + 柱 rows 本が各径間に');

  // 柱は地表から梁下まで
  const columns = boxes.filter((b) => b.centre.alt! - b.size.z / 2 < 0.01);
  assert.equal(columns.length, (bays + 1) * rows);
  for (const c of columns) {
    near(c.centre.alt! + c.size.z / 2, 9.35 - 0.35 - 1.0, 0.01, '柱の頭が梁下高');
    near(c.size.x, 0.9, 0.001, '柱の断面（進行方向に対して横）');
  }
});

test('橋台は桁橋の両端に立ち、ラーメン高架橋には付かない', () => {
  // 実物の橋は必ず両岸に橋台があり、そこで路面と地面がつながっている。
  // 無いと床版が空中で終わり、道路から切り離されて浮いて見える
  const bridge: ElevatedStructure = {
    ...railViaduct,
    id: 'bridge',
    form: 'girder',
    path: eastLine(120),
    pierSpacing: 0, // 柱を立てない設定でも橋台は立つ
  };
  const boxes = build([bridge]).frame.filter(isBox);
  assert.equal(boxes.length, 2, '両端の橋台');
  for (const a of boxes) {
    near(a.centre.alt! - a.size.z / 2, 0, 0.05, '橋台は地表から立つ');
    near(a.centre.alt! + a.size.z / 2, 9.35 - 0.35 - 1.0, 0.05, '橋台の天端が桁の下面');
    assert.ok(a.size.x > bridge.width, '橋台は床版より少し広い');
  }

  // 延々と続く高架には付けない（端が街の外へ続くため）
  const viaduct = build([{ ...railViaduct, pierSpacing: 0 }]);
  assert.equal(viaduct.frame.length, 0);
});

test('斜めに走る高架でも柱が構造と平行を向く', () => {
  // 方位角の計算で cos(緯度) を忘れると柱が斜めを向く
  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  const diagonal: ElevatedStructure = {
    ...railViaduct,
    path: Array.from({ length: 9 }, (_, i) => ({
      lat: BASE.lat + (i * 20) / M_PER_DEG_LAT,
      lng: BASE.lng + (i * 20) / (M_PER_DEG_LAT * cos),
    })),
  };
  const boxes = build([diagonal]).frame.filter(isBox);
  assert.ok(boxes.length > 0);
  // 北東 45 度
  for (const b of boxes) {
    near(b.headingDeg, 45, 0.5, '柱の向き');
  }
});

test('遠い高架では柱を 2 の冪で間引く', () => {
  // 半端な比率で間引くと、詳細度が戻ったときに柱が横滑りして見える
  assert.equal(pierStride(0), 1);
  assert.equal(pierStride(249), 1);
  assert.equal(pierStride(250), 2);
  assert.equal(pierStride(599), 2);
  assert.equal(pierStride(600), 4);

  const close = build([railViaduct], [0]).frame.filter(isBox).length;
  const far = build([railViaduct], [700]).frame.filter(isBox).length;
  assert.ok(far < close, `遠いほうが少ない（${far} / ${close}）`);
});

test('柱の予算を超える構造物には柱を付けない', () => {
  // 途中から柱が消えると、そこだけ床版が宙に浮いて見える。
  // 1 本ぶんまるごと入らないなら、その構造物には付けない
  const shapes = buildStructureShapes([railViaduct], {
    ground: [railViaduct.path.map(() => 0)],
    distances: [0],
    frameBudget: 10,
  });
  assert.equal(shapes.frame.length, 0);
  // 床版と防音壁は必ず出る（遠くの高架が消えることはない）
  assert.ok(shapes.deck.length > 0);
  assert.ok(shapes.parapet.length > 0);
});

// ---- 補助 --------------------------------------------------------------

test('柱の位置は端から端まで等間隔に割り付ける', () => {
  // 余りの半端な径間を作らないよう、径間を微調整する
  const positions = bayPositions(178, 8.9);
  assert.equal(positions.length, 21, '20 径間 = 21 か所');
  assert.equal(positions[0], 0, '始点に柱');
  near(positions[positions.length - 1], 178, 0.001, '終点に柱');
  const spacing = positions[1] - positions[0];
  assert.ok(spacing >= 8.6 && spacing <= 9.0, `実径間 ${spacing.toFixed(2)}m`);
  for (let i = 1; i < positions.length; i += 1) {
    near(positions[i] - positions[i - 1], spacing, 1e-9, '径間が不揃い');
  }
});

test('床版が広いほど柱の列が増える', () => {
  // 2 本のまま広い床版を載せると、見るからに支えきれない形になる。
  // 実物にならって、およそ 8m ごとに 1 列
  const narrow = girderOffsets({ ...railViaduct, width: 11 });
  const wide = girderOffsets({ ...railViaduct, width: 30 });
  assert.equal(narrow.length, 2, '複線幅は 2 柱式');
  assert.ok(wide.length > narrow.length, '広い床版には柱の列が増える');
  // 左右対称
  for (const offsets of [narrow, wide]) {
    near(offsets[0], -offsets[offsets.length - 1], 1e-9, '左右対称でない');
  }
});

test('明度を変えた色が範囲を外れない', () => {
  assert.equal(shade('#b8b4ad', 0), '#b8b4ad');
  assert.equal(shade('#000000', 0.5), '#000000');
  assert.equal(shade('#ffffff', 1), '#000000');
  assert.equal(shade('#000000', 1, true), '#ffffff');
  // 桁は床版より暗く、防音壁は明るく
  const deck = '#b8b4ad';
  assert.ok(shade(deck, 0.18) < deck, '桁が床版より暗くない');
  assert.ok(shade(deck, 0.18, true) > deck, '防音壁が床版より明るくない');
  // 6 桁の 16 進に収まる
  for (const c of [shade(deck, 0.18), shade(deck, 0.18, true)]) {
    assert.match(c, /^#[0-9a-f]{6}$/);
  }
});

// ---- 壊れたデータへの備え ----------------------------------------------

test('1 点しか選べないときに添字が壊れない', () => {
  // (max - 1) が 0 になり、0 除算で NaN が並んでいた
  assert.deepEqual(pickIndices(5, 1), [0]);
  assert.deepEqual(pickIndices(0, 0), []);
  assert.deepEqual(pickIndices(3, 0), []);
  for (const [len, max] of [
    [0, 0],
    [1, 5],
    [5, 1],
    [10, 10],
    [100, 8],
  ] as const) {
    for (const i of pickIndices(len, max)) {
      assert.ok(Number.isInteger(i) && i >= 0 && i < len, `添字 ${i} が範囲外`);
    }
  }
});

test('寸法が 0 以下でも形として成立させる', () => {
  // OSM の幅や柱の太さに 0 が入っていることがある。
  // 大きさの無い（あるいは裏返った）直方体を渡すと描画側で消える
  for (const broken of [
    { ...railViaduct, width: 0 },
    { ...railViaduct, width: -3 },
    { ...railViaduct, pierSize: 0 },
    { ...railViaduct, deckThickness: 0 },
  ]) {
    const out = build([broken]);
    for (const s of [...out.deck, ...out.frame, ...out.parapet]) {
      if (s.kind !== 'box') continue;
      assert.ok(s.size.x > 0 && s.size.y > 0 && s.size.z > 0, `寸法 ${JSON.stringify(s.size)}`);
    }
  }
});

test('地形が取れなくても NaN の形を作らない', () => {
  // 標高の取得に失敗すると NaN が返る。そのまま進むと床版の高さも
  // 柱の位置もすべて NaN になり、描画側では何も出ない
  const out = buildStructureShapes([railViaduct], {
    ground: [railViaduct.path.map(() => Number.NaN)],
    distances: [0],
  });
  for (const s of [...out.deck, ...out.frame, ...out.parapet]) {
    if (s.kind === 'extrusion') {
      for (const p of s.path) assert.ok(Number.isFinite(p.alt), '経路の高さが NaN');
    } else if (s.kind === 'box') {
      assert.ok(Number.isFinite(s.centre.alt), '直方体の高さが NaN');
      assert.ok(Number.isFinite(s.headingDeg), '方位角が NaN');
    }
  }
  // 地形の配列が短くても落ちない
  buildStructureShapes([railViaduct], { ground: [[]], distances: [0] });
  buildStructureShapes([railViaduct], { ground: [], distances: [] });
});

// ---- 高架へ上がる階段 --------------------------------------------------
//
// 歩道橋・ペデストリアンデッキは必ずどこかで地表とつながっている。
// その階段が無いと、デッキだけが空中に浮いて上がる手段が無くなる。
//
// 見た目では「段が地面に埋まっている」「上がりきる前に終わっている」に
// 気づけないので、段の座標そのものを測る。
//
// 寸法の出典:
//   蹴上げ 0.15m 以下 … 立体横断施設技術基準・同解説（日本道路協会）
//   踏面   0.21m 以上 … 建築基準法施行令 第 23 条（一般的な階段の下限）

/** 地表から高さ h まで、水平距離 runM で上がる階段 */
function stair(runM: number, h: number): ElevatedStructure {
  return {
    id: 'stair',
    kind: 'stair',
    form: 'stair',
    path: eastLine(runM, 3),
    width: 2,
    layer: 1,
    deckThickness: 0.25,
    girderDepth: 0,
    deckHeight: h,
    startHeight: 0,
    pierSpacing: 6,
    pierSize: 0.4,
    parapetHeight: 1.1,
  };
}

/** 平地 12m の上に組み立てる */
function onFlatGround(s: ElevatedStructure, distanceM = 50) {
  return buildStructureShapes([s], {
    ground: [s.path.map(() => 12)],
    distances: [distanceM],
  });
}

test('階段は地表から接続先の路面まで、段を刻んで上がる', () => {
  // 浜松駅前のペデストリアンデッキ（路面 5.6m）に上がる 12.3m の階段
  const built = onFlatGround(stair(12.3, 5.6));
  const steps = built.deck.filter((s): s is BoxShape => s.kind === 'box');

  assert.ok(steps.length > 0, '段が 1 つも作られていない');
  // 蹴上げは基準の上限以下
  for (const step of steps) {
    assert.ok(step.size.z <= 0.1501, `蹴上げが基準超え: ${step.size.z}m`);
  }
  // 踏面も下限以上
  for (const step of steps) {
    assert.ok(step.size.y >= 0.21, `踏面が基準未満: ${step.size.y}m`);
  }

  const tops = steps.map((s) => (s.centre.alt ?? 0) + s.size.z / 2);
  const lowest = Math.min(...tops);
  const highest = Math.max(...tops);

  // 最下段は地表のすぐ上（1 段ぶん）。埋まっても浮いてもいない
  assert.ok(
    Math.abs(lowest - (12 + 5.6 / steps.length)) < 0.01,
    `最下段が地表から離れている: ${lowest}`,
  );
  // 最上段は接続先の路面と同じ高さ。ここが合わないとデッキとの間に段差ができる
  assert.ok(Math.abs(highest - 17.6) < 0.01, `上がりきっていない: ${highest}`);
});

test('段は単調に上がる', () => {
  // 途中で下がると、その 1 段だけ床に埋まって見える
  const built = onFlatGround(stair(15.7, 5.6));
  const steps = built.deck.filter((s): s is BoxShape => s.kind === 'box');
  const tops = steps.map((s) => (s.centre.alt ?? 0) + s.size.z / 2);
  for (let i = 1; i < tops.length; i += 1) {
    assert.ok(tops[i] > tops[i - 1], `${i} 段目で下がっている`);
  }
});

test('平面形が短すぎるときは段を作らない', () => {
  // 4.6m の平面形で 5.6m 上がるには、踏面が 0.12m の階段が要る。
  // 実物には踊り場や折り返しがあり、OSM がそこまで描いていないということ。
  // 無い折り返しを作るのは創作なので、斜めの構造だけを出す
  const built = onFlatGround(stair(4.6, 5.6));
  assert.equal(built.deck.filter((s) => s.kind === 'box').length, 0, '段を作ってしまっている');
  // 斜めの段裏（と手すり）は出る。上がる構造があること自体は分かる
  assert.ok(built.deck.some((s) => s.kind === 'extrusion'), '段裏が無い');
  assert.ok(built.parapet.length > 0, '手すりが無い');
});

test('離れたら段を 1 つずつ作らない', () => {
  // 踏面 0.3m は 300m 離れると画面上で 1 画素になり、段は見て取れない
  const near = onFlatGround(stair(12.3, 5.6), 50);
  const far = onFlatGround(stair(12.3, 5.6), 400);
  assert.ok(near.deck.filter((s) => s.kind === 'box').length > 30);
  assert.equal(far.deck.filter((s) => s.kind === 'box').length, 0);
  // 段裏と手すりは遠くでも残る（無くすと歩道橋が空中で途切れる）
  assert.ok(far.deck.some((s) => s.kind === 'extrusion'));
  assert.ok(far.parapet.length > 0);
});

test('段裏と手すりは起点から終点へ斜めに上がる', () => {
  const built = onFlatGround(stair(12.3, 5.6));
  const slab = built.deck.find((s): s is ExtrudedShape => s.kind === 'extrusion');
  assert.ok(slab, '段裏が無い');
  const alts = slab.path.map((p) => p.alt ?? 0);
  // 起点は地表付近（版厚のぶんだけ下）、終点は接続先の路面 − 版厚
  assert.ok(Math.abs(alts[0] - (12 - 0.25)) < 0.01, `起点の高さ: ${alts[0]}`);
  assert.ok(Math.abs(alts[alts.length - 1] - (17.6 - 0.25)) < 0.01, `終点の高さ: ${alts[alts.length - 1]}`);
  for (let i = 1; i < alts.length; i += 1) {
    assert.ok(alts[i] > alts[i - 1], '段裏が上がっていない');
  }

  // 手すりは両側に 1 本ずつ。どちらも同じように上がる
  assert.equal(built.parapet.length, 2);
  for (const rail of built.parapet as ExtrudedShape[]) {
    const h = rail.path.map((p) => p.alt ?? 0);
    assert.ok(h[h.length - 1] - h[0] > 5, '手すりが上がっていない');
  }
});

test('階段の上端に橋台を立てない', () => {
  // 立てると、上がりきったところに壁ができてデッキへ出られなくなる。
  // 支えるのは柱の役目
  const built = onFlatGround(stair(15.7, 5.6));
  const wide = built.frame.filter((s): s is BoxShape => s.kind === 'box' && s.size.x > 1.5);
  assert.equal(wide.length, 0, '橋台らしい幅広の箱がある');
});

test('上がらない階段は段を作らない', () => {
  // 高架の上を歩く通路を階段と取り違えると、平らな面に段が並ぶ
  const flat = { ...stair(12, 5.6), startHeight: 5.6 };
  assert.equal(onFlatGround(flat).deck.filter((s) => s.kind === 'box').length, 0);
});

test('路面の高さは起点から終点へ直線的に上がる', () => {
  // ふつうの高架は全長にわたって同じ高さ。startHeight があるものだけ上がる
  assert.deepEqual(heightProfile(9.4, undefined, [0, 50, 100]), [9.4, 9.4, 9.4]);
  assert.deepEqual(heightProfile(6, 0, [0, 5, 10]), [0, 3, 6]);
  // 長さ 0 で 0 除算にならない（NaN が高さに混ざると何も描かれなくなる）
  assert.deepEqual(heightProfile(6, 0, [0, 0]), [6, 6]);
  assert.deepEqual(heightProfile(6, 0, []), []);
  for (const v of heightProfile(6, Number.NaN, [0, 5, 10])) {
    assert.ok(Number.isFinite(v), '高さが NaN になっている');
  }
});

// ---- 盛土・取付部 ------------------------------------------------------
//
// OSM が embankment=yes と書いているのは「土を盛って持ち上げてある」
// という意味で、柱の上に載っているという意味ではない。柱を並べると
// 実在しない構造物になる（実測では新幹線の盛土区間を高架橋にしていた）。
//
// 普通の道から高架へ上がる取付部も同じ造りなので、同じ形で組み立てる。

/** 起点 startH から終点 endH まで、水平距離 runM で上がる盛土 */
function ramp(runM: number, startH: number, endH: number): ElevatedStructure {
  return {
    id: 'ramp',
    kind: 'embankment',
    form: 'ramp',
    path: eastLine(runM, 5),
    width: 9,
    layer: 1,
    deckThickness: 0.3,
    girderDepth: 0,
    deckHeight: endH,
    ...(startH === endH ? {} : { startHeight: startH }),
    pierSpacing: 0,
    pierSize: 0,
    parapetHeight: 1.0,
  };
}

test('盛土に柱を立てない', () => {
  // ラーメン高架橋にしていたときは径間 8.9m の柱が延々と並んでいた
  const built = onFlatGround(ramp(400, 9.4, 9.4));
  const boxes = built.frame.filter((s): s is BoxShape => s.kind === 'box');
  assert.ok(boxes.length > 0, '受けるものが何も無い');
  // 柱は細い（断面 0.9m 前後）。壁は床版とほぼ同じ幅
  for (const b of boxes) {
    assert.ok(b.size.x > 7, `柱のように細い部材がある: 幅 ${b.size.x}m`);
  }
});

test('盛土は壁で受け、その壁は地面から路面まで届く', () => {
  const built = onFlatGround(ramp(200, 9.4, 9.4));
  const walls = built.frame.filter((s): s is BoxShape => s.kind === 'box');
  for (const w of walls) {
    const bottom = (w.centre.alt ?? 0) - w.size.z / 2;
    const top = (w.centre.alt ?? 0) + w.size.z / 2;
    assert.ok(Math.abs(bottom - 12) < 0.01, `壁が地面から立っていない: ${bottom}`);
    // 路面 12+9.4、床版の厚み 0.3 を引いたところまで
    assert.ok(Math.abs(top - (12 + 9.4 - 0.3)) < 0.01, `壁が路面まで届いていない: ${top}`);
  }
});

test('取付部は地表から高架の路面まで滑らかに上がる', () => {
  const built = onFlatGround(ramp(80, 0, 5.6));
  const slab = built.deck.find((s): s is ExtrudedShape => s.kind === 'extrusion');
  assert.ok(slab, '路面が無い');
  const alts = slab.path.map((p) => p.alt ?? 0);
  // 起点は地表（床版の厚みぶん下）、終点は高架の路面
  assert.ok(Math.abs(alts[0] - (12 - 0.3)) < 0.01, `起点の高さ: ${alts[0]}`);
  assert.ok(Math.abs(alts[alts.length - 1] - (12 + 5.6 - 0.3)) < 0.01, `終点の高さ: ${alts[alts.length - 1]}`);
  // 途中で段にならず、まっすぐ上がる
  for (let i = 1; i < alts.length; i += 1) {
    assert.ok(alts[i] > alts[i - 1], `${i} 番目で上がっていない`);
  }
  const step = alts[1] - alts[0];
  for (let i = 2; i < alts.length; i += 1) {
    assert.ok(Math.abs(alts[i] - alts[i - 1] - step) < 0.01, '勾配が一定でない');
  }
});

test('取付部を受ける壁は、上がるにつれて高くなる', () => {
  const built = onFlatGround(ramp(80, 0, 5.6));
  const walls = built.frame.filter((s): s is BoxShape => s.kind === 'box');
  assert.ok(walls.length >= 2, `壁の区間が ${walls.length} しかない`);
  // 起点側は低く、終点側は高い
  const heights = walls
    .map((w) => ({ lng: w.centre.lng, h: w.size.z }))
    .sort((a, b) => a.lng - b.lng)
    .map((x) => x.h);
  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(heights[i] > heights[i - 1], `${i} 区間目で低くなっている`);
  }
  // どの壁も地面から立っている
  for (const w of walls) {
    assert.ok(Math.abs((w.centre.alt ?? 0) - w.size.z / 2 - 12) < 0.01, '壁が地面から離れている');
  }
});

test('取付部にも高欄が付く', () => {
  const built = onFlatGround(ramp(80, 0, 5.6));
  assert.equal(built.parapet.length, 2, '両側に 1 本ずつ');
  for (const rail of built.parapet as ExtrudedShape[]) {
    const h = rail.path.map((p) => p.alt ?? 0);
    assert.ok(h[h.length - 1] - h[0] > 5, '高欄が路面に追従していない');
  }
});

test('離れたら壁の区間を粗くする', () => {
  // 区間の境目は床版に覆われて見えないので、粗くしても輪郭は変わらない
  const near = onFlatGround(ramp(400, 9.4, 9.4), 50).frame.length;
  const far = onFlatGround(ramp(400, 9.4, 9.4), 800).frame.length;
  assert.ok(far < near, `遠くでも ${far} 個のまま`);
  assert.ok(far > 0, '遠くで壁が消えている');
});

test('地面すれすれの区間には壁を作らない', () => {
  const built = onFlatGround(ramp(80, 0, 0.2));
  assert.equal(built.frame.length, 0);
});

/**
 * 高架の上の軌道。
 *
 * **これが無かったので、高架の線路は床版の上に何も無く、
 * 「線路が床版に埋まっている」ように見えていた。**
 * 浜松では線路 55 本がすべて高架なので、線路が 1 本も見えていなかった
 * （実測 2026-09-04: 浜松駅周辺 1km 四方の線路 55 本 = 地表 0 / 高架 55 / 地下 0）。
 *
 * 高架橋の軌道はスラブ軌道が標準（新幹線と都市部の高架）。
 * バラスト軌道と違って道床が無く、コンクリートの軌道スラブに
 * レールを直結する。保守が要らないので高架では必ずこちらになる。
 *
 * 出典: 鉄道構造物等設計標準（軌道構造）。
 *   軌道スラブ A 形  4,930 × 2,340 × 190mm
 *   軌間            在来線 1,067mm / 新幹線 1,435mm
 *   レール          頭部幅 65mm・高さ 153mm（50kgN レール）
 */
test('高架の床版の上に軌道が載る', () => {
  const { deck } = build([railViaduct]);
  const slabs = deck.filter(isExtrusion).filter((s) => s.id?.includes('#slab'));
  const rails = deck.filter(isExtrusion).filter((s) => s.id?.includes('#rail'));

  assert.ok(slabs.length > 0, '軌道スラブが無い');
  // 幅 11m から防音壁のぶんを引いて軌道中心 4.1m で割ると 2 線
  assert.equal(slabs.length, 2, '複線ぶんの軌道スラブ');
  assert.equal(rails.length, 4, 'レールが線路 1 本につき 2 本でない');

  // 軌道スラブは床版の上面（＝路面 9.35m）に載る
  for (const slab of slabs) {
    near(slab.path[0].alt!, 9.35, 0.001, '軌道スラブが路面に載っていない');
    near(Math.max(...slab.section.map((p) => p.y)), 0.19, 0.001, '軌道スラブの厚さ');
    // 幅 2.34m
    const xs = slab.section.map((p) => p.x);
    near(Math.max(...xs) - Math.min(...xs), 2.34, 0.01, '軌道スラブの幅');
  }

  // レールはスラブの上面から立つ
  for (const rail of rails) {
    near(rail.path[0].alt!, 9.35 + 0.19, 0.001, 'レールがスラブに載っていない');
    near(Math.max(...rail.section.map((p) => p.y)), 0.153, 0.001, 'レールの高さ');
  }
});

test('軌間は路線の名前で決める', () => {
  // 新幹線かどうかは OSM の名前にしか出ていない。
  // 推測で標準軌にすると、在来線が広がって見える
  const gaugeOf = (name?: string) => {
    const { deck } = build([{ ...railViaduct, name }]);
    const rails = deck.filter(isExtrusion).filter((s) => s.id?.includes('#rail0'));
    if (rails.length < 2) return 0;
    const [a, b] = rails.map((r) => r.path[0]);
    const cos = Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * 111_320 * cos);
  };
  near(gaugeOf('東海道本線'), 1.067, 0.02, '在来線の軌間');
  near(gaugeOf('東海道新幹線'), 1.435, 0.02, '新幹線の軌間');
  // 名前が無ければ在来線として扱う（狭軌が日本の大多数）
  near(gaugeOf(undefined), 1.067, 0.02, '名前が無いときの軌間');
});

test('道路の高架には軌道を敷かない', () => {
  const { deck } = build([{ ...railViaduct, id: 'road', kind: 'road-bridge' }]);
  assert.equal(deck.filter((s) => s.id?.includes('#slab')).length, 0);
  assert.equal(deck.filter((s) => s.id?.includes('#rail')).length, 0);
});

test('上空からは軌道を落とす', () => {
  // 軌道スラブの幅 2.34m は 1,500m 上空から 1 画素を割る
  const shapes = buildStructureShapes([railViaduct], {
    ground: [railViaduct.path.map(() => 0)],
    distances: [0],
    tracks: false,
  });
  assert.equal(shapes.deck.filter((s) => s.id?.includes('#slab')).length, 0);
  // 落としても床版と防音壁は残る
  assert.ok(shapes.deck.length > 0, '床版まで消えた');
  assert.ok(shapes.parapet.length > 0, '防音壁まで消えた');
});

test('狭い高架でも線路が 1 本は載る', () => {
  // 単線の高架は幅 5m 程度。防音壁のぶんを引くと 4.0m で、
  // 軌道中心の間隔 4.1m を割る。0 本にすると線路が消える
  const { deck } = build([{ ...railViaduct, width: 5 }]);
  assert.equal(deck.filter((s) => s.id?.includes('#slab')).length, 1);
});

test('階段には軌道を敷かない', () => {
  // 階段は高架へ上がる途中で、そこに線路は無い
  const { deck } = build([{ ...railViaduct, form: 'stair', startHeight: 0 }]);
  assert.equal(deck.filter((s) => s.id?.includes('#slab')).length, 0);
});
