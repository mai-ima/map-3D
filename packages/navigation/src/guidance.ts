/**
 * 音声案内のトリガ判定。
 *
 * 「いつ何を喋るか」を決めるだけで、実際の発話は UI 側（Web Speech API）が行う。
 */

import type { Maneuver } from '@ijm/shared';
import { formatDistance, maneuverLabel } from './maneuver-planner';
import type { ManeuverOutlook, RouteProgress } from './types';

export interface Announcement {
  id: string;
  text: string;
  priority: 'normal' | 'high';
}

/** 案内を出す残距離のしきい値 (m) */
const TRIGGER_DISTANCES = [700, 300, 120, 40] as const;

export class GuidanceGenerator {
  private spoken = new Set<string>();
  private lastManeuverKey = '';

  reset(): void {
    this.spoken.clear();
    this.lastManeuverKey = '';
  }

  private keyOf(maneuver: Maneuver, trigger: number): string {
    return `${maneuver.shapeIndex}:${maneuver.type}:${trigger}`;
  }

  update(progress: RouteProgress, outlook: ManeuverOutlook): Announcement | null {
    if (progress.arrived) {
      const id = 'arrived';
      if (!this.spoken.has(id)) {
        this.spoken.add(id);
        return { id, text: '目的地に到着しました。', priority: 'high' };
      }
      return null;
    }

    if (progress.offRoute) {
      const id = `off-route:${Math.round(progress.distanceAlong / 50)}`;
      if (!this.spoken.has(id)) {
        this.spoken.add(id);
        return { id, text: 'ルートから外れています。経路を再検索します。', priority: 'high' };
      }
      return null;
    }

    const next = outlook.next;
    if (!next) return null;

    const maneuverKey = `${next.shapeIndex}:${next.type}`;
    if (maneuverKey !== this.lastManeuverKey) {
      this.lastManeuverKey = maneuverKey;
    }

    for (const trigger of TRIGGER_DISTANCES) {
      if (outlook.distanceToNext > trigger) continue;
      const id = this.keyOf(next, trigger);
      if (this.spoken.has(id)) continue;
      this.spoken.add(id);

      const label = maneuverLabel(next);
      if (!label) return null;

      const street = next.streetName ? `${next.streetName}方向、` : '';
      const text =
        trigger <= 40
          ? `まもなく${label}です。`
          : `${formatDistance(outlook.distanceToNext)}先、${street}${label}です。`;
      return { id, text, priority: trigger <= 120 ? 'high' : 'normal' };
    }

    return null;
  }
}
