/**
 * 太陽の位置。
 *
 * 「時間帯がリアルじゃない」という指摘への対応をここで固定する。
 * 以前は「5:30 より前と 18:30 より後は夜」という固定の閾値だった。
 * 日本の日の出・日の入りは季節で 2 時間半も動くので、
 * 12 月の 17 時が「昼」、6 月の 5 時が「夜」になっていた。
 *
 * 計算式の出典: NOAA Solar Calculator
 * （Astronomical Algorithms, Jean Meeus の簡略式）。
 * 期待値は国立天文台の暦計算室が公開している値と突き合わせる。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daylightStrength, skyPhaseOf, solarPosition, sunTimes } from '../sun';

/** 東京（気象庁の観測地点） */
const TOKYO = { lat: 35.6895, lng: 139.6917 };
/** 浜松 */
const HAMAMATSU = { lat: 34.7047, lng: 137.7342 };

/** JST の時刻を UTC の Date にする */
function jst(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
}

test('東京の日の出・日の入りが暦の値と合う', () => {
  // 国立天文台 暦計算室（東京）:
  //   夏至 2026-06-21  日の出 04:25 / 日の入り 19:00
  //   冬至 2026-12-22  日の出 06:47 / 日の入り 16:32
  //   春分 2026-03-20  日の出 05:44 / 日の入り 17:53
  const cases: [string, Date, number, number][] = [
    ['夏至', new Date(Date.UTC(2026, 5, 21, 3)), 4 + 25 / 60, 19 + 0 / 60],
    ['冬至', new Date(Date.UTC(2026, 11, 22, 3)), 6 + 47 / 60, 16 + 32 / 60],
    ['春分', new Date(Date.UTC(2026, 2, 20, 3)), 5 + 44 / 60, 17 + 53 / 60],
  ];

  for (const [name, date, sunrise, sunset] of cases) {
    const times = sunTimes(date, TOKYO, 9);
    assert.ok(times, `${name}: 求まらない`);
    // 4 分（0.067 時間）以内で合っていれば十分。
    // この式は分単位の誤差を持つ簡略式で、標高や気圧も見ていない
    assert.ok(
      Math.abs(times.sunriseHour - sunrise) < 0.07,
      `${name} の日の出: ${times.sunriseHour.toFixed(2)} 期待 ${sunrise.toFixed(2)}`,
    );
    assert.ok(
      Math.abs(times.sunsetHour - sunset) < 0.07,
      `${name} の日の入り: ${times.sunsetHour.toFixed(2)} 期待 ${sunset.toFixed(2)}`,
    );
  }
});

test('季節で日の入りが 2 時間半動く', () => {
  // 固定の閾値（18:30）だと、冬は 2 時間ずれる
  const summer = sunTimes(new Date(Date.UTC(2026, 5, 21, 3)), TOKYO, 9);
  const winter = sunTimes(new Date(Date.UTC(2026, 11, 22, 3)), TOKYO, 9);
  assert.ok(summer && winter);
  assert.ok(summer.sunsetHour - winter.sunsetHour > 2.4, '季節差が出ていない');
});

test('12 月の 17 時は夜、6 月の 5 時は昼', () => {
  // 固定の閾値ではどちらも逆になっていた
  const december = solarPosition(jst(2026, 12, 22, 17), TOKYO);
  assert.ok(december.elevationDeg < 0, `12 月 17 時の太陽高度 ${december.elevationDeg}`);
  assert.notEqual(skyPhaseOf(december.elevationDeg), 'day');

  const june = solarPosition(jst(2026, 6, 21, 5), TOKYO);
  assert.ok(june.elevationDeg > 0, `6 月 5 時の太陽高度 ${june.elevationDeg}`);
});

test('南中の高さが緯度と季節に合う', () => {
  // 南中高度 = 90 − 緯度 + 赤緯。東京（35.69 度）の夏至は 77.8 度前後
  const noon = solarPosition(jst(2026, 6, 21, 11, 43), TOKYO);
  assert.ok(
    Math.abs(noon.elevationDeg - 77.8) < 1,
    `夏至の南中高度が ${noon.elevationDeg.toFixed(1)} 度`,
  );
  // 冬至は 30.9 度前後
  const winterNoon = solarPosition(jst(2026, 12, 22, 11, 40), TOKYO);
  assert.ok(
    Math.abs(winterNoon.elevationDeg - 30.9) < 1,
    `冬至の南中高度が ${winterNoon.elevationDeg.toFixed(1)} 度`,
  );
});

test('太陽は東から昇って西へ沈む', () => {
  const morning = solarPosition(jst(2026, 3, 20, 7), TOKYO);
  const evening = solarPosition(jst(2026, 3, 20, 17), TOKYO);
  // 方位は真北 0・東回り。朝は東（90 度前後）、夕方は西（270 度前後）
  assert.ok(morning.azimuthDeg > 60 && morning.azimuthDeg < 130, `朝 ${morning.azimuthDeg}`);
  assert.ok(evening.azimuthDeg > 230 && evening.azimuthDeg < 300, `夕 ${evening.azimuthDeg}`);
});

test('浜松は東京より日の入りが遅い', () => {
  // 経度が西（137.73 対 139.69）なので、およそ 8 分遅い
  const tokyo = sunTimes(new Date(Date.UTC(2026, 5, 21, 3)), TOKYO, 9);
  const hamamatsu = sunTimes(new Date(Date.UTC(2026, 5, 21, 3)), HAMAMATSU, 9);
  assert.ok(tokyo && hamamatsu);
  const diffMin = (hamamatsu.sunsetHour - tokyo.sunsetHour) * 60;
  assert.ok(diffMin > 4 && diffMin < 12, `差が ${diffMin.toFixed(1)} 分`);
});

test('空の状態は太陽高度で連続的に変わる', () => {
  assert.equal(skyPhaseOf(40), 'day');
  assert.equal(skyPhaseOf(3), 'golden', '朝焼け・夕焼け');
  assert.equal(skyPhaseOf(-3), 'twilight', '薄明');
  assert.equal(skyPhaseOf(-10), 'night');
  // 壊れた値でも落ちない
  assert.equal(skyPhaseOf(Number.NaN), 'day');
});

test('日照の強さは太陽高度とともに増える', () => {
  let previous = -1;
  for (const elevation of [-10, -6, -3, 0, 5, 15, 30, 60, 90]) {
    const strength = daylightStrength(elevation);
    assert.ok(strength >= previous, `${elevation} 度で逆転している`);
    assert.ok(strength >= 0 && strength <= 1, `${elevation} 度で ${strength}`);
    previous = strength;
  }
  assert.equal(daylightStrength(-20), 0, '夜は 0');
  assert.ok(daylightStrength(90) > 0.95, '真上なら最大');
});
