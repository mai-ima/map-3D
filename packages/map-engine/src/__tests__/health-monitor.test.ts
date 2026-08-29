import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthMonitor } from '../health-monitor';

test('問題が無いときは何も報告しない', () => {
  const h = new HealthMonitor();
  assert.equal(h.hasProblems, false);
  assert.equal(h.describe(), null);
  assert.deepEqual(h.recent, []);
});

test('種類ごとに件数を数え、多い順に要約する', () => {
  const h = new HealthMonitor();
  h.record('tile-failed', 'a');
  h.record('tile-failed', 'b');
  h.record('tile-failed', 'c');
  h.record('memory-pressure', 'warn');

  assert.equal(h.hasProblems, true);
  const summary = h.describe();
  assert.ok(summary?.startsWith('タイル取得失敗 3'), `多い順に並べる: ${summary}`);
  assert.ok(summary?.includes('メモリ逼迫 1'));
});

test('同じ種類が大量に出ても保持件数を超えない', () => {
  const h = new HealthMonitor();
  for (let i = 0; i < 100; i += 1) h.record('tile-failed', `tile ${i}`);

  // 累計は正しく数える
  assert.equal(h.summary['tile-failed'], 100);
  // 保持するのは直近のものだけ（メモリを食い潰さない）
  assert.ok(h.recent.length <= 20, `保持件数 ${h.recent.length}`);
  // 最新が先頭に来る
  assert.equal(h.recent[0].detail, 'tile 99');
});

test('描画が止まったら検知する', () => {
  const h = new HealthMonitor();
  h.frame(1000);

  // 閾値内は正常
  assert.equal(h.checkStall(3000), false);
  assert.equal(h.hasProblems, false);

  // 閾値を超えたら記録する
  assert.equal(h.checkStall(6000), true);
  assert.equal(h.summary.stall, 1);

  // 同じ停止で何度も記録しない
  h.checkStall(7000);
  h.checkStall(8000);
  assert.equal(h.summary.stall, 1, '連続した停止は 1 件として扱う');

  // 描画が再開したらリセットされる
  h.frame(9000);
  assert.equal(h.checkStall(9500), false);
});

test('一度も描画していない状態を停止とみなさない', () => {
  // 初期化直後はまだフレームが出ていないだけで、異常ではない
  const h = new HealthMonitor();
  assert.equal(h.checkStall(999999), false);
});
