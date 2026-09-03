/**
 * 車線案内。
 *
 * 市販カーナビと Yahoo! カーナビにある「どの車線に寄るか」の表示。
 * 交差点の手前で寄る車線が分かるかどうかは、運転中にいちばん効く情報になる。
 *
 * **出典は OSM の `turn:lanes`**（例: `left|through|through;right`）で、
 * 経路エンジンがそれを解釈して車線ごとの矢印として返してくる。
 * 返ってこない交差点では **何も出さない**。
 * 車線数から矢印を組み立てると、実在しない案内で車線を寄らせることになる。
 *
 * 描画エンジンに依存しない。判定と文言だけを持つ。
 */

import type { Lane, LaneIndication } from '@ijm/shared';

/** 車線案内を出し始める残距離 (m) */
const LANE_GUIDE_DISTANCE_M = 500;

/**
 * いま車線案内を出すべきか。
 *
 * 遠すぎるうちから出すと、別の交差点の案内だと思われる。
 * 市販カーナビはおおむね 300〜700m 手前から出すので、その中ほどを採る。
 */
export function shouldShowLanes(lanes: Lane[] | undefined, distanceM: number): boolean {
  if (!lanes || lanes.length === 0) return false;
  if (!Number.isFinite(distanceM)) return false;
  return distanceM <= LANE_GUIDE_DISTANCE_M;
}

/** 矢印 1 本の読み上げ・読み上げ補助テキスト */
const INDICATION_LABELS: Record<LaneIndication, string> = {
  left: '左折',
  slight_left: '斜め左',
  sharp_left: '鋭角に左',
  through: '直進',
  right: '右折',
  slight_right: '斜め右',
  sharp_right: '鋭角に右',
  uturn: 'Uターン',
  merge_left: '左へ合流',
  merge_right: '右へ合流',
  none: '指定なし',
};

export function laneIndicationLabel(indication: LaneIndication): string {
  return INDICATION_LABELS[indication] ?? '指定なし';
}

/** 車線 1 本の説明（読み上げソフト向け） */
export function laneLabel(lane: Lane, index: number, total: number): string {
  const arrows = lane.indications.map(laneIndicationLabel).join('・');
  const position = `左から ${index + 1} 番目（全 ${total} 車線）`;
  return `${position}: ${arrows || '指定なし'}${lane.valid ? '、この車線を通ります' : ''}`;
}

/**
 * 通ってよい車線の位置（左から 0 始まり）。
 *
 * 連続していないこともある（左端の左折専用と、右端の右折専用が
 * どちらも有効になる交差点は無いが、直進可の車線が飛び飛びになることはある）。
 */
export function validLaneIndexes(lanes: Lane[]): number[] {
  const out: number[] = [];
  lanes.forEach((lane, i) => {
    if (lane.valid) out.push(i);
  });
  return out;
}

/**
 * 車線案内の短い文言。
 *
 * 音声で読み上げる用。「左から 2 番目の車線です」のように、
 * 数えられる形にする。「中央の車線」のような曖昧な言い方はしない。
 *
 * @returns 出すものが無ければ null（黙る。作り話をしない）
 */
export function laneAdvice(lanes: Lane[] | undefined): string | null {
  if (!lanes || lanes.length === 0) return null;
  const valid = validLaneIndexes(lanes);
  if (valid.length === 0 || valid.length === lanes.length) return null;

  const total = lanes.length;
  // 連続しているか（「左から 2〜3 番目」とまとめられるか）
  const contiguous = valid.every((v, i) => i === 0 || v === valid[i - 1] + 1);

  if (valid.length === 1) {
    const at = valid[0];
    if (at === 0) return `左端の車線に寄ってください。全 ${total} 車線です。`;
    if (at === total - 1) return `右端の車線に寄ってください。全 ${total} 車線です。`;
    return `左から ${at + 1} 番目の車線に寄ってください。全 ${total} 車線です。`;
  }

  if (contiguous) {
    return `左から ${valid[0] + 1} 番目から ${valid[valid.length - 1] + 1} 番目の車線を通ります。全 ${total} 車線です。`;
  }
  return `左から ${valid.map((v) => v + 1).join('・')} 番目の車線を通ります。全 ${total} 車線です。`;
}
