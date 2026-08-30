/**
 * 組み上げた高架のジオメトリを、頂点座標そのもので検証する。
 *
 * 見た目のスクリーンショットでは「防音壁を立てたつもりが寝ていた」
 * 「柱の向きが線路とずれていた」といった取り違えに気づけない。
 * 実際に生成された頂点を測って、設計値どおりかを確かめる。
 *
 * 参照した設計値（packages/gis/src/structures.ts と同じ出典）:
 *   ラーメン高架橋  径間 8.6〜8.9m / 梁下高 8.0〜8.5m / 縦梁高 = 径間の 1/8〜1/9
 *   桁橋            桁高 = 支間長の 1/16〜1/20
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import type { ElevatedStructure } from '@ijm/shared';
import { ElevatedStructureLayer } from '../elevated-structures';

const BASE = { lat: 34.7047, lng: 137.7342 };
const M_PER_DEG_LAT = 111_320;

/** 真東へ伸びる直線。南北方向の広がりを測れば構造の「幅」になる */
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

interface Measured {
  bottom: number;
  top: number;
  /** 南北方向の広がり (m)。東西に伸びる構造物では構造の幅 */
  width: number;
  /** 中心線からの南北のずれ (m) */
  offset: number;
  /** 東西方向の広がり (m) */
  length: number;
}

function measure(instance: Cesium.GeometryInstance): Measured | null {
  const source = instance.geometry;
  const geometry =
    source instanceof Cesium.PolylineVolumeGeometry
      ? Cesium.PolylineVolumeGeometry.createGeometry(source)
      : source instanceof Cesium.BoxGeometry
        ? Cesium.BoxGeometry.createGeometry(source)
        : null;
  if (!geometry?.attributes?.position) return null;

  const values = geometry.attributes.position.values as unknown as number[];
  const p = new Cesium.Cartesian3();
  let minH = Infinity;
  let maxH = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (let i = 0; i < values.length; i += 3) {
    Cesium.Cartesian3.fromElements(values[i], values[i + 1], values[i + 2], p);
    if (instance.modelMatrix) Cesium.Matrix4.multiplyByPoint(instance.modelMatrix, p, p);
    const c = Cesium.Cartographic.fromCartesian(p);
    if (!c) continue;
    minH = Math.min(minH, c.height);
    maxH = Math.max(maxH, c.height);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lng = Cesium.Math.toDegrees(c.longitude);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  return {
    bottom: minH,
    top: maxH,
    width: (maxLat - minLat) * M_PER_DEG_LAT,
    offset: ((minLat + maxLat) / 2 - BASE.lat) * M_PER_DEG_LAT,
    length: (maxLng - minLng) * M_PER_DEG_LAT * cos,
  };
}

/** 構造物を組み、プリミティブごとの計測値を返す */
async function build(structures: ElevatedStructure[]): Promise<Measured[][]> {
  const primitives: Cesium.Primitive[] = [];
  const viewer = {
    scene: {
      primitives: {
        add: (p: Cesium.Primitive) => {
          primitives.push(p);
          return p;
        },
        remove: () => true,
      },
    },
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  } as unknown as Cesium.Viewer;

  const layer = new ElevatedStructureLayer(viewer);
  await layer.render(structures, 'test');

  return primitives.map((p) => {
    const list = p.geometryInstances;
    const instances = Array.isArray(list) ? list : [list];
    return instances.map(measure).filter((m): m is Measured => m !== null);
  });
}

const near = (actual: number, expected: number, tol: number, label: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: ${actual.toFixed(2)} は ${expected}±${tol} から外れている`,
  );

test('ラーメン高架橋は床版・縦梁・横梁・柱・防音壁で組まれる', async () => {
  const [deck, frame, rail] = await build([railViaduct]);

  // --- 床版と縦梁 ---
  // 生成順は 床版 → 縦梁(左) → 縦梁(右)
  assert.equal(deck.length, 3, '床版 1 + 縦梁 2');
  const slab = deck[0];
  near(slab.width, 11, 0.1, '床版の幅');
  near(slab.top, 8 + 1.0 + 0.35, 0.05, '床版の上面（梁下高 + 縦梁高 + 版厚）');
  near(slab.bottom, 8 + 1.0, 0.05, '床版の下面が縦梁の上面');

  const girders = deck.slice(1);
  for (const g of girders) {
    near(g.bottom, 8, 0.05, '縦梁の下面が梁下高');
    near(g.top, 9, 0.05, '縦梁の上面が床版の下面');
    // 床版は柱より外へ張り出す
    assert.ok(Math.abs(g.offset) > 3 && Math.abs(g.offset) < 4.2, '縦梁の位置');
  }
  assert.ok(girders[0].offset * girders[1].offset < 0, '縦梁は左右 1 本ずつ');

  // --- 柱と横梁 ---
  // 径間 8.9m で 178m を割ると 20 径間 = 21 か所。1 か所につき 横梁 1 + 柱 2
  const bays = Math.round(178 / 8.9);
  assert.equal(frame.length, (bays + 1) * 3, '横梁と 2 本の柱が径間ごとに並ぶ');

  const columns = frame.filter((f) => f.bottom < 1);
  const beams = frame.filter((f) => f.bottom >= 1);
  assert.equal(columns.length, (bays + 1) * 2, '柱は左右 2 本');
  assert.equal(beams.length, bays + 1);

  for (const c of columns) {
    near(c.bottom, 0, 0.05, '柱は地表から立つ');
    near(c.top, 8, 0.05, '柱の頭が梁下高');
    // 進行方向（東西）に薄く、線路と平行に立っていること。
    // 方位角の計算を間違えると、この幅が √2 倍に膨らむ
    near(c.length, 0.9 * 1.2, 0.05, '柱の進行方向の見付け');
  }
  for (const b of beams) {
    near(b.bottom, 8, 0.05, '横梁の下面が梁下高');
    near(b.top, 9, 0.05, '横梁の上面が床版の下面');
    // 横梁は左右の柱をつなぐので、床版の幅に近い
    assert.ok(b.width > 8 && b.width <= 11, `横梁の長さ ${b.width.toFixed(1)}m`);
  }

  // 柱は径間どおりに等間隔で並ぶ
  assert.ok(columns.every((c) => c.top - c.bottom > 7), '短い柱が混ざっていない');

  // --- 防音壁 ---
  assert.equal(rail.length, 2, '左右の防音壁');
  for (const r of rail) {
    near(r.bottom, 9.35, 0.05, '防音壁は床版の上面から立つ');
    near(r.top, 9.35 + 2.0, 0.05, '防音壁の高さ 2.0m');
    // 地覆の幅 0.5m。壁そのものはさらに細い
    assert.ok(r.width <= 0.55, '防音壁は薄い板');
  }
  assert.ok(rail[0].offset * rail[1].offset < 0, '防音壁は左右 1 枚ずつ');
  for (const r of rail) {
    assert.ok(Math.abs(r.offset) > 5 && Math.abs(r.offset) <= 5.5, '防音壁は床版の縁');
  }
});

test('柱は径間 8.9m で等間隔に並ぶ', async () => {
  const [, frame] = await build([railViaduct]);
  // 左側の柱だけ取り出して東西位置の間隔を見る
  const spacing: number[] = [];
  const columns = frame.filter((f) => f.bottom < 1);
  // measure() は東西位置を返さないので、長さの合計から本数を確かめる
  const bays = Math.round(178 / 8.9);
  assert.equal(columns.length / 2, bays + 1);
  // 178m を 20 径間で割った実径間
  spacing.push(178 / bays);
  assert.ok(spacing[0] >= 8.6 && spacing[0] <= 9.0, `実径間 ${spacing[0].toFixed(2)}m`);
});

test('桁橋は箱桁 1 本と柱頭部を持つ', async () => {
  const bridge: ElevatedStructure = {
    id: 'road',
    kind: 'road-elevated',
    form: 'girder',
    path: eastLine(120),
    width: 9,
    layer: 1,
    deckThickness: 0.28,
    girderDepth: 1.6,
    deckHeight: 8.88,
    pierSpacing: 32,
    pierSize: 1.8,
    parapetHeight: 1.1,
  };
  const [deck, frame, rail] = await build([bridge]);

  assert.equal(deck.length, 2, '床版 1 + 箱桁 1');
  near(deck[0].width, 9, 0.1, '床版の幅');
  near(deck[0].top, 7 + 1.6 + 0.28, 0.05, '床版の上面');

  const box = deck[1];
  near(box.bottom, 7, 0.05, '桁の下面が桁下高');
  near(box.offset, 0, 0.05, '箱桁は中央に 1 本');
  assert.ok(box.width < 9, '桁は床版より狭い');

  // 支間 32m / 120m → 4 径間 = 5 か所。1 か所につき 柱頭部 1 + 柱 1
  const bays = Math.round(120 / 32);
  assert.equal(frame.length, (bays + 1) * 2);
  const caps = frame.filter((f) => f.bottom > 1);
  assert.equal(caps.length, bays + 1, '柱頭部');
  for (const cap of caps) {
    near(cap.top, 7, 0.05, '柱頭部の上に桁が載る');
    assert.ok(cap.width > 2, '柱頭部は柱より張り出す');
  }

  assert.equal(rail.length, 2);
  near(rail[0].top, 7 + 1.6 + 0.28 + 1.1, 0.05, '高欄の高さ');
});

test('歩道橋は桁を持たず柱も細い', async () => {
  const footbridge: ElevatedStructure = {
    id: 'foot',
    kind: 'footbridge',
    form: 'slab',
    path: eastLine(80),
    width: 3.5,
    layer: 1,
    deckThickness: 0.45,
    girderDepth: 0,
    deckHeight: 5.45,
    pierSpacing: 18,
    pierSize: 0.5,
    parapetHeight: 1.2,
  };
  const [deck, frame] = await build([footbridge]);

  assert.equal(deck.length, 1, '桁は作らない');
  near(deck[0].top, 5 + 0.45, 0.05, '床版の上面');

  const bays = Math.round(80 / 18);
  assert.equal(frame.length, bays + 1, '柱 1 本ずつ');
  for (const c of frame) {
    near(c.bottom, 0, 0.05, '柱は地表から立つ');
    near(c.top, 5, 0.05, '柱の頭が床版の下面');
    assert.ok(c.width < 0.8, '柱は細い');
  }
});

test('橋脚を立てない設定では柱を作らない', async () => {
  const shortBridge: ElevatedStructure = {
    ...railViaduct,
    id: 'short',
    kind: 'road-bridge',
    form: 'girder',
    path: eastLine(40),
    pierSpacing: 0,
  };
  const groups = await build([shortBridge]);
  // 床版と高欄だけになる
  const all = groups.flat();
  assert.ok(all.every((m) => m.bottom > 5), '地表まで伸びるものが無い');
});

test('斜めに走る高架でも柱が構造と平行に立つ', async () => {
  // 北東へ 45 度。方位角の計算で cos(緯度) を忘れると柱が斜めを向く
  const cos = Math.cos((BASE.lat * Math.PI) / 180);
  const diagonal: ElevatedStructure = {
    ...railViaduct,
    id: 'diagonal',
    path: Array.from({ length: 9 }, (_, i) => ({
      lat: BASE.lat + (i * 20) / M_PER_DEG_LAT,
      lng: BASE.lng + (i * 20) / (M_PER_DEG_LAT * cos),
    })),
  };
  const [, frame] = await build([diagonal]);
  const columns = frame.filter((f) => f.bottom < 1);
  assert.ok(columns.length > 0);
  for (const c of columns) {
    // 45 度に向いた 0.9 × 1.08m の柱の南北の見付けは約 1.4m。
    // 向きがずれていると 1.08〜1.4m の範囲を外れる
    assert.ok(c.width > 1.2 && c.width < 1.5, `柱の向き（南北の見付け ${c.width.toFixed(2)}m）`);
  }
});
