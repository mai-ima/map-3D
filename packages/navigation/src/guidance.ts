/**
 * 音声案内のトリガ判定。
 *
 * 「いつ何を喋るか」を決めるだけで、実際の発話は UI 側（Web Speech API）が行う。
 */

import type { Maneuver } from '@ijm/shared';
import { laneAdvice } from './lane-guidance';
import { formatDistance, maneuverLabel } from './maneuver-planner';
import type { ManeuverOutlook, RouteProgress } from './types';

export interface Announcement {
  id: string;
  text: string;
  priority: 'normal' | 'high';
}

/** 案内を出す残距離のしきい値 (m) */
const TRIGGER_DISTANCES = [700, 300, 120, 40] as const;

/**
 * 車線案内を読み上げる距離 (m)。
 *
 * 遠すぎると別の交差点の話だと思われ、近すぎると車線変更が間に合わない。
 * 300m あれば、法定速度 60km/h でおよそ 18 秒あり、1 車線ぶん寄れる。
 * 一度だけ言う（毎回言うとうるさい）。
 */
const LANE_TRIGGER_M = 300;

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

      // 経路エンジンが距離に応じた文言を返していれば、それを優先する。
      // 実際の道路名や交差点名が入っているので、こちらで組み立てた文より正確。
      const text = this.textFor(next, outlook.distanceToNext, trigger, label);
      if (!text) return null;

      /**
       * 車線案内を 1 回だけ足す。
       *
       * OSM に `turn:lanes` があり、かつ通れる車線が限られているときだけ。
       * 全車線が通れるなら言うことは無い（`laneAdvice` が null を返す）。
       */
      const lanes = trigger === LANE_TRIGGER_M ? laneAdvice(next.lanes) : null;
      return {
        id,
        text: lanes ? `${text}${lanes}` : text,
        priority: trigger <= 120 ? 'high' : 'normal',
      };
    }

    return null;
  }

  /**
   * 距離に応じた案内文を選ぶ。
   *
   * カーナビは近づくにつれて文言を変える。
   *   遠い  … 「300メートル先、田町中央通りを右方向です」
   *   直前  … 「右方向です」
   * 経路エンジンが用意している文言があればそれを使い、
   * 無ければ距離と種別から組み立てる。
   */
  private textFor(
    maneuver: Maneuver,
    distance: number,
    trigger: number,
    label: string,
  ): string | null {
    // 直前は短く言い切る。長い文だと曲がり終わってから読み終わる
    if (trigger <= 40) {
      return maneuver.verbalAlert ?? `まもなく${label}です。`;
    }

    const distanceText = formatDistance(distance);
    if (maneuver.verbalInstruction) {
      return `${distanceText}先、${maneuver.verbalInstruction}`;
    }

    /**
     * 道路名と方面を添える。
     *
     * 案内標識に書かれている行き先（OSM の `destination`）があれば、
     * 道路名より先に言う。標識と同じ語で言うほうが照らし合わせやすい。
     * どちらも無ければ、距離と種別だけで言い切る（作り話をしない）。
     */
    const sign = maneuver.destination ? `${maneuver.destination}方面、` : '';
    const street = maneuver.streetName ? `${maneuver.streetName}方向、` : '';
    return `${distanceText}先、${sign}${street}${label}です。`;
  }
}
