/**
 * ナビゲーションカメラ（状態機械）。
 *
 * このモジュールは 3D エンジンに依存しない。カメラの「あるべき姿勢」を計算して返すだけで、
 * 実際に Cesium のカメラへ適用するのは map-engine 側のアダプタの責務。
 * こうすることでナビの挙動を単体テストできる。
 *
 * 状態遷移:
 *   FOLLOW --(次のマニューバまで <=120m かつ曲がる)--> APPROACH_TURN
 *   APPROACH_TURN --(<=25m)--> TURN --(通過し方位差<15°)--> FOLLOW
 *   APPROACH_TURN --(交差点が複雑)--> INTERSECTION --> TURN
 *   FOLLOW --(残り<60m)--> ARRIVAL
 *   any --(ユーザー操作)--> FREE_LOOK --(6秒無操作)--> 直前の状態
 */

import type { CameraPose, LatLng, TravelMode } from '@ijm/shared';
import { angleDelta, clamp, lerp, lerpAngle, smoothDamp, smoothDampAngle } from '@ijm/shared';
import { isTurn } from './maneuver-planner';
import type { ManeuverOutlook, NavigationCameraState, RouteProgress } from './types';

export interface CameraProfile {
  /** 後方距離 (m) */
  range: number;
  /** 高さ (m) */
  height: number;
  /** 俯角 (度) */
  pitch: number;
  /** 垂直画角 (度) */
  fov: number;
  /** 注視点の前方距離 (m) */
  lookAhead: number;
  /** 補間の時定数 (s) */
  smoothTime: number;
}

export const CAMERA_PROFILES: Record<Exclude<NavigationCameraState, 'FREE_LOOK'>, CameraProfile> = {
  FOLLOW: { range: 55, height: 28, pitch: -32, fov: 60, lookAhead: 45, smoothTime: 0.45 },
  APPROACH_TURN: { range: 32, height: 34, pitch: -42, fov: 55, lookAhead: 30, smoothTime: 0.6 },
  TURN: { range: 22, height: 20, pitch: -28, fov: 65, lookAhead: 25, smoothTime: 0.35 },
  INTERSECTION: { range: 30, height: 55, pitch: -60, fov: 50, lookAhead: 20, smoothTime: 0.7 },
  ARRIVAL: { range: 45, height: 60, pitch: -55, fov: 60, lookAhead: 10, smoothTime: 1.0 },
};

/**
 * 移動手段ごとのカメラ倍率。
 *
 * 基準プロファイルは車を想定している。同じ高さのまま徒歩を案内すると、
 * ビルの屋上から自分を見下ろすような画になり、街を歩いている感覚が出ない。
 * 実際の視点に近づけるほど、周りの建物が視界に入って没入感が上がる。
 *
 *   徒歩     … 目線よりやや高い程度（7〜8m）。建物が両脇に立ち上がって見える
 *   自転車   … 徒歩と車の中間
 *   車       … 基準（車体の少し後ろ上）
 *   公共交通 … 経路が長く駅間が飛ぶので、俯瞰寄りにして全体を把握しやすくする
 */
export const MODE_CAMERA_SCALE: Record<
  TravelMode,
  { range: number; height: number; pitchFactor: number; lookAhead: number }
> = {
  walk: { range: 0.45, height: 0.28, pitchFactor: 0.72, lookAhead: 0.5 },
  bicycle: { range: 0.65, height: 0.5, pitchFactor: 0.85, lookAhead: 0.7 },
  drive: { range: 1, height: 1, pitchFactor: 1, lookAhead: 1 },
  transit: { range: 1.3, height: 1.5, pitchFactor: 1.15, lookAhead: 1.2 },
  multimodal: { range: 1.1, height: 1.2, pitchFactor: 1.05, lookAhead: 1.1 },
};

/** 移動手段に合わせてプロファイルを調整する */
export function scaleProfile(profile: CameraProfile, mode: TravelMode): CameraProfile {
  const scale = MODE_CAMERA_SCALE[mode] ?? MODE_CAMERA_SCALE.drive;
  return {
    ...profile,
    range: profile.range * scale.range,
    // 低くしすぎると地形や建物にカメラがめり込むので下限を設ける
    height: Math.max(4, profile.height * scale.height),
    // 低い位置からは浅い俯角の方が自然（真下を向くと足元しか見えない）
    pitch: Math.max(-80, profile.pitch * scale.pitchFactor),
    lookAhead: profile.lookAhead * scale.lookAhead,
  };
}

export interface NavigationCameraOptions {
  /** APPROACH_TURN に入る距離 (m) */
  approachDistance?: number;
  /** TURN に入る距離 (m) */
  turnDistance?: number;
  /** ARRIVAL に入る残距離 (m) */
  arrivalDistance?: number;
  /** FREE_LOOK から自動復帰するまでの時間 (s) */
  freeLookTimeout?: number;
  /** 交差点が複雑と判断する閾値 */
  intersectionComplexityThreshold?: number;
  /** 移動手段。カメラの高さと距離を合わせる */
  mode?: TravelMode;
}

export interface CameraUpdateInput {
  progress: RouteProgress;
  outlook: ManeuverOutlook;
  /** 前フレームからの経過時間 (s) */
  dt: number;
  /** 現在地の高さ（地形＋α, m）。分かる場合のみ */
  groundHeight?: number;
  /** 次のマニューバ地点の交差点の複雑さ（gis の intersectionComplexity） */
  intersectionComplexity?: number;
  /** 注視点として使う前方座標を計算する関数（RouteFollower.lookAheadPoint） */
  lookAheadPoint?: (distanceAlong: number, ahead: number) => LatLng;
}

export interface CameraUpdateResult {
  pose: CameraPose;
  state: NavigationCameraState;
  /** 状態がこのフレームで変化したか */
  stateChanged: boolean;
  /** 交差点を強調表示すべきか */
  highlightIntersection: boolean;
  /** 建物の透過を有効にすべきか */
  buildingTransparency: boolean;
}

export class NavigationCamera {
  private state: NavigationCameraState = 'FOLLOW';
  private previousState: NavigationCameraState = 'FOLLOW';
  private freeLookTimer = 0;

  // 平滑化のための現在値と速度
  private currentRange = CAMERA_PROFILES.FOLLOW.range;
  private currentHeight = CAMERA_PROFILES.FOLLOW.height;
  private currentPitch = CAMERA_PROFILES.FOLLOW.pitch;
  private currentFov = CAMERA_PROFILES.FOLLOW.fov;
  private currentHeading = 0;
  private currentTarget: LatLng | null = null;
  private mode: TravelMode = 'walk';

  private vRange = { value: 0 };
  private vHeight = { value: 0 };
  private vPitch = { value: 0 };
  private vFov = { value: 0 };
  private vHeading = { value: 0 };
  private vLat = { value: 0 };
  private vLng = { value: 0 };

  constructor(private readonly options: NavigationCameraOptions = {}) {
    this.mode = options.mode ?? 'walk';
  }

  /** 案内中に移動手段が変わったときに追従させる */
  setMode(mode: TravelMode): void {
    this.mode = mode;
  }

  get currentState(): NavigationCameraState {
    return this.state;
  }

  /** ユーザーがカメラを操作した */
  enterFreeLook(): void {
    if (this.state !== 'FREE_LOOK') {
      this.previousState = this.state;
      this.state = 'FREE_LOOK';
    }
    this.freeLookTimer = 0;
  }

  /** 追従へ即時復帰 */
  exitFreeLook(): void {
    if (this.state === 'FREE_LOOK') {
      this.state = this.previousState === 'FREE_LOOK' ? 'FOLLOW' : this.previousState;
      this.freeLookTimer = 0;
    }
  }

  reset(): void {
    this.state = 'FOLLOW';
    this.previousState = 'FOLLOW';
    this.freeLookTimer = 0;
    this.currentTarget = null;
    this.vRange = { value: 0 };
    this.vHeight = { value: 0 };
    this.vPitch = { value: 0 };
    this.vFov = { value: 0 };
    this.vHeading = { value: 0 };
    this.vLat = { value: 0 };
    this.vLng = { value: 0 };
  }

  update(input: CameraUpdateInput): CameraUpdateResult {
    const {
      approachDistance = 120,
      turnDistance = 25,
      arrivalDistance = 60,
      freeLookTimeout = 6,
      intersectionComplexityThreshold = 6,
    } = this.options;

    const { progress, outlook, dt } = input;
    const previous = this.state;

    if (this.state === 'FREE_LOOK') {
      this.freeLookTimer += dt;
      if (this.freeLookTimer >= freeLookTimeout) {
        this.state = this.previousState === 'FREE_LOOK' ? 'FOLLOW' : this.previousState;
      }
    }

    if (this.state !== 'FREE_LOOK') {
      this.state = this.computeState({
        progress,
        outlook,
        approachDistance,
        turnDistance,
        arrivalDistance,
        intersectionComplexity: input.intersectionComplexity ?? 0,
        intersectionComplexityThreshold,
      });
    }

    const profileState = this.state === 'FREE_LOOK' ? this.previousState : this.state;
    const base =
      CAMERA_PROFILES[profileState as Exclude<NavigationCameraState, 'FREE_LOOK'>] ??
      CAMERA_PROFILES.FOLLOW;
    // 徒歩を車と同じ高さで案内すると、屋上から自分を見下ろす画になる。
    // 移動手段に合わせて視点の高さと距離を変える
    const profile = scaleProfile(base, this.mode);

    // 速度に応じて追従距離を伸縮（徒歩と自動車で見え方を変える）
    const speedScale = clamp(0.8 + progress.speed / 14, 0.8, 1.6);

    // 目標方位: TURN 系では曲がる先の方位へ先回りする
    const targetHeading = this.computeTargetHeading(progress, outlook);

    // 注視点: 進行方向の少し前方（曲がる直前は交差点そのもの）
    const lookAheadDistance =
      this.state === 'APPROACH_TURN' && Number.isFinite(outlook.distanceToNext)
        ? clamp(outlook.distanceToNext, 8, profile.lookAhead)
        : profile.lookAhead;

    const rawTarget =
      input.lookAheadPoint?.(progress.distanceAlong, lookAheadDistance) ?? progress.position;

    if (!this.currentTarget) {
      this.currentTarget = { ...rawTarget };
      this.currentHeading = progress.heading;
    }

    const smoothTime = profile.smoothTime;

    // 位置は緯度経度それぞれを平滑化（都市スケールでは十分な近似）
    this.currentTarget = {
      lat: smoothDamp(this.currentTarget.lat, rawTarget.lat, this.vLat, smoothTime * 0.6, dt),
      lng: smoothDamp(this.currentTarget.lng, rawTarget.lng, this.vLng, smoothTime * 0.6, dt),
    };

    this.currentRange = smoothDamp(
      this.currentRange,
      profile.range * speedScale,
      this.vRange,
      smoothTime,
      dt,
    );
    this.currentHeight = smoothDamp(
      this.currentHeight,
      profile.height * clamp(speedScale, 0.9, 1.4),
      this.vHeight,
      smoothTime,
      dt,
    );
    this.currentPitch = smoothDamp(this.currentPitch, profile.pitch, this.vPitch, smoothTime, dt);
    this.currentFov = smoothDamp(this.currentFov, profile.fov, this.vFov, smoothTime, dt);
    this.currentHeading = smoothDampAngle(
      this.currentHeading,
      targetHeading,
      this.vHeading,
      smoothTime,
      dt,
    );

    const pose: CameraPose = {
      target: {
        lat: this.currentTarget.lat,
        lng: this.currentTarget.lng,
        alt: input.groundHeight,
      },
      range: this.currentRange,
      height: this.currentHeight,
      heading: this.currentHeading,
      pitch: this.currentPitch,
      fov: this.currentFov,
    };

    return {
      pose,
      state: this.state,
      stateChanged: previous !== this.state,
      highlightIntersection: this.state === 'INTERSECTION' || this.state === 'APPROACH_TURN',
      buildingTransparency: this.state === 'APPROACH_TURN' || this.state === 'TURN',
    };
  }

  private computeState(args: {
    progress: RouteProgress;
    outlook: ManeuverOutlook;
    approachDistance: number;
    turnDistance: number;
    arrivalDistance: number;
    intersectionComplexity: number;
    intersectionComplexityThreshold: number;
  }): NavigationCameraState {
    const {
      progress,
      outlook,
      approachDistance,
      turnDistance,
      arrivalDistance,
      intersectionComplexity,
      intersectionComplexityThreshold,
    } = args;

    if (progress.remainingDistance <= arrivalDistance) return 'ARRIVAL';

    const turning = isTurn(outlook.next);
    const d = outlook.distanceToNext;

    if (turning && d <= turnDistance) return 'TURN';

    if (turning && d <= approachDistance) {
      return intersectionComplexity >= intersectionComplexityThreshold ? 'INTERSECTION' : 'APPROACH_TURN';
    }

    // 曲がり終えた直後: 方位が落ち着くまでは TURN を維持する
    if (this.state === 'TURN') {
      const current = outlook.current;
      const target = current?.bearingAfter;
      if (target !== undefined && Math.abs(angleDelta(progress.heading, target)) > 15) {
        return 'TURN';
      }
    }

    return 'FOLLOW';
  }

  /**
   * 目標方位。曲がる手前では、現在の進行方位と曲がった先の方位の「中間」へ
   * 徐々に寄せることで、曲がる方向が事前に分かる画になる。
   */
  private computeTargetHeading(progress: RouteProgress, outlook: ManeuverOutlook): number {
    const next = outlook.next;
    if (!next || !isTurn(next) || next.bearingAfter === undefined) {
      return progress.heading;
    }

    const approach = this.options.approachDistance ?? 120;
    const d = clamp(outlook.distanceToNext, 0, approach);

    if (this.state === 'TURN') {
      // 曲がっている最中は曲がった先を向く
      return next.bearingAfter;
    }
    if (this.state === 'APPROACH_TURN' || this.state === 'INTERSECTION') {
      // 近づくほど曲がる先の方位へ寄せる（最大 50% まで）
      const t = (1 - d / approach) * 0.5;
      return lerpAngle(progress.heading, next.bearingAfter, t);
    }
    return progress.heading;
  }
}

/** カメラ姿勢からカメラ自身の位置（注視点の後方）を求める。表示側の補助。 */
export function cameraPositionOf(pose: CameraPose): { lat: number; lng: number; height: number } {
  // 方位の逆方向に range だけ下がった位置
  const back = (pose.heading + 180) % 360;
  const rad = (back * Math.PI) / 180;
  const dLat = (pose.range * Math.cos(rad)) / 110540;
  const dLng =
    (pose.range * Math.sin(rad)) /
    (111320 * Math.max(0.01, Math.cos((pose.target.lat * Math.PI) / 180)));
  return {
    lat: pose.target.lat + dLat,
    lng: pose.target.lng + dLng,
    height: (pose.target.alt ?? 0) + pose.height,
  };
}

/** 2 つの姿勢の線形補間（状態遷移のブレンドに使う） */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    target: {
      lat: lerp(a.target.lat, b.target.lat, t),
      lng: lerp(a.target.lng, b.target.lng, t),
      alt: lerp(a.target.alt ?? 0, b.target.alt ?? 0, t),
    },
    range: lerp(a.range, b.range, t),
    height: lerp(a.height, b.height, t),
    heading: lerpAngle(a.heading, b.heading, t),
    pitch: lerp(a.pitch, b.pitch, t),
    fov: lerp(a.fov, b.fov, t),
  };
}
