/**
 * 「新しいものが描けるようになってから古いものを消す」待ち合わせ。
 *
 * ここが崩れると 2 つの症状が出る。
 *
 *   - 待たずに消す  … 組み立て中の数秒間、街から建物や高架が丸ごと消える（ちらつき）
 *   - 待ち続ける    … 組み立てに失敗したとき、古いものが永久に残る
 *
 * さらに、組み立てには数秒かかるので、その間に画面を離れられる。
 * 破棄済みの scene に触ると例外になり、「読み込み中に操作すると落ちる」
 * という形で出ていた。この 3 つを測る。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as Cesium from 'cesium';
import { liveScene, waitForPrimitives, type AwaitablePrimitive } from '../primitive-swap';

/** ready と isDestroyed だけを持つ、待てるもの */
function primitive(state: { ready?: boolean; destroyed?: boolean } = {}): AwaitablePrimitive & {
  finish(): void;
  drop(): void;
} {
  let ready = state.ready ?? false;
  let destroyed = state.destroyed ?? false;
  return {
    get ready() {
      return ready;
    },
    isDestroyed: () => destroyed,
    finish: () => (ready = true),
    drop: () => (destroyed = true),
  };
}

/** requestRender の呼ばれた回数を数える scene */
function scene() {
  let destroyed = false;
  let renders = 0;
  return {
    isDestroyed: () => destroyed,
    requestRender: () => {
      if (destroyed) throw new Error('破棄済みの scene に requestRender した');
      renders += 1;
    },
    destroy: () => (destroyed = true),
    get renders() {
      return renders;
    },
  };
}

test('待つものが無ければすぐ返る', async () => {
  const s = scene();
  assert.equal(await waitForPrimitives(s as unknown as Cesium.Scene, []), true);
  assert.equal(s.renders, 0, '無駄な描画要求を出している');
});

test('全部が描けるようになったら true', async () => {
  const s = scene();
  const a = primitive();
  const b = primitive();
  setTimeout(() => a.finish(), 40);
  setTimeout(() => b.finish(), 80);

  assert.equal(await waitForPrimitives(s as unknown as Cesium.Scene, [a, b]), true);
  // requestRenderMode では描画が走らないと組み立ても進まないので、
  // 待っている間はこちらから描画を要求している必要がある
  assert.ok(s.renders > 0, '待っている間に描画を要求していない');
});

test('上限を過ぎたら待つのをやめる', async () => {
  // 待ち続けると、組み立てに失敗したときに古いものが永久に残る
  const s = scene();
  const stuck = primitive();
  const started = Date.now();

  assert.equal(await waitForPrimitives(s as unknown as Cesium.Scene, [stuck], 120), false);
  assert.ok(Date.now() - started < 1000, '上限で打ち切れていない');
});

test('破棄されたものは待たない', async () => {
  // 組み立ての途中で差し替えが起きると、待っていたものが破棄される。
  // 破棄済みを待ち続けると必ず上限まで待つことになる
  const s = scene();
  const dropped = primitive({ destroyed: true });
  assert.equal(await waitForPrimitives(s as unknown as Cesium.Scene, [dropped], 5000), true);
});

test('待っている間に scene が破棄されたら止まる', async () => {
  // 破棄済みの scene に requestRender すると例外になる。
  // 例外を投げずに false を返して、呼び出し側が入れ替えをやめられるようにする
  const s = scene();
  const stuck = primitive();
  setTimeout(() => s.destroy(), 60);

  assert.equal(await waitForPrimitives(s as unknown as Cesium.Scene, [stuck], 5000), false);
});

test('破棄済みの viewer からは scene を返さない', () => {
  const alive = { isDestroyed: () => false, scene: { isDestroyed: () => false } };
  assert.ok(liveScene(alive as unknown as Cesium.Viewer), '生きている viewer から取れない');

  const destroyedViewer = { isDestroyed: () => true, scene: { isDestroyed: () => false } };
  assert.equal(liveScene(destroyedViewer as unknown as Cesium.Viewer), null);

  // viewer は生きているが scene だけ破棄済み、という順序もある
  const destroyedScene = { isDestroyed: () => false, scene: { isDestroyed: () => true } };
  assert.equal(liveScene(destroyedScene as unknown as Cesium.Viewer), null);

  const noScene = { isDestroyed: () => false, scene: undefined };
  assert.equal(liveScene(noScene as unknown as Cesium.Viewer), null);
});
