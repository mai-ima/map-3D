/**
 * 時間帯の適用。
 *
 * ここで測りたいのは 2 点。
 *
 * 1. 「現在時刻に追従」で Cesium の時計を進めない（multiplier=0 のまま）こと。
 *    時計を進めると時刻が変わるたびに再描画が要求され、requestRenderMode で
 *    静止中に描かないようにしている省電力の仕組みが丸ごと効かなくなる。
 *    太陽は 1 分で 0.25 度しか動かないので、こちらから 1 分ごとに入れ直せばよい。
 *
 * 2. 追従中に日没をまたいだら、夜の補正と星空が入ること。
 *    以前は最初の 1 回しか適用しておらず、昼に追従を入れたまま夜になっても
 *    環境光が昼のままで星も出なかった。
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
    assert.equal(viewer.scene.skyBox?.show ?? false, false, '昼なのに星が出ている');
    assert.ok(env.current.hour > 13 && env.current.hour < 15, `時刻がずれている: ${env.current.hour}`);

    // UTC 13:00 = JST 22:00 まで進める（1 分ごとの入れ直しが 8 時間分走る）
    t.mock.timers.tick(8 * 60 * 60 * 1000);

    assert.ok(env.current.hour > 21 && env.current.hour < 23, `時刻が追従していない: ${env.current.hour}`);
    assert.equal(viewer.scene.skyBox?.show, true, '夜なのに星が出ていない');
    assert.equal(viewer.scene.globe.lambertDiffuseMultiplier, 1.4, '夜の環境光になっていない');
  } finally {
    env.destroy();
    mock.timers.reset();
  }
});
