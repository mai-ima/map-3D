import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeResolutionScale,
  forceDegradeTier,
  getQualitySettings,
  MemoryWatchdog,
  resolveMemoryBudget,
  type DeviceInfo,
} from '../quality';

const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  isIOS: false,
  isMobile: false,
  deviceMemoryGb: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
  renderer: 'test',
  ...over,
});

const MB = 1024 * 1024;

test('全プリセットが Cesium 既定より高精細で、かつ現実的なキャッシュ量に収まる', () => {
  for (const tier of ['high', 'ios-high', 'balanced'] as const) {
    const q = getQualitySettings(tier);
    // 建物のディテールは既定 (16) と同等以上を目指す
    assert.ok(q.screenSpaceError <= 18, `${tier}: SSE が粗すぎる`);
    // タブが落ちない上限。iOS Safari は 1GB 前後で強制終了される
    assert.ok(q.cacheBytes <= 320 * MB, `${tier}: キャッシュが大きすぎる`);
    assert.ok(
      q.cacheBytes + q.maximumCacheOverflowBytes <= 420 * MB,
      `${tier}: キャッシュ合計が大きすぎる`,
    );
  }
});

test('iOS プリセットは Retina を保ちつつ描画パスを増やさない', () => {
  const ios = getQualitySettings('ios-high');
  // 見た目の精細さの要である Retina 解像度は維持する
  assert.equal(ios.resolutionScale, 2.0);
  assert.ok(ios.screenSpaceError <= 12);

  // iOS 18.2 以降、1 フレームの描画コマンドが多すぎると WebKit が
  // WebGL コンテキストを破棄する。パスを増やす設定は既定で入れない。
  // https://bugs.webkit.org/show_bug.cgi?id=290752
  assert.equal(ios.msaaSamples, 1, 'MSAA は解決パスを増やす');
  assert.equal(ios.hdr, false, 'HDR は浮動小数点バッファのパスを増やす');
  assert.equal(ios.ambientOcclusion, false);
  assert.equal(ios.bloom, false);
  // ポストプロセスを切るぶん、輪郭は FXAA で補う
  assert.equal(ios.fxaa, true);
});

test('iOS プリセットはデスクトップよりメモリ予算が小さい', () => {
  const ios = getQualitySettings('ios-high');
  const high = getQualitySettings('high');
  assert.ok(ios.cacheBytes < high.cacheBytes);
  assert.ok(ios.maxDrawPixels < high.maxDrawPixels);
});

test('搭載メモリが少ない端末ではキャッシュが絞られる', () => {
  const base = getQualitySettings('ios-high');
  const small = resolveMemoryBudget(base, device({ isIOS: true, deviceMemoryGb: 2 }));
  const large = resolveMemoryBudget(base, device({ isIOS: true, deviceMemoryGb: 8 }));
  assert.ok(small.cacheBytes < large.cacheBytes);
  // 下限は割らない（少なすぎるとタイルの読み直しが多発する）
  assert.ok(small.cacheBytes >= 64 * MB);
  // プリセットの上限は超えない
  assert.ok(large.cacheBytes <= base.cacheBytes);
});

test('コア数が少ない端末は精細度を落とす', () => {
  const base = getQualitySettings('balanced');
  const weak = resolveMemoryBudget(base, device({ hardwareConcurrency: 2 }));
  assert.ok(weak.screenSpaceError >= 16);
  assert.ok(weak.maxFurniture < base.maxFurniture);
});

test('描画解像度は総ピクセル数で頭打ちになる', () => {
  const q = getQualitySettings('ios-high');

  // iPhone 17 世代は Retina 相当の ×2.0 がそのまま通る
  //   iPhone 17 / 17 Pro : CSS 402 × 874
  //   iPhone 17 Pro Max  : CSS 440 × 956
  assert.equal(computeResolutionScale(q, 402, 874, 3), q.resolutionScale, 'iPhone 17');
  assert.equal(computeResolutionScale(q, 440, 956, 3), q.resolutionScale, 'iPhone 17 Pro Max');

  // 大きな画面では上限に掛かって下がる
  const desktop = computeResolutionScale(q, 1920, 1080, 3);
  assert.ok(desktop < q.resolutionScale);
  assert.ok(1920 * 1080 * desktop * desktop <= q.maxDrawPixels * 1.001);

  // 画素数の多いディスプレイでは等倍より下げてでも上限を守る
  const retina5k = computeResolutionScale(q, 5120, 2880, 2);
  assert.ok(retina5k < 1);
  assert.ok(retina5k >= 0.6);
});

test('forceDegradeTier は iOS も 1 段階下げる', () => {
  assert.equal(forceDegradeTier('ios-high'), 'balanced');
  assert.equal(forceDegradeTier('high'), 'balanced');
  assert.equal(forceDegradeTier('balanced'), 'low');
  assert.equal(forceDegradeTier('low'), 'low');
});

test('MemoryWatchdog は予算超過で通知し、クールダウン中は再通知しない', () => {
  const calls: string[] = [];
  const watchdog = new MemoryWatchdog((r) => calls.push(r.level), 100 * MB, 5000);

  assert.equal(watchdog.check(50 * MB, 1000).level, 'ok');
  assert.deepEqual(calls, []);

  assert.equal(watchdog.check(120 * MB, 2000).level, 'warn');
  assert.deepEqual(calls, ['warn']);

  // クールダウン中は通知しない（判定自体は返る）
  assert.equal(watchdog.check(200 * MB, 3000).level, 'critical');
  assert.deepEqual(calls, ['warn']);

  // クールダウン明けは再通知する
  assert.equal(watchdog.check(200 * MB, 9000).level, 'critical');
  assert.deepEqual(calls, ['warn', 'critical']);
});

test('MemoryWatchdog は予算を更新できる', () => {
  const calls: string[] = [];
  const watchdog = new MemoryWatchdog((r) => calls.push(r.level), 1000 * MB, 0);
  assert.equal(watchdog.check(200 * MB, 1000).level, 'ok');
  watchdog.setBudget(100 * MB);
  assert.equal(watchdog.check(200 * MB, 2000).level, 'critical');
});

test('メモリに余裕が戻ったことを判定できる', () => {
  const budget = 100 * MB;
  const watchdog = new MemoryWatchdog(() => {}, budget);

  // 逼迫している間は回復とみなさない
  assert.equal(watchdog.hasRecovered(150 * MB), false);
  // 警告域を下回った程度では戻さない。すぐ戻すと上げ下げを繰り返す
  assert.equal(watchdog.hasRecovered(80 * MB), false);
  // 十分に下がって初めて回復とみなす
  assert.equal(watchdog.hasRecovered(50 * MB), true);
});

test('回復の判定は予算の変更に追従する', () => {
  const watchdog = new MemoryWatchdog(() => {}, 100 * MB);
  assert.equal(watchdog.hasRecovered(50 * MB), true);

  // 品質を上げて予算が増えれば、同じ使用量でも余裕がある
  watchdog.setBudget(300 * MB);
  assert.equal(watchdog.hasRecovered(150 * MB), true);

  // 予算が減れば同じ使用量でも余裕が無い
  watchdog.setBudget(64 * MB);
  assert.equal(watchdog.hasRecovered(50 * MB), false);
});
