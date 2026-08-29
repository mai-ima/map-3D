/**
 * ナビゲーションセッション。
 * RouteFollower / ManeuverPlanner / NavigationCamera / GuidanceGenerator を束ねる。
 *
 * 3D エンジンには依存しない。呼び出し側（map-engine アダプタ）が毎フレーム tick() し、
 * 返ってきたカメラ姿勢と演出フラグを Cesium に適用する。
 */

import type { LatLng, Route } from '@ijm/shared';
import { cumulativeDistances } from '@ijm/shared';
import { GuidanceGenerator, type Announcement } from './guidance';
import { ManeuverPlanner } from './maneuver-planner';
import { NavigationCamera, type CameraUpdateResult } from './navigation-camera';
import { RouteFollower } from './route-follower';
import type { ManeuverOutlook, NavigationOptions, RouteProgress } from './types';

export interface NavigationTickResult {
  progress: RouteProgress;
  outlook: ManeuverOutlook;
  camera: CameraUpdateResult;
  announcement: Announcement | null;
}

export interface NavigationSessionOptions extends NavigationOptions {
  /** シミュレーション時の速度 (m/s)。徒歩 1.4 / 自転車 4.5 / 自動車 11 が目安 */
  simulationSpeed?: number;
  /** 交差点の複雑さを問い合わせる関数（gis 側の実装を注入する） */
  intersectionComplexityAt?: (point: LatLng) => number;
}

export class NavigationSession {
  readonly follower: RouteFollower;
  readonly planner: ManeuverPlanner;
  readonly camera: NavigationCamera;
  private readonly guidance = new GuidanceGenerator();
  private lastTickAt = 0;

  constructor(
    readonly route: Route,
    private readonly options: NavigationSessionOptions = {},
  ) {
    const cumulative = cumulativeDistances(route.coordinates);
    this.follower = new RouteFollower(route, options);
    this.planner = new ManeuverPlanner(route, cumulative);
    this.camera = new NavigationCamera();
  }

  /** 既定のシミュレーション速度（移動手段から決める） */
  get defaultSpeed(): number {
    if (this.options.simulationSpeed) return this.options.simulationSpeed;
    switch (this.route.mode) {
      case 'drive':
        return 11;
      case 'bicycle':
        return 4.5;
      default:
        return 1.5;
    }
  }

  /**
   * 1 フレーム進める。
   * @param position 実測位置。省略時はシミュレーション走行。
   */
  tick(nowMs: number, position?: LatLng): NavigationTickResult {
    const dt = this.lastTickAt ? Math.min(0.1, (nowMs - this.lastTickAt) / 1000) : 1 / 60;
    this.lastTickAt = nowMs;

    const progress = position
      ? this.follower.update(position, nowMs)
      : this.follower.advance(dt, this.defaultSpeed);

    const outlook = this.planner.outlook(progress.distanceAlong);

    const complexity =
      outlook.next && this.options.intersectionComplexityAt
        ? this.options.intersectionComplexityAt(outlook.next.location)
        : (outlook.next?.intersectionComplexity ?? 0);

    const camera = this.camera.update({
      progress,
      outlook,
      dt,
      intersectionComplexity: complexity,
      lookAheadPoint: (along, ahead) => this.follower.lookAheadPoint(along, ahead),
    });

    const announcement = this.guidance.update(progress, outlook);

    return { progress, outlook, camera, announcement };
  }

  seek(distanceAlong: number): void {
    this.follower.seek(distanceAlong);
    this.camera.reset();
    this.guidance.reset();
  }

  reset(): void {
    this.follower.seek(0);
    this.camera.reset();
    this.guidance.reset();
    this.lastTickAt = 0;
  }
}
