/**
 * 経由地の通過判定。
 *
 * 市販カーナビの標準機能で、「先に寄ってから目的地へ」を表す。
 *
 * **なぜ通過の判定が要るのか。**
 * 経路を外れて再検索するとき、通過済みの経由地まで渡してしまうと、
 * 一度通った場所へ引き返す経路が出る。実際にこれをやると、
 * 経由地を通り過ぎた直後の再検索で U ターンを指示されることになる。
 *
 * 判定の距離 60m の根拠:
 *   経由地は目的地と違って、その建物に入る必要はない。前を通れば
 *   用が足りることが多く、道の反対側を通ることもある。
 *   片側 2 車線の道でも幅は 15m 前後、これに測位の誤差
 *   （GPS は市街地で 10〜30m ずれる）を見込む。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LatLng } from '@ijm/shared';
import { VIA_REACHED_M, advancePassedVia, remainingVia } from '../via-points';

const M_PER_DEG = 111_320;

/** 基準点から北へ n メートルの地点 */
function north(metres: number): LatLng {
  return { lat: 35.68 + metres / M_PER_DEG, lng: 139.76 };
}

/** 北へ 0m / 500m / 1000m の 3 か所 */
const VIA = [north(0), north(500), north(1000)];

test('近づいた経由地を通過済みにする', () => {
  // まだどれにも近づいていない
  assert.equal(advancePassedVia(VIA, 0, north(-300)), 0);
  // 1 つ目のすぐそば
  assert.equal(advancePassedVia(VIA, 0, north(20)), 1);
  // 2 つ目のすぐそば（1 つ目は通過済みとして渡す）
  assert.equal(advancePassedVia(VIA, 1, north(480)), 2);
});

test('通過の記録は戻らない', () => {
  // 経由地から離れても、通過したことは取り消さない。
  // 戻せると、通り過ぎた先で再検索したときに引き返す経路が出る
  assert.equal(advancePassedVia(VIA, 2, north(-500)), 2);
  assert.equal(advancePassedVia(VIA, 3, north(0)), 3);
});

test('近い経由地が並んでいたらまとめて通過する', () => {
  // 交差点の角と、その先の店。50m しか離れていないことはある
  const close = [north(0), north(30), north(1000)];
  assert.equal(advancePassedVia(close, 0, north(10)), 2);
});

test('判定の距離の境目', () => {
  // 60m ちょうどは通過、それより遠いとまだ
  assert.equal(advancePassedVia(VIA, 0, north(VIA_REACHED_M - 1)), 1);
  assert.equal(advancePassedVia(VIA, 0, north(VIA_REACHED_M + 5)), 0);
});

test('測位が壊れていても通過の記録を保つ', () => {
  // GPS が NaN を返すことはある。そこで記録が飛ぶと、
  // 次の再検索で通過済みの経由地が復活する
  for (const broken of [{ lat: Number.NaN, lng: 139.76 }, { lat: 35.68, lng: Number.NaN }]) {
    assert.equal(advancePassedVia(VIA, 2, broken), 2);
  }
});

test('経由地が無ければ通過数は 0', () => {
  assert.equal(advancePassedVia([], 3, north(0)), 0);
});

test('未通過の経由地だけを返す', () => {
  assert.deepEqual(remainingVia(VIA, 0), VIA);
  assert.deepEqual(remainingVia(VIA, 1), VIA.slice(1));
  assert.deepEqual(remainingVia(VIA, 3), []);
  // 記録が範囲外でも壊れない
  assert.deepEqual(remainingVia(VIA, 99), []);
  assert.deepEqual(remainingVia(VIA, -1), VIA);
});
