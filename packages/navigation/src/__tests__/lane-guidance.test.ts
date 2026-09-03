/**
 * 車線案内の判定と文言。
 *
 * 市販カーナビと Yahoo! カーナビにある「どの車線に寄るか」の表示。
 * 出典は OSM の `turn:lanes` で、経路エンジンが解釈して返してくる。
 *
 * ここで固定したいのは 2 点。
 *
 * 1. **データが無いときは黙る。** 車線数から矢印や文言を作らない。
 *    実在しない案内で車線を寄らせると危ない。
 * 2. **数えられる言い方をする。** 「中央の車線」ではなく
 *    「左から 2 番目」。運転席から数えられるのは左端からの本数だけ。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lane } from '@ijm/shared';
import { laneAdvice, laneLabel, shouldShowLanes, validLaneIndexes } from '../lane-guidance';

/** `L` を通れる車線、`x` を通れない車線として並べる */
function lanes(pattern: string): Lane[] {
  return [...pattern].map((c) => ({ indications: ['through'], valid: c === 'L' }));
}

test('車線情報が無ければ出さない', () => {
  assert.equal(shouldShowLanes(undefined, 100), false);
  assert.equal(shouldShowLanes([], 100), false);
  assert.equal(laneAdvice(undefined), null);
  assert.equal(laneAdvice([]), null);
});

test('遠いうちは出さない', () => {
  // 遠すぎると、別の交差点の案内だと思われる
  const four = lanes('xLLx');
  assert.equal(shouldShowLanes(four, 501), false);
  assert.equal(shouldShowLanes(four, 500), true);
  assert.equal(shouldShowLanes(four, 30), true);
  // 距離が読めないときは出さない（位置が分からないのに車線は言えない）
  assert.equal(shouldShowLanes(four, Number.NaN), false);
});

test('全車線が通れるなら言うことは無い', () => {
  // 「4 車線すべて通れます」と読み上げても運転の役に立たない
  assert.equal(laneAdvice(lanes('LLLL')), null);
  // 通れる車線が 1 つも無い応答も解釈できない
  assert.equal(laneAdvice(lanes('xxxx')), null);
});

test('通れる車線が 1 本なら位置を言う', () => {
  assert.match(laneAdvice(lanes('Lxxx')) ?? '', /左端の車線/);
  assert.match(laneAdvice(lanes('xxxL')) ?? '', /右端の車線/);
  assert.match(laneAdvice(lanes('xLxx')) ?? '', /左から 2 番目/);
  // 全体の本数も言う。運転席から数えられるようにするため
  assert.match(laneAdvice(lanes('xLxx')) ?? '', /全 4 車線/);
});

test('通れる車線が続いていればまとめて言う', () => {
  assert.match(laneAdvice(lanes('xLLx')) ?? '', /左から 2 番目から 3 番目/);
  assert.match(laneAdvice(lanes('LLLx')) ?? '', /左から 1 番目から 3 番目/);
});

test('飛び飛びの車線はそのまま並べる', () => {
  // 直進可の車線が離れて 2 本ある交差点はある。
  // 「2 番目から 4 番目」とまとめると、通れない 3 番目が含まれてしまう
  const advice = laneAdvice(lanes('xLxL')) ?? '';
  assert.match(advice, /2・4 番目/);
  // 「2 番目から 4 番目」という範囲の言い方になっていないこと
  assert.doesNotMatch(advice, /番目から/);
});

test('通れる車線の位置は左から 0 始まりで返す', () => {
  assert.deepEqual(validLaneIndexes(lanes('xLLx')), [1, 2]);
  assert.deepEqual(validLaneIndexes(lanes('xxxx')), []);
});

test('車線 1 本の説明に、位置と矢印と可否が入る', () => {
  // 画面を読み上げるとき、これだけで車線が特定できる必要がある
  const lane: Lane = { indications: ['through', 'right'], valid: true };
  const label = laneLabel(lane, 1, 4);
  assert.match(label, /左から 2 番目/);
  assert.match(label, /全 4 車線/);
  assert.match(label, /直進・右折/);
  assert.match(label, /この車線を通ります/);

  // 通れない車線には「通ります」を付けない
  assert.doesNotMatch(laneLabel({ ...lane, valid: false }, 0, 4), /この車線を通ります/);
});

test('矢印の指定が無い車線でも説明できる', () => {
  // OSM の `turn:lanes` に `none` と書かれていることがある
  assert.match(laneLabel({ indications: ['none'], valid: false }, 0, 2), /指定なし/);
  assert.match(laneLabel({ indications: [], valid: false }, 0, 2), /指定なし/);
});
