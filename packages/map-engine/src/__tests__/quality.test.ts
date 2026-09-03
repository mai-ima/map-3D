import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptiveScreenSpaceError,
  computeResolutionScale,
  forceDegradeTier,
  getQualitySettings,
  MemoryWatchdog,
  PerformanceWatchdog,
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

test('街を見渡す高さで精細度を落としすぎない', () => {
  const base = 12; // iOS プリセットの基準値

  // 街を歩く視点は基準どおり
  assert.equal(adaptiveScreenSpaceError(base, 100), base);

  // 初期表示の高さ（東京 1800m / 浜松 1100m）。
  // ここが粗いと「3D モデルが読み込まれていない」ように見える。
  // Cesium の既定 16 から大きく離れない範囲に収める
  for (const h of [1100, 1500, 1800]) {
    const sse = adaptiveScreenSpaceError(base, h);
    assert.ok(sse <= 28, `${h}m で SSE ${sse} は粗すぎる`);
  }

  // 最深タイルまで分割されることを確かめる。
  // 実測した幾何誤差: 東京の子タイルセット 88.4 / 浜松 49.4
  assert.ok(adaptiveScreenSpaceError(base, 1800) < 49.4, '浜松の最深部まで届くこと');
  assert.ok(adaptiveScreenSpaceError(base, 3000) < 88.4, '東京の最深部まで届くこと');

  // 高いところでは粗くしてよい（遠景タイルセットが街並みを担う）
  assert.ok(adaptiveScreenSpaceError(base, 30000) > adaptiveScreenSpaceError(base, 1800));

  // 上限を超えない
  assert.ok(adaptiveScreenSpaceError(base, 1_000_000) <= 96);
});

test('高度が上がるほど精細度は単調に粗くなる', () => {
  // 途中で逆転すると、ズームの途中で急に重くなる区間ができてしまう
  let prev = 0;
  for (const h of [0, 100, 500, 1000, 2000, 5000, 10000, 50000, 200000]) {
    const sse = adaptiveScreenSpaceError(12, h);
    assert.ok(sse >= prev, `${h}m で精細度が逆転している (${prev} → ${sse})`);
    prev = sse;
  }
});

test('高度が数値で来なくても精細度は数値のまま返る', () => {
  // カメラ姿勢が壊れた直後は positionCartographic.height が NaN になりうる。
  // NaN の SSE を Cesium に渡すとタイルツリーの評価が止まり、建物が一切出なくなる
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const sse = adaptiveScreenSpaceError(12, bad);
    assert.ok(Number.isFinite(sse), `高度 ${bad} で SSE が ${sse}`);
    assert.ok(sse > 0, `高度 ${bad} で SSE が ${sse}`);
  }
});

test('画面サイズが取れなくても描画倍率は数値のまま返る', () => {
  const settings = getQualitySettings('ios-high');
  for (const [w, h] of [
    [Number.NaN, 874],
    [402, Number.NaN],
    [0, 0],
  ]) {
    const scale = computeResolutionScale(settings, w, h, 3);
    assert.ok(Number.isFinite(scale), `${w}×${h} で倍率が ${scale}`);
    assert.ok(scale >= 0.6, `${w}×${h} で倍率が ${scale}`);
  }
});

test('中断をまたいだフレームは FPS の標本に混ぜない', () => {
  // タブを裏に回す・案内を止めて再開すると、次のフレームまでの間隔が数秒空く。
  // それを 0 fps として数えると、実際は快適でも品質を下げてしまう
  let degraded = 0;
  const watchdog = new PerformanceWatchdog(() => (degraded += 1), 28, 10);

  let t = 0;
  // 60fps を 5 枚 → 5 秒の中断 → また 60fps を 10 枚
  for (let i = 0; i < 5; i += 1) watchdog.frame((t += 16.7));
  watchdog.frame((t += 5000));
  for (let i = 0; i < 10; i += 1) watchdog.frame((t += 16.7));

  assert.equal(degraded, 0, '中断を遅さと取り違えている');
});

test('本当に遅いときは品質を下げる', () => {
  let degraded = 0;
  const watchdog = new PerformanceWatchdog(() => (degraded += 1), 28, 10);
  let t = 0;
  // 1 枚 50ms（20fps）が続く状態
  for (let i = 0; i < 12; i += 1) watchdog.frame((t += 50));
  assert.equal(degraded, 1);
});
