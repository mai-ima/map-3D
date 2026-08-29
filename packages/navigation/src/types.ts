import type { LatLng, Maneuver, Route } from '@ijm/shared';

export type NavigationCameraState =
  | 'FOLLOW'
  | 'APPROACH_TURN'
  | 'TURN'
  | 'INTERSECTION'
  | 'ARRIVAL'
  | 'FREE_LOOK';

/** ルート上の現在位置（RouteFollower の出力） */
export interface RouteProgress {
  /** ルートにスナップした位置 */
  position: LatLng;
  /** スナップ前の生の位置 */
  rawPosition: LatLng;
  /** ルート始点からの距離 (m) */
  distanceAlong: number;
  /** 残り距離 (m) */
  remainingDistance: number;
  /** 残り時間 (s) */
  remainingDuration: number;
  /** 進行方位 (度) */
  heading: number;
  /** 現在の区間インデックス */
  segmentIndex: number;
  /** ルートからの逸脱距離 (m) */
  offRouteDistance: number;
  /** 逸脱と判断されたか */
  offRoute: boolean;
  /** 現在の速度 (m/s) */
  speed: number;
  /** 目的地に到達したか */
  arrived: boolean;
}

/** 次に案内すべきマニューバ（ManeuverPlanner の出力） */
export interface ManeuverOutlook {
  current?: Maneuver;
  next?: Maneuver;
  afterNext?: Maneuver;
  /** 次のマニューバまでの距離 (m) */
  distanceToNext: number;
  /** 次の次のマニューバまでの距離 (m) */
  distanceToAfterNext: number;
  /** 現在走行中の道路名 */
  currentStreetName?: string;
  /** 次に進む道路名 */
  nextStreetName?: string;
}

export interface NavigationSnapshot {
  progress: RouteProgress;
  outlook: ManeuverOutlook;
  cameraState: NavigationCameraState;
}

export interface NavigationOptions {
  /** 逸脱と判断する距離 (m) */
  offRouteThreshold?: number;
  /** 到着と判断する残距離 (m) */
  arrivalThreshold?: number;
}

export interface RouteContext {
  route: Route;
  cumulative: number[];
}
