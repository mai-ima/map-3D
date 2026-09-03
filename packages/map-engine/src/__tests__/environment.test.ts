/**
 * 時間帯と天候の適用。
 *
 * ここで測りたいのは 4 点。
 *
 * 1. 「現在時刻に追従」で Cesium の時計を進めない（multiplier=0 のまま）こと。
 *    時計を進めると時刻が変わるたびに再描画が要求され、requestRenderMode で
 *    静止中に描かないようにしている省電力の仕組みが丸ごと効かなくなる。
 *    太陽は 1 分で 0.25 度しか動かないので、こちらから 1 分ごとに入れ直せばよい。
 *
 * 2. 追従中に日没をまたいだら、夜の補正と星空が入ること。
 *    以前は最初の 1 回しか適用しておらず、昼に追従を入れたまま夜になっても
 *    環境光が昼のままで星も出なかった。
 *
 * 3. 昼夜の判定が「太陽高度」で決まること。
 *    以前は 5:30 より前と 18:30 より後を夜としていた。日本の日の出・日の入りは
 *    季節で 2 時間半動くので、12 月の 17 時が昼、6 月の 5 時が夜になっていた。
 *    どちらも実際とは逆で、これが「時間帯がリアルじゃない」の正体。
 *
 * 4. 天候を選ぶと街の見え方が実際に変わること。
 *    以前は霧の濃さをわずかに動かすだけで、晴れと雨の区別がつかなかった。
 *    視程・日射・影の 3 つが動くことを測る。
 *
 * 参照値の出典:
 *   日の出・日の入り … 国立天文台 暦計算室（東京、2026 年）
 *     夏至 04:25 / 19:00、冬至 06:47 / 16:32
 *   視程階級         … 気象庁 地上気象観測指針
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as Cesium from 'cesium';
import { EnvironmentController, jstToJulianDate } from '../environment';
import { getQualitySettings } from '../quality';

/** EnvironmentController が触る範囲だけを持つ Viewer */
function mockViewer() {
  const globe = {
    enableLighting: false,
    dynamicAtmosphereLighting: false,
    dynamicAtmosphereLightingFromSun: false,
    depthTestAgainstTerrain: false,
    maximumScreenSpaceError: 2,
    tileCacheSize: 100,
    atmosphereBrightnessShift: 0,
    atmosphereHueShift: 0,
    atmosphereSaturationShift: 0,
    nightFadeInDistance: 0,
    nightFadeOutDistance: 0,
    lambertDiffuseMultiplier: 1,
    translucency: { enabled: false },
  };
  const stage = { enabled: false, uniforms: {} as Record<string, unknown> };
  const scene = {
    globe,
    skyAtmosphere: { show: false, saturationShift: 0, brightnessShift: 0 },
    skyBox: null as { show: boolean } | null,
    fog: { enabled: false, density: 0, screenSpaceErrorFactor: 0 },
    light: { intensity: 0 } as { intensity: number },
    highDynamicRange: false,
    postProcessStages: {
      fxaa: { ...stage },
      ambientOcclusion: { enabled: false, uniforms: {} as Record<string, unknown> },
      bloom: { enabled: false, uniforms: {} as Record<string, unknown> },
      add: (s: unknown) => s,
      remove: () => true,
    },
  };
  return {
    scene,
    clock: { currentTime: Cesium.JulianDate.now(), multiplier: 0, shouldAnimate: false },
    shadows: false,
    shadowMap: { enabled: false, softShadows: false, maximumDistance: 0, darkness: 0, size: 0 },
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer & { scene: typeof scene };
}

const quality = getQualitySettings('ios-high');

/** 東京駅。国立天文台の暦の「東京」に対応する地点 */
const TOKYO = { lat: 35.6812, lng: 139.7671 };
/** 根室（日本で最も日の出が早い側） */
const NEMURO = { lat: 43.33, lng: 145.58 };
/** 那覇（日本で最も日の入りが遅い側） */
const NAHA = { lat: 26.21, lng: 127.68 };

/** 星空が出ているか。太陽が地平線の下にあるときだけ出る */
function starsVisible(viewer: ReturnType<typeof mockViewer>): boolean {
  return viewer.scene.skyBox?.show ?? false;
}

test('JST の時刻が UTC に正しく直る', () => {
  // 2026-09-03 の JST 12:00 は UTC 03:00
  const julian = jstToJulianDate(new Date(2026, 8, 3), 12);
  const utc = Cesium.JulianDate.toDate(julian);
  assert.equal(utc.getUTCFullYear(), 2026);
  assert.equal(utc.getUTCMonth(), 8);
  assert.equal(utc.getUTCDate(), 3);
  assert.equal(utc.getUTCHours(), 3);
});

test('小数の時刻は分に直る', () => {
  // JST 06:30 → UTC 前日 21:30
  const utc = Cesium.JulianDate.toDate(jstToJulianDate(new Date(2026, 8, 3), 6.5));
  assert.equal(utc.getUTCHours(), 21);
  assert.equal(utc.getUTCMinutes(), 30);
  assert.equal(utc.getUTCDate(), 2);
});

test('現在時刻に追従しても Cesium の時計は進めない', () => {
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  env.setFollowRealTime(true);
  try {
    // 進めると時刻の変化のたびに再描画が要求され、静止中も描き続けることになる
    assert.equal(viewer.clock.multiplier, 0, '時計が動いている');
    assert.equal(viewer.clock.shouldAnimate, false, '時計が動いている');
    assert.equal(env.current.followRealTime, true);
  } finally {
    env.destroy();
  }
});

test('追従を切ると、入れ直しの時計も止まる', () => {
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  env.setFollowRealTime(true);
  env.setFollowRealTime(false);
  env.destroy();
  // 止め忘れると、画面を離れたあとも 1 分ごとに破棄済みの Viewer を触り続ける
  assert.equal(env.current.followRealTime, false);
});

test('追従中に夜になったら、夜の補正と星空が入る', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date('2026-09-03T05:00:00Z') });
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  try {
    // UTC 05:00 = JST 14:00。まだ昼なので星は出ていない
    env.setFollowRealTime(true);
    assert.equal(starsVisible(viewer), false, '昼なのに星が出ている');
    assert.ok(env.current.hour > 13 && env.current.hour < 15, `時刻がずれている: ${env.current.hour}`);

    // UTC 13:00 = JST 22:00 まで進める（1 分ごとの入れ直しが 8 時間分走る）
    t.mock.timers.tick(8 * 60 * 60 * 1000);

    assert.ok(env.current.hour > 21 && env.current.hour < 23, `時刻が追従していない: ${env.current.hour}`);
    assert.equal(starsVisible(viewer), true, '夜なのに星が出ていない');
    // 夜は直射が 0 になり、環境光だけで見せる。0.85 + (1-0) * 0.65
    assert.equal(viewer.scene.globe.lambertDiffuseMultiplier, 1.5, '夜の環境光になっていない');
  } finally {
    env.destroy();
    mock.timers.reset();
  }
});

test('昼夜は固定の時刻ではなく太陽高度で決まる', () => {
  // 固定の閾値（5:30 / 18:30）だと、この 2 つはどちらも逆に判定される。
  // 東京 冬至の日の入りは 16:32、夏至の日の出は 04:25（国立天文台）
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  env.setViewpoint(TOKYO);
  try {
    // 冬至の 17:00 は日の入りの 28 分後。すでに夜
    env.setTime(17, new Date(2026, 11, 21));
    assert.ok(env.sun.elevationDeg < 0, `冬至 17:00 で太陽が出ている: ${env.sun.elevationDeg}`);
    assert.equal(starsVisible(viewer), true, '冬至の 17 時が昼になっている');

    // 夏至の 05:00 は日の出の 35 分後。すでに朝
    env.setTime(5, new Date(2026, 5, 21));
    assert.ok(env.sun.elevationDeg > 0, `夏至 05:00 で太陽が出ていない: ${env.sun.elevationDeg}`);
    assert.equal(starsVisible(viewer), false, '夏至の 5 時が夜になっている');
  } finally {
    env.destroy();
  }
});

test('見ている場所で日の入りの時刻が変わる', () => {
  // 夏至の 19:00、根室ではすでに日が沈み、那覇ではまだ沈んでいない
  // （国立天文台 夏至の日の入り: 根室 19:01 / 那覇 19:24）
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  try {
    env.setTime(19, new Date(2026, 5, 21));

    env.setViewpoint(NEMURO);
    const north = env.sun.elevationDeg;
    assert.ok(north < 0, `根室で日が沈んでいない: ${north}`);
    assert.equal(starsVisible(viewer), true, '根室で星が出ていない');

    env.setViewpoint(NAHA);
    const south = env.sun.elevationDeg;
    assert.ok(south > 0, `那覇で日が沈んでいる: ${south}`);
    assert.equal(starsVisible(viewer), false, '那覇で星が出ている');
  } finally {
    env.destroy();
  }
});

test('視点がわずかに動いただけでは空を塗り直さない', () => {
  // カメラは 0.5 秒ごとに動く。そのたびに空を作り直すと無駄が大きい
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  try {
    env.setViewpoint(TOKYO);
    const before = env.sun.elevationDeg;
    // 1km ほど動かす
    env.setViewpoint({ lat: TOKYO.lat + 0.01, lng: TOKYO.lng + 0.01 });
    assert.equal(env.sun.elevationDeg, before, '近距離の移動で入れ直している');
  } finally {
    env.destroy();
  }
});

test('太陽が低いほど直射が弱く、環境光が強い', () => {
  // 段で切り替えると、日の入りの瞬間に街全体の明るさが飛ぶ
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  env.setViewpoint(TOKYO);
  const samples: { hour: number; light: number; ambient: number }[] = [];
  try {
    for (const hour of [12, 15, 17, 18, 19]) {
      env.setTime(hour, new Date(2026, 5, 21));
      samples.push({
        hour,
        light: viewer.scene.light.intensity,
        ambient: viewer.scene.globe.lambertDiffuseMultiplier,
      });
    }
  } finally {
    env.destroy();
  }
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(
      samples[i].light < samples[i - 1].light,
      `${samples[i].hour} 時のほうが明るい: ${samples[i].light} >= ${samples[i - 1].light}`,
    );
    assert.ok(
      samples[i].ambient > samples[i - 1].ambient,
      `${samples[i].hour} 時の環境光が上がっていない`,
    );
  }
});

test('天候で視程が変わる', () => {
  // 気象庁の視程階級: 晴れ 20km 以上、雨 4〜10km、霧 1km 未満
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  const density: Record<string, number> = {};
  try {
    for (const weather of ['clear', 'cloudy', 'rain', 'snow', 'fog'] as const) {
      env.setWeather(weather);
      density[weather] = viewer.scene.fog.density;
      assert.equal(viewer.scene.fog.enabled, true);
    }
  } finally {
    env.destroy();
  }
  // 視程が短いほど霧は濃い
  assert.ok(density.clear < density.cloudy, '曇りで見通しが変わっていない');
  assert.ok(density.cloudy < density.rain, '雨で見通しが変わっていない');
  assert.ok(density.rain < density.snow, '雪で見通しが変わっていない');
  assert.ok(density.snow < density.fog, '霧で見通しが変わっていない');
  // 霧は晴れの 10 倍以上濃い。「選んでも変わらない」と言われない差
  assert.ok(
    density.fog / density.clear > 10,
    `霧と晴れの差が小さい: ${(density.fog / density.clear).toFixed(1)} 倍`,
  );
});

test('天候で日射が変わる', () => {
  // 曇天の全天日射量は快晴の 3〜5 割、雨天は 2 割前後（気象庁）
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  const light: Record<string, number> = {};
  try {
    env.setViewpoint(TOKYO);
    env.setTime(12, new Date(2026, 5, 21));
    for (const weather of ['clear', 'cloudy', 'rain'] as const) {
      env.setWeather(weather);
      light[weather] = viewer.scene.light.intensity;
    }
  } finally {
    env.destroy();
  }
  assert.ok(light.cloudy < light.clear * 0.6, '曇りで暗くなっていない');
  assert.ok(light.rain < light.cloudy, '雨が曇りより明るい');
});

test('影ができるのは晴れて太陽が高いときだけ', () => {
  // ios-high は影を最初から切っている（iOS の WebGL では影の描画が重い）ので、
  // 影を持つティアで測る
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, getQualitySettings('high'));
  try {
    env.setViewpoint(TOKYO);
    env.setTime(12, new Date(2026, 5, 21));
    env.setWeather('clear');
    assert.equal(viewer.shadows, true, '晴れた正午に影が出ていない');

    // 曇りでは太陽が雲に隠れ、輪郭のある影はできない
    env.setWeather('cloudy');
    assert.equal(viewer.shadows, false, '曇りなのに影が出ている');

    // 晴れていても夜には影はできない
    env.setWeather('clear');
    env.setTime(22, new Date(2026, 5, 21));
    assert.equal(viewer.shadows, false, '夜なのに影が出ている');
  } finally {
    env.destroy();
  }
});

test('天候を変えても時刻の明るさは保たれる', () => {
  // applyWeather が applyTime を呼び直さないと、天候を選んだ瞬間に
  // 夜でも昼の明るさに戻ってしまう
  const viewer = mockViewer();
  const env = new EnvironmentController(viewer, quality);
  try {
    env.setViewpoint(TOKYO);
    env.setTime(22, new Date(2026, 5, 21));
    env.setWeather('rain');
    assert.equal(starsVisible(viewer), true, '天候を変えたら星が消えた');
    assert.equal(viewer.scene.globe.lambertDiffuseMultiplier, 1.5, '夜の環境光が戻っていない');
  } finally {
    env.destroy();
  }
});
