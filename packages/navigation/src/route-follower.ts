/**
 * ルート追従。
 *
 * 現在地（GPS もしくはシミュレーション）をルートに投影し、
 * 進行距離・進行方位・残距離・逸脱を算出する。Cesium には依存しない。
 */

import type { LatLng, Route } from '@ijm/shared';
import {
  clamp,
  cumulativeDistances,
  distanceMeters,
  headingAtIndex,
  lerpAngle,
  pointAtDistance,
  projectOnPolyline,
} from '@ijm/shared';
import type { NavigationOptions, RouteProgress } from './types';

export class RouteFollower {
  private readonly cumulative: number[];
  private readonly totalDistance: number;
  private lastSegmentIndex = 0;
  private lastDistanceAlong = 0;
  private lastHeading: number;
  private lastUpdateAt = 0;
  private speed = 0;
  /**
   * 最後に使えた位置。
   *
   * GPS はまれに壊れた値（NaN）を返す。そのまま進捗の計算に入れると
   * 距離も方位も NaN になり、案内が止まったまま復帰しなくなる。
   */
  private lastPosition: LatLng;

  constructor(
    readonly route: Route,
    private readonly options: NavigationOptions = {},
  ) {
    this.cumulative = cumulativeDistances(route.coordinates);
    this.totalDistance = this.cumulative[this.cumulative.length - 1] ?? 0;
    this.lastHeading = headingAtIndex(route.coordinates, 0, 2);
    const first = route.coordinates[0];
    this.lastPosition = first ? { lng: first[0], lat: first[1] } : { lat: 0, lng: 0 };
  }

  get total(): number {
    return this.totalDistance;
  }

  get cumulativeDistances(): number[] {
    return this.cumulative;
  }

  /**
   * 実測位置（GPS など）から進捗を更新する。
   * 前回の区間インデックスの周辺だけを探索するので、長いルートでも軽い。
   */
  update(rawInput: LatLng, timestampMs = Date.now()): RouteProgress {
    const offRouteThreshold = this.options.offRouteThreshold ?? 35;
    const arrivalThreshold = this.options.arrivalThreshold ?? 20;

    // 測位が壊れた値を返すことがある。使える値だけを進捗に反映し、
    // 壊れているときは前回の位置のまま進める（案内を止めない）
    const position: LatLng =
      Number.isFinite(rawInput?.lat) && Number.isFinite(rawInput?.lng)
        ? rawInput
        : this.lastPosition;
    this.lastPosition = position;

    // まず直近区間の周辺を探索し、外れていれば全体を探索する（復帰用）
    let projection = projectOnPolyline(
      position,
      this.route.coordinates,
      this.cumulative,
      Math.max(0, this.lastSegmentIndex - 3),
      40,
    );
    if (projection.distance > offRouteThreshold) {
      projection = projectOnPolyline(position, this.route.coordinates, this.cumulative);
    }

    const dt = this.lastUpdateAt ? (timestampMs - this.lastUpdateAt) / 1000 : 0;
    if (dt > 0.05) {
      const moved = projection.distanceAlong - this.lastDistanceAlong;
      // 平滑化した速度（GPS のばらつきを吸収）
      this.speed = clamp(this.speed * 0.7 + (moved / dt) * 0.3, 0, 60);
      this.lastUpdateAt = timestampMs;
    } else if (!this.lastUpdateAt) {
      this.lastUpdateAt = timestampMs;
    }

    this.lastSegmentIndex = projection.segmentIndex;
    this.lastDistanceAlong = projection.distanceAlong;

    const targetHeading = headingAtIndex(this.route.coordinates, projection.segmentIndex, 2);
    // 進行方位も平滑化（区間の切り替わりでカクつかないように）
    this.lastHeading = lerpAngle(this.lastHeading, targetHeading, 0.35);

    const remainingDistance = Math.max(0, this.totalDistance - projection.distanceAlong);
    const ratio = this.totalDistance > 0 ? remainingDistance / this.totalDistance : 0;

    return {
      position: projection.point,
      rawPosition: position,
      distanceAlong: projection.distanceAlong,
      remainingDistance,
      remainingDuration: Math.round(this.route.duration * ratio),
      heading: this.lastHeading,
      segmentIndex: projection.segmentIndex,
      offRouteDistance: projection.distance,
      offRoute: projection.distance > offRouteThreshold,
      speed: this.speed,
      arrived: remainingDistance <= arrivalThreshold,
    };
  }

  /**
   * シミュレーション走行（GPS が無い環境でのデモ・プレビュー用）。
   * 実際の走行データを捏造しているわけではなく、あくまで表示用の再生機能。
   */
  advance(dtSeconds: number, speedMps: number): RouteProgress {
    this.lastDistanceAlong = clamp(
      this.lastDistanceAlong + speedMps * dtSeconds,
      0,
      this.totalDistance,
    );
    const at = pointAtDistance(this.route.coordinates, this.cumulative, this.lastDistanceAlong);
    this.lastSegmentIndex = at.segmentIndex;
    this.speed = speedMps;

    const targetHeading = headingAtIndex(this.route.coordinates, at.segmentIndex, 2);
    this.lastHeading = lerpAngle(this.lastHeading, targetHeading, clamp(dtSeconds * 3, 0, 1));

    const remainingDistance = Math.max(0, this.totalDistance - this.lastDistanceAlong);
    const ratio = this.totalDistance > 0 ? remainingDistance / this.totalDistance : 0;
    const arrivalThreshold = this.options.arrivalThreshold ?? 20;

    return {
      position: at.point,
      rawPosition: at.point,
      distanceAlong: this.lastDistanceAlong,
      remainingDistance,
      remainingDuration: Math.round(this.route.duration * ratio),
      heading: this.lastHeading,
      segmentIndex: at.segmentIndex,
      offRouteDistance: 0,
      offRoute: false,
      speed: speedMps,
      arrived: remainingDistance <= arrivalThreshold,
    };
  }

  /** 指定した進行距離へジャンプする（スクラブ操作用） */
  seek(distanceAlong: number): void {
    this.lastDistanceAlong = clamp(distanceAlong, 0, this.totalDistance);
    const at = pointAtDistance(this.route.coordinates, this.cumulative, this.lastDistanceAlong);
    this.lastSegmentIndex = at.segmentIndex;
    this.lastHeading = headingAtIndex(this.route.coordinates, at.segmentIndex, 2);
  }

  /** 現在地から見た「前方 n メートル」の座標（カメラの注視点に使う） */
  lookAheadPoint(distanceAlong: number, lookAheadMeters: number): LatLng {
    return pointAtDistance(
      this.route.coordinates,
      this.cumulative,
      distanceAlong + lookAheadMeters,
    ).point;
  }

  /** 直線距離での目的地までの距離 */
  straightLineToDestination(position: LatLng): number {
    const last = this.route.coordinates[this.route.coordinates.length - 1];
    return distanceMeters(position, { lng: last[0], lat: last[1] });
  }
}
