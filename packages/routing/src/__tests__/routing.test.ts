/**
 * 経路エンジンの応答解析。
 *
 * ここで確かめたいのは「正常な応答を正しく読めるか」だけではない。
 * 相手はネットワーク越しの JSON で、混雑時や部分障害のときに
 * 項目がまるごと欠けた応答が返ってくる。仕様上は必ずある配列が
 * undefined で来ると for-of は TypeError を投げ、そのメッセージが
 * そのまま利用者の画面に出てしまう（「trip.legs is not iterable」）。
 *
 * 欠けた応答では必ず RoutingError になること、
 * 数値の欠けが NaN として下流に流れないことを測る。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { encodePolyline } from '@ijm/shared';
import type { RouteRequest } from '@ijm/shared';
import { OsrmProvider } from '../osrm';
import { RoutingError } from '../types';
import { ValhallaProvider } from '../valhalla';

const REQUEST: RouteRequest = {
  from: { lat: 34.7048, lng: 137.7345 },
  to: { lat: 34.7104, lng: 137.7266 },
  mode: 'drive',
};

/** 浜松駅前から北西へ 4 点。経度・緯度の順（polyline の並び） */
const PATH: [number, number][] = [
  [137.7345, 34.7048],
  [137.7331, 34.7062],
  [137.7302, 34.7081],
  [137.7266, 34.7104],
];

const valhalla = new ValhallaProvider({ baseUrl: 'https://routing.example' });
const osrm = new OsrmProvider({ endpoints: { drive: 'https://osrm.example/route' } });

const realFetch = globalThis.fetch;

/** 次の 1 回の fetch が返す JSON を差し替える */
function reply(payload: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function valhallaTrip(overrides: Record<string, unknown> = {}) {
  return {
    trip: {
      legs: [
        {
          shape: encodePolyline(PATH, 6),
          summary: { time: 120, length: 0.6 },
          maneuvers: [
            {
              type: 1,
              instruction: '北西へ進みます',
              time: 60,
              length: 0.3,
              begin_shape_index: 0,
              end_shape_index: 1,
              street_names: ['市道'],
            },
            {
              type: 15,
              instruction: '左折します',
              time: 60,
              length: 0.3,
              begin_shape_index: 1,
              end_shape_index: 3,
            },
          ],
        },
      ],
      summary: { time: 120, length: 0.6 },
      ...overrides,
    },
  };
}

function osrmRoute(overrides: Record<string, unknown> = {}) {
  return {
    code: 'Ok',
    routes: [
      {
        distance: 600,
        duration: 120,
        geometry: encodePolyline(PATH, 5),
        legs: [
          {
            steps: [
              {
                distance: 300,
                duration: 60,
                name: '市道',
                geometry: encodePolyline(PATH.slice(0, 2), 5),
                maneuver: { type: 'depart', location: PATH[0], bearing_after: 315 },
              },
              {
                distance: 300,
                duration: 60,
                name: '',
                geometry: encodePolyline(PATH.slice(1), 5),
                maneuver: { type: 'turn', modifier: 'left', location: PATH[1] },
              },
            ],
          },
        ],
        ...overrides,
      },
    ],
  };
}

describe('Valhalla の応答解析', () => {
  test('正常な応答から座標・案内・距離を読み取る', async () => {
    reply(valhallaTrip());
    const route = await valhalla.route(REQUEST);

    assert.equal(route.coordinates.length, PATH.length);
    // 距離は km で返るので 1000 倍して m にする
    assert.equal(route.distance, 600);
    assert.equal(route.duration, 120);
    assert.equal(route.maneuvers.length, 2);
    assert.equal(route.maneuvers[0].type, 'start');
    assert.equal(route.maneuvers[1].type, 'turn_left');
    assert.equal(route.maneuvers[0].streetName, '市道');
    // 次に曲がる道の名前は、後続の案内から引く
    assert.equal(route.maneuvers[0].nextStreetName, undefined);
  });

  test('つないだ形状は、そのままデコードして元の座標に戻る', async () => {
    // レグごとの polyline は「直前の点からの差分」なので、
    // 文字列を連結すると 2 本目以降が原点付近に飛ぶ。座標から符号化し直している
    const shapeA = encodePolyline(PATH.slice(0, 2), 6);
    const shapeB = encodePolyline(PATH.slice(1), 6);
    reply({
      trip: {
        legs: [
          { shape: shapeA, summary: { time: 60, length: 0.3 }, maneuvers: [] },
          { shape: shapeB, summary: { time: 60, length: 0.3 }, maneuvers: [] },
        ],
        summary: { time: 120, length: 0.6 },
      },
    });
    const route = await valhalla.route(REQUEST);

    // レグの継ぎ目の重複を除いた点数
    assert.equal(route.coordinates.length, PATH.length);
    const { decodePolyline } = await import('@ijm/shared');
    const decoded = decodePolyline(route.geometry, 6);
    assert.equal(decoded.length, PATH.length);
    for (let i = 0; i < PATH.length; i += 1) {
      assert.ok(Math.abs(decoded[i][0] - PATH[i][0]) < 1e-5, `経度 ${i}`);
      assert.ok(Math.abs(decoded[i][1] - PATH[i][1]) < 1e-5, `緯度 ${i}`);
    }
  });

  test('legs が欠けていても TypeError にならない', async () => {
    reply({ trip: { summary: { time: 1, length: 1 } } });
    await assert.rejects(() => valhalla.route(REQUEST), RoutingError);
  });

  test('maneuvers が欠けていても座標は読める', async () => {
    reply({
      trip: {
        legs: [{ shape: encodePolyline(PATH, 6), summary: { time: 1, length: 1 } }],
        summary: { time: 120, length: 0.6 },
      },
    });
    const route = await valhalla.route(REQUEST);
    assert.equal(route.coordinates.length, PATH.length);
    assert.equal(route.maneuvers.length, 0);
  });

  test('summary が欠けても距離・時間は数値になる', async () => {
    reply(valhallaTrip({ summary: undefined }));
    const route = await valhalla.route(REQUEST);
    assert.ok(Number.isFinite(route.distance), '距離が NaN');
    assert.ok(Number.isFinite(route.duration), '時間が NaN');
  });

  test('案内の距離・時間が欠けても NaN を返さない', async () => {
    reply({
      trip: {
        legs: [
          {
            shape: encodePolyline(PATH, 6),
            summary: { time: 1, length: 1 },
            maneuvers: [{ type: 1, begin_shape_index: 0, end_shape_index: 1 }],
          },
        ],
        summary: { time: 120, length: 0.6 },
      },
    });
    const route = await valhalla.route(REQUEST);
    assert.ok(Number.isFinite(route.maneuvers[0].distanceToNext), '案内までの距離が NaN');
    assert.ok(Number.isFinite(route.maneuvers[0].durationToNext), '案内までの時間が NaN');
  });

  test('形状の添字が範囲外でも 0 以上に収まる', async () => {
    // 負の添字が残ると maneuver-planner が cumulative[index] を引けず、
    // 距離 0 と扱われて「出発した瞬間に通過済み」になる
    reply({
      trip: {
        legs: [
          {
            shape: encodePolyline(PATH, 6),
            summary: { time: 1, length: 1 },
            maneuvers: [
              { type: 1, time: 1, length: 1, begin_shape_index: -5, end_shape_index: -1 },
              { type: 4, time: 1, length: 1, begin_shape_index: 9999, end_shape_index: 9999 },
            ],
          },
        ],
        summary: { time: 120, length: 0.6 },
      },
    });
    const route = await valhalla.route(REQUEST);
    for (const m of route.maneuvers) {
      assert.ok(m.shapeIndex >= 0, `添字が負: ${m.shapeIndex}`);
      assert.ok(m.shapeIndex < route.coordinates.length, `添字が範囲外: ${m.shapeIndex}`);
      assert.ok(Number.isFinite(m.location.lat) && Number.isFinite(m.location.lng), '座標が NaN');
    }
    for (const s of route.steps) {
      assert.ok(s.beginIndex >= 0 && s.endIndex >= 0, '区間の添字が負');
    }
  });

  test('形状が 1 点しか無ければ経路として返さない', async () => {
    reply({
      trip: {
        legs: [{ shape: encodePolyline([PATH[0]], 6), summary: { time: 1, length: 1 }, maneuvers: [] }],
        summary: { time: 1, length: 1 },
      },
    });
    await assert.rejects(() => valhalla.route(REQUEST), RoutingError);
  });

  test('trip が無ければ RoutingError', async () => {
    reply({ error: 'No path could be found' }, 400);
    await assert.rejects(
      () => valhalla.route(REQUEST),
      (e: unknown) => e instanceof RoutingError && e.status === 400,
    );
  });

  test('割り当ての無い移動手段は 400 で弾く（通信する前に判定する）', async () => {
    // 通信より前に弾くので、fetch を差し替えなくても外に出て行かない
    await assert.rejects(
      () => valhalla.route({ ...REQUEST, mode: 'hovercraft' as never }),
      (e: unknown) => e instanceof RoutingError && e.status === 400,
    );
  });
});

describe('OSRM の応答解析', () => {
  test('正常な応答から座標・案内を読み取る', async () => {
    reply(osrmRoute());
    const route = await osrm.route(REQUEST);
    assert.equal(route.coordinates.length, PATH.length);
    assert.equal(route.distance, 600);
    assert.equal(route.maneuvers.length, 2);
    assert.equal(route.maneuvers[0].type, 'start');
    assert.equal(route.maneuvers[1].type, 'turn_left');
  });

  test('legs が欠けていても TypeError にならない', async () => {
    reply(osrmRoute({ legs: undefined }));
    const route = await osrm.route(REQUEST);
    assert.equal(route.coordinates.length, PATH.length);
    assert.equal(route.maneuvers.length, 0);
  });

  test('steps が欠けていても TypeError にならない', async () => {
    reply(osrmRoute({ legs: [{}] }));
    const route = await osrm.route(REQUEST);
    assert.equal(route.maneuvers.length, 0);
  });

  test('maneuver.location が欠けても座標は有限', async () => {
    reply(
      osrmRoute({
        legs: [
          {
            steps: [
              { distance: 300, duration: 60, name: '市道', geometry: encodePolyline(PATH, 5), maneuver: { type: 'depart' } },
            ],
          },
        ],
      }),
    );
    const route = await osrm.route(REQUEST);
    const at = route.maneuvers[0].location;
    assert.ok(Number.isFinite(at.lat) && Number.isFinite(at.lng), '座標が NaN');
  });

  test('距離・時間が欠けても NaN を返さない', async () => {
    reply(
      osrmRoute({
        distance: undefined,
        duration: undefined,
        legs: [
          {
            steps: [
              { name: '市道', geometry: encodePolyline(PATH, 5), maneuver: { type: 'depart', location: PATH[0] } },
            ],
          },
        ],
      }),
    );
    const route = await osrm.route(REQUEST);
    assert.ok(Number.isFinite(route.distance), '総距離が NaN');
    assert.ok(Number.isFinite(route.maneuvers[0].distanceToNext), '案内までの距離が NaN');
  });

  test('形状が空なら経路として返さない', async () => {
    reply(osrmRoute({ geometry: '' }));
    await assert.rejects(() => osrm.route(REQUEST), RoutingError);
  });

  test('code が Ok でなければ RoutingError', async () => {
    reply({ code: 'NoRoute', message: '経路がありません' });
    await assert.rejects(() => osrm.route(REQUEST), RoutingError);
  });
});
