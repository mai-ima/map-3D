/**
 * 天候ごとの見え方の表。
 *
 * 描画エンジンを持ち出さずに測れるところを、ここで固定する。
 * 「天候を選んでも街の見え方が変わらない」に戻らないための歯止め。
 *
 * 出典:
 *   視程 … 気象庁 地上気象観測指針の視程階級
 *          （霧の定義そのものが「視程 1km 未満」）
 *   日射 … 気象庁の日照率と全天日射量の関係
 *          （曇天で快晴の 3〜5 割、雨天で 2 割前後）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WEATHER_KINDS,
  WEATHER_LOOK,
  fogDensityFor,
  isWeatherKind,
} from '../weather';

test('視程は気象庁の階級に沿っている', () => {
  const look = WEATHER_LOOK;
  // 快晴・晴れは 20km 以上
  assert.ok(look.clear.visibilityM >= 20_000);
  // 曇りは 10〜20km
  assert.ok(look.cloudy.visibilityM >= 10_000 && look.cloudy.visibilityM <= 20_000);
  // 並の雨は 4〜10km
  assert.ok(look.rain.visibilityM >= 4_000 && look.rain.visibilityM <= 10_000);
  // 並の雪は 1〜4km
  assert.ok(look.snow.visibilityM >= 1_000 && look.snow.visibilityM <= 4_000);
  // 霧の定義は 1km 未満
  assert.ok(look.fog.visibilityM < 1_000);
});

test('天候が悪いほど日射が弱い', () => {
  // 段の順序が崩れると、雨のほうが晴れより明るいといったことが起きる
  assert.equal(WEATHER_LOOK.clear.sunlight, 1);
  for (const kind of ['cloudy', 'rain', 'snow', 'fog'] as const) {
    assert.ok(
      WEATHER_LOOK[kind].sunlight < WEATHER_LOOK.clear.sunlight,
      `${kind} が晴れより明るい`,
    );
  }
  // 曇天は快晴の 3〜5 割
  assert.ok(WEATHER_LOOK.cloudy.sunlight >= 0.3 && WEATHER_LOOK.cloudy.sunlight <= 0.5);
  // 雨天は 2 割前後
  assert.ok(WEATHER_LOOK.rain.sunlight >= 0.15 && WEATHER_LOOK.rain.sunlight <= 0.3);
});

test('影ができるのは晴れだけ', () => {
  // これが最も効く。曇りの日に建物の影が地面に落ちていると、
  // 空をどれだけ灰色にしても晴れにしか見えない
  assert.equal(WEATHER_LOOK.clear.directSun, true);
  for (const kind of ['cloudy', 'rain', 'snow', 'fog'] as const) {
    assert.equal(WEATHER_LOOK[kind].directSun, false, `${kind} で影ができている`);
  }
});

test('視程が短いほど霧が濃い', () => {
  const densities = WEATHER_KINDS.map((k) => fogDensityFor(WEATHER_LOOK[k].visibilityM));
  for (let i = 1; i < densities.length; i += 1) {
    assert.ok(
      densities[i] > densities[i - 1],
      `${WEATHER_KINDS[i]} が ${WEATHER_KINDS[i - 1]} より薄い`,
    );
  }
  // 霧と晴れで 10 倍以上の差。「選んでも変わらない」と言われない差にする
  assert.ok(densities[densities.length - 1] / densities[0] > 10);
});

test('壊れた視程でも霧の濃さは実用の範囲に収まる', () => {
  // 0 除算や負の値で画面が真っ白（または霧が消える）にならないこと
  for (const visibility of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
    const density = fogDensityFor(visibility);
    assert.ok(Number.isFinite(density), `視程 ${visibility} で ${density}`);
    assert.ok(density >= 0.00005 && density <= 0.02, `視程 ${visibility} で ${density}`);
  }
});

test('天候の種類の判定', () => {
  for (const kind of WEATHER_KINDS) assert.equal(isWeatherKind(kind), true);
  assert.equal(isWeatherKind('storm'), false);
  assert.equal(isWeatherKind(undefined), false);
  // 表と一覧が食い違わないこと（片方だけ増やすと UI に出ない天候ができる）
  assert.deepEqual([...WEATHER_KINDS].sort(), Object.keys(WEATHER_LOOK).sort());
});
