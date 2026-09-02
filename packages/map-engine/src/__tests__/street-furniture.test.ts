/**
 * 街路樹・街灯・ベンチの入れ替えの検証。
 *
 * ここで見ているのは見た目ではなく「消えている時間があるかどうか」。
 * 組み立ては地形の標高取得を挟むので数秒かかる。その間に古いものを
 * 消してしまうと、範囲を取り直すたびに街路樹が丸ごと消えて
 * ちらついて見える。実際にそう見えるという指摘を受けて直した。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Cesium from 'cesium';
import type { BBox } from '@ijm/shared';
import { StreetFurnitureLayer, type FurniturePoint } from '../street-furniture';

const BBOX: BBox = [137.73, 34.7, 137.74, 34.71];
const OTHER: BBox = [137.74, 34.71, 137.75, 34.72];

/** 浜松駅北の街路樹を模した並び（位置そのものは検証に使わない） */
const trees: FurniturePoint[] = Array.from({ length: 12 }, (_, i) => ({
  lat: 34.705 + i * 0.0001,
  lng: 137.734,
  kind: 'tree',
}));

/**
 * 入れ替えの検証用。
 *
 * scene に出ているものを集合で持ち、Primitive.ready を外から切り替える。
 * 実際の Cesium では ready は描画ループが update() を回して初めて立つので、
 * 「まだ組み上がっていない」状態をここで再現する。
 */
function harness() {
  const live = new Set<Cesium.Primitive>();
  let ready = true;
  // 破棄後に触ったら分かるよう、mock 側で例外を投げる
  let destroyed = false;
  const viewer = {
    scene: {
      primitives: {
        add: (p: Cesium.Primitive) => {
          if (destroyed) throw new Error('破棄済みの scene に add した');
          live.add(p);
          Object.defineProperty(p, 'ready', { get: () => ready, configurable: true });
          return p;
        },
        remove: (p: Cesium.Primitive) => {
          if (destroyed) throw new Error('破棄済みの scene から remove した');
          return live.delete(p);
        },
      },
      requestRender: () => {
        if (destroyed) throw new Error('破棄済みの scene に requestRender した');
      },
      isDestroyed: () => destroyed,
    },
    isDestroyed: () => destroyed,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  } as unknown as Cesium.Viewer;

  return {
    live,
    viewer,
    setReady: (v: boolean) => {
      ready = v;
    },
    /** viewer を破棄する（都市の切り替えや画面を離れたときに起きる） */
    destroy: () => {
      destroyed = true;
    },
    /** 条件が満たされるまで待つ（最大 2 秒） */
    async until(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 200 && !cond(); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

test('街路樹は組み上がってから入れ替わる', async () => {
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);

  await layer.build(trees, BBOX);
  const first = [...h.live];
  assert.equal(first.length, 1, '1 つのプリミティブにまとめる');
  assert.ok(layer.hasLoaded(BBOX), '読み込み済みとして記録される');

  h.setReady(false);
  const second = layer.build(trees, OTHER);
  await h.until(() => h.live.size > 1);
  assert.ok(h.live.has(first[0]), '組み上がる前に古い街路樹が消えている');

  h.setReady(true);
  await second;
  assert.ok(!h.live.has(first[0]), '入れ替えたのに古いものが残っている');
  assert.equal(h.live.size, 1, '新しいものだけが残る');
  assert.ok(layer.hasLoaded(OTHER), '新しい範囲が記録されていない');
});

test('表示を切ったら、組み立て中のものも出てこない', async () => {
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);

  h.setReady(false);
  const pending = layer.build(trees, BBOX);
  await h.until(() => h.live.size > 0);

  layer.clear();
  h.setReady(true);
  await pending;
  assert.equal(h.live.size, 0, '切ったあとに組み上がったものが現れた');
  assert.ok(!layer.hasLoaded(BBOX), '切ったのに読み込み済みのまま');
});

test('上限が 0 のときは何も出さない', async () => {
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 0);
  await layer.build(trees, BBOX);
  assert.equal(h.live.size, 0);
});

test('上限を 0 にすると、出ているものを消す', async () => {
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);
  await layer.build(trees, BBOX);
  assert.equal(h.live.size, 1);

  layer.setMaxItems(0);
  assert.equal(h.live.size, 0);
});

test('同じ範囲を続けて要求しても、いったん消えることはない', async () => {
  // hasLoaded で弾かれる想定だが、弾き漏れても消えないことを確かめる
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);

  await layer.build(trees, BBOX);
  const first = [...h.live][0];

  h.setReady(false);
  const again = layer.build(trees, BBOX);
  await h.until(() => h.live.size > 1);
  assert.ok(h.live.has(first), '同じ範囲の組み直しで消えている');

  h.setReady(true);
  await again;
  assert.equal(h.live.size, 1);
});

test('組み立て中に画面を離れても落ちない', async () => {
  // 組み立ては地形の標高取得を挟むので数秒かかる。その間に都市を切り替えたり
  // 画面を離れたりすると viewer が破棄される。破棄後の scene に触ると
  // 例外になり、「読み込み中に操作すると落ちる」という形で出る
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);

  h.setReady(false);
  const pending = layer.build(trees, BBOX);
  await h.until(() => h.live.size > 0);

  h.destroy();
  h.setReady(true);
  // 例外が投げられないこと。ここで落ちるなら実機でも落ちる
  await pending;
});

test('破棄されたあとに clear しても落ちない', async () => {
  const h = harness();
  const layer = new StreetFurnitureLayer(h.viewer, 500);
  await layer.build(trees, BBOX);
  h.destroy();
  layer.clear();
});
