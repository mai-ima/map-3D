import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Route } from '@ijm/shared';
import { cumulativeDistances } from '@ijm/shared';
import { ManeuverPlanner, formatDistance, formatEta } from '../maneuver-planner';
import { CAMERA_PROFILES, NavigationCamera, scaleProfile } from '../navigation-camera';
import { RouteFollower } from '../route-follower';
import { NavigationSession } from '../session';

/**
 * テスト用の直線→右折ルート。
 * 東西に 200m 進み、そこから北へ 200m 進む。
 */
function makeRoute(): Route {
  const coords: [number, number][] = [];
  const lat0 = 35.68;
  const lng0 = 139.76;
  // 東へ（約 200m）
  for (let i = 0; i <= 10; i++) coords.push([lng0 + i * 0.00022, lat0]);
  // 北へ（約 200m）
  for (let i = 1; i <= 10; i++) coords.push([lng0 + 10 * 0.00022, lat0 + i * 0.00018]);

  return {
    id: 'test-route',
    mode: 'walk',
    geometry: '',
    coordinates: coords,
    distance: 400,
    duration: 300,
    steps: [],
    maneuvers: [
      {
        type: 'start',
        instruction: '出発します',
        location: { lat: lat0, lng: lng0 },
        bearingAfter: 90,
        distanceToNext: 200,
        durationToNext: 150,
        shapeIndex: 0,
      },
      {
        type: 'turn_left',
        instruction: '左折します',
        location: { lat: lat0, lng: lng0 + 10 * 0.00022 },
        bearingBefore: 90,
        bearingAfter: 0,
        distanceToNext: 200,
        durationToNext: 150,
        shapeIndex: 10,
        streetName: 'テスト通り',
      },
      {
        type: 'destination',
        instruction: '目的地です',
        location: { lat: lat0 + 10 * 0.00018, lng: lng0 + 10 * 0.00022 },
        distanceToNext: 0,
        durationToNext: 0,
        shapeIndex: 20,
      },
    ],
    bbox: [lng0, lat0, lng0 + 0.0022, lat0 + 0.0018],
    attribution: [],
    engine: 'test',
  };
}

test('RouteFollower: シミュレーション走行で距離が進み、到着を検出する', () => {
  const route = makeRoute();
  const follower = new RouteFollower(route);

  let progress = follower.advance(1, 10);
  assert.ok(progress.distanceAlong > 9 && progress.distanceAlong < 11);
  assert.equal(progress.arrived, false);

  // 十分な距離を進める
  for (let i = 0; i < 60; i++) progress = follower.advance(1, 10);
  assert.equal(progress.arrived, true);
  assert.ok(progress.remainingDistance < 20);
});

test('RouteFollower: ルート外の点はスナップされ、逸脱として検出される', () => {
  const route = makeRoute();
  const follower = new RouteFollower(route, { offRouteThreshold: 30 });

  const onRoute = follower.update({ lat: 35.68, lng: 139.7611 });
  assert.equal(onRoute.offRoute, false);

  // 約 100m 北にずれた点
  const offRoute = follower.update({ lat: 35.6809, lng: 139.7611 });
  assert.equal(offRoute.offRoute, true);
  assert.ok(offRoute.offRouteDistance > 50);
});

test('ManeuverPlanner: 進行距離に応じて次のマニューバを返す', () => {
  const route = makeRoute();
  const cumulative = cumulativeDistances(route.coordinates);
  const planner = new ManeuverPlanner(route, cumulative);

  const atStart = planner.outlook(0);
  assert.equal(atStart.next?.type, 'turn_left');
  assert.ok(atStart.distanceToNext > 150 && atStart.distanceToNext < 250);

  const nearTurn = planner.outlook(cumulative[10] - 10);
  assert.equal(nearTurn.next?.type, 'turn_left');
  assert.ok(nearTurn.distanceToNext <= 11);

  const afterTurn = planner.outlook(cumulative[10] + 10);
  assert.equal(afterTurn.next?.type, 'destination');
  assert.equal(afterTurn.current?.type, 'turn_left');
});

test('NavigationCamera: 交差点に近づくと APPROACH_TURN → TURN と遷移する', () => {
  const route = makeRoute();
  const session = new NavigationSession(route, { simulationSpeed: 5 });

  const states = new Set<string>();
  let now = 0;
  // 400m を 5m/s で走るので、0.1 秒刻みなら 800 tick 前後で完走する
  for (let i = 0; i < 1200; i++) {
    now += 100; // 0.1 秒刻み
    const result = session.tick(now);
    states.add(result.camera.state);
    if (result.progress.arrived) break;
  }

  assert.ok(states.has('FOLLOW'), '追従状態が発生する');
  assert.ok(states.has('APPROACH_TURN'), '交差点接近状態が発生する');
  assert.ok(states.has('TURN'), '旋回状態が発生する');
  assert.ok(states.has('ARRIVAL'), '到着状態が発生する');
});

test('NavigationCamera: FREE_LOOK は一定時間後に自動復帰する', () => {
  const camera = new NavigationCamera({ freeLookTimeout: 2 });
  const progress = {
    position: { lat: 35.68, lng: 139.76 },
    rawPosition: { lat: 35.68, lng: 139.76 },
    distanceAlong: 0,
    remainingDistance: 400,
    remainingDuration: 300,
    heading: 90,
    segmentIndex: 0,
    offRouteDistance: 0,
    offRoute: false,
    speed: 1.4,
    arrived: false,
  };
  const outlook = { distanceToNext: 300, distanceToAfterNext: Infinity };

  camera.enterFreeLook();
  assert.equal(camera.update({ progress, outlook, dt: 1 }).state, 'FREE_LOOK');
  assert.equal(camera.update({ progress, outlook, dt: 1.5 }).state, 'FOLLOW');
});

test('NavigationCamera: カメラ姿勢が急変せず滑らかに補間される', () => {
  const route = makeRoute();
  const session = new NavigationSession(route, { simulationSpeed: 8 });

  let previousHeading: number | null = null;
  let maxJump = 0;
  let now = 0;

  // 曲がり角を含めて全区間を走り切り、その間の方位変化を監視する
  for (let i = 0; i < 1500; i++) {
    now += 50; // 0.05 秒刻み（20fps 相当）
    const { camera, progress } = session.tick(now);
    if (previousHeading !== null) {
      const delta = Math.abs(((camera.pose.heading - previousHeading + 540) % 360) - 180);
      maxJump = Math.max(maxJump, delta);
    }
    previousHeading = camera.pose.heading;
    if (progress.arrived) break;
  }

  // 1 フレーム (0.05s) あたりの方位変化が 25 度を超えないこと
  assert.ok(maxJump < 25, `方位の最大変化 ${maxJump.toFixed(1)}度`);
});

test('音声案内: 同じ案内を二重に発話しない', () => {
  const route = makeRoute();
  const session = new NavigationSession(route, { simulationSpeed: 4 });
  const ids = new Set<string>();
  let duplicates = 0;
  let now = 0;

  for (let i = 0; i < 300; i++) {
    now += 100;
    const { announcement, progress } = session.tick(now);
    if (announcement) {
      if (ids.has(announcement.id)) duplicates++;
      ids.add(announcement.id);
    }
    if (progress.arrived) break;
  }

  assert.equal(duplicates, 0);
  assert.ok(ids.size > 0, '少なくとも 1 回は案内が出る');
});

test('距離表示のフォーマット', () => {
  assert.equal(formatDistance(5), 'まもなく');
  assert.equal(formatDistance(84), '80m');
  assert.equal(formatDistance(1500), '1.5km');
});

test('移動手段に応じてカメラの視点が変わる', () => {
  const base = CAMERA_PROFILES.FOLLOW;

  const walk = scaleProfile(base, 'walk');
  const drive = scaleProfile(base, 'drive');
  const transit = scaleProfile(base, 'transit');

  // 徒歩は目線に近い高さにする。車と同じ高さだと屋上から見下ろす画になる
  assert.ok(walk.height < drive.height, '徒歩は車より低い視点');
  assert.ok(walk.height <= 10, `徒歩の視点が高すぎる (${walk.height}m)`);
  assert.ok(walk.range < drive.range, '徒歩は車より近くから追う');

  // 低い位置から真下を向くと足元しか見えないので、俯角は浅くする
  assert.ok(walk.pitch > drive.pitch, '徒歩は俯角を浅くする');

  // 公共交通は駅間が飛ぶので俯瞰寄り
  assert.ok(transit.height > drive.height, '公共交通は俯瞰寄り');

  // 地形や建物にめり込まない下限を守る
  for (const mode of ['walk', 'bicycle', 'drive', 'transit', 'multimodal'] as const) {
    for (const state of ['FOLLOW', 'APPROACH_TURN', 'TURN', 'INTERSECTION', 'ARRIVAL'] as const) {
      const p = scaleProfile(CAMERA_PROFILES[state], mode);
      assert.ok(p.height >= 4, `${mode}/${state}: 視点が低すぎる (${p.height}m)`);
      assert.ok(p.pitch >= -80 && p.pitch < 0, `${mode}/${state}: 俯角が不正 (${p.pitch})`);
      assert.ok(p.range > 0, `${mode}/${state}: 追従距離が不正`);
    }
  }
});

test('到着予想時刻を出す', () => {
  const now = new Date('2026-08-29T14:12:00');

  // 23 分後に着く
  assert.equal(formatEta(23 * 60, now), '14:35');
  // 0 秒なら今の時刻
  assert.equal(formatEta(0, now), '14:12');
  // 日付をまたぐ場合は「翌」を付ける（何時に着くのか分からなくなるため）
  assert.equal(formatEta(12 * 3600, now), '翌 02:12');
  assert.equal(formatEta(48 * 3600, now), '2日後 14:12');

  // 値が取れない場合は何も出さない
  assert.equal(formatEta(Number.NaN, now), '');
  assert.equal(formatEta(-1, now), '');
});

test('経路の逸脱を検知する', () => {
  // 逸脱の検知は自動リルートの起点になる。
  // 一瞬のぶれで再検索しないよう、UI 側では「外れた状態が続くこと」も条件にしている。
  const route = makeRoute();
  const follower = new RouteFollower(route, { offRouteThreshold: 25 });

  // 経路上（東向きの直線区間）を進んでいる間は逸脱しない
  const onRoute = follower.update({ lat: 35.68, lng: 139.7611 });
  assert.equal(onRoute.offRoute, false);

  // 経路から南へ大きく離れたら逸脱と判定する
  const offRoute = follower.update({ lat: 35.6795, lng: 139.7611 });
  assert.equal(offRoute.offRoute, true, `逸脱距離 ${offRoute.offRouteDistance}m`);
  assert.ok(offRoute.offRouteDistance > 25);
});
