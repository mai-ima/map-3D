/**
 * マニューバ先読み。
 *
 * 「次の交差点を予測する」ためのモジュール。
 * 現在の進行距離から、次／その次のマニューバとそこまでの距離を毎フレーム算出する。
 */

import type { IconName, Maneuver, Route } from '@ijm/shared';
import type { ManeuverOutlook } from './types';

const TURN_TYPES = new Set([
  'turn_left',
  'turn_right',
  'sharp_left',
  'sharp_right',
  'slight_left',
  'slight_right',
  'uturn',
  'roundabout_enter',
  'roundabout_exit',
]);

export function isTurn(maneuver?: Maneuver): boolean {
  return Boolean(maneuver && TURN_TYPES.has(maneuver.type));
}

/** 案内表示用の短いラベル（例: 「右折」） */
export function maneuverLabel(maneuver?: Maneuver): string {
  if (!maneuver) return '';
  switch (maneuver.type) {
    case 'start':
      return '出発';
    case 'continue':
      return '直進';
    case 'slight_left':
      return '斜め左';
    case 'slight_right':
      return '斜め右';
    case 'turn_left':
      return '左折';
    case 'turn_right':
      return '右折';
    case 'sharp_left':
      return '鋭角左折';
    case 'sharp_right':
      return '鋭角右折';
    case 'uturn':
      return 'Uターン';
    case 'ramp':
      return 'ランプ';
    case 'merge':
      return '合流';
    case 'roundabout_enter':
      return 'ラウンドアバウト';
    case 'roundabout_exit':
      return 'ラウンドアバウトを出る';
    case 'ferry':
      return 'フェリー';
    case 'transit':
      return '乗車';
    case 'stairs':
      return '階段';
    case 'destination':
      return '目的地';
    default:
      return '';
  }
}

/**
 * マニューバに対応するアイコン名（@ijm/shared の ICONS）。
 * 文字記号や絵文字ではなく SVG を描くため、ここでは「名前」だけを返す。
 */
export function maneuverIcon(maneuver?: Maneuver): IconName {
  if (!maneuver) return 'straight';
  switch (maneuver.type) {
    case 'turn_left':
      return 'turnLeft';
    case 'turn_right':
      return 'turnRight';
    case 'slight_left':
      return 'slightLeft';
    case 'slight_right':
      return 'slightRight';
    case 'sharp_left':
      return 'sharpLeft';
    case 'sharp_right':
      return 'sharpRight';
    case 'uturn':
      return 'uturn';
    case 'merge':
      return 'merge';
    case 'ramp':
      return 'ramp';
    case 'roundabout_enter':
    case 'roundabout_exit':
      return 'roundabout';
    case 'stairs':
      return 'stairs';
    case 'ferry':
      return 'ferry';
    case 'transit':
      return 'transit';
    case 'destination':
      return 'destination';
    default:
      return 'straight';
  }
}

export class ManeuverPlanner {
  /** 各マニューバのルート始点からの距離 */
  private readonly distances: number[];

  constructor(
    private readonly route: Route,
    private readonly cumulative: number[],
  ) {
    this.distances = route.maneuvers.map((m) => this.cumulative[m.shapeIndex] ?? 0);
  }

  /** 現在の進行距離から先読み情報を作る */
  outlook(distanceAlong: number): ManeuverOutlook {
    const maneuvers = this.route.maneuvers;
    if (maneuvers.length === 0) {
      return { distanceToNext: Infinity, distanceToAfterNext: Infinity };
    }

    // 現在地より先にある最初のマニューバを二分探索
    let lo = 0;
    let hi = this.distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.distances[mid] <= distanceAlong + 0.5) lo = mid + 1;
      else hi = mid;
    }
    const nextIndex = this.distances[lo] <= distanceAlong + 0.5 ? this.distances.length : lo;

    const current = maneuvers[Math.max(0, nextIndex - 1)];
    const next = maneuvers[nextIndex];
    const afterNext = maneuvers[nextIndex + 1];

    return {
      current,
      next,
      afterNext,
      distanceToNext: next ? Math.max(0, this.distances[nextIndex] - distanceAlong) : Infinity,
      distanceToAfterNext: afterNext
        ? Math.max(0, this.distances[nextIndex + 1] - distanceAlong)
        : Infinity,
      currentStreetName: current?.streetName,
      nextStreetName: next?.streetName ?? current?.nextStreetName,
    };
  }

  /** 指定マニューバのルート始点からの距離 */
  distanceOf(index: number): number {
    return this.distances[index] ?? 0;
  }
}

/** 距離の日本語表記（案内パネル用） */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '';
  if (meters < 10) return 'まもなく';
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

/** 所要時間の日本語表記 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '1分未満';
  if (mins < 60) return `${mins}分`;
  const h = Math.floor(mins / 60);
  return `${h}時間${mins % 60}分`;
}
