'use client';

import type { Lane, LaneIndication } from '@ijm/shared';
import { laneLabel } from '@ijm/navigation';

/**
 * 車線案内。
 *
 * 市販カーナビと Yahoo! カーナビにある「どの車線に寄るか」の表示。
 * 交差点の手前で寄る車線が分かるかどうかは、運転中にいちばん効く。
 *
 * **出典は OSM の `turn:lanes`** で、経路エンジンが解釈して返してくる。
 * 返ってこない交差点では、この部品ごと出さない（呼び出し側で判定する）。
 * 車線数から矢印を組み立てると、実在しない案内で車線を寄らせることになる。
 *
 * 矢印は SVG で描く。1 本の車線に複数の矢印が描かれることがある
 * （`through;right` は直進と右折の両方）ので、重ねて描く。
 */

/** 車線 1 本の枠（viewBox の座標） */
const W = 26;
const H = 34;
/** 矢印の根元。車線の下端から立ち上がる */
const STEM_X = W / 2;
const STEM_BOTTOM = H - 3;

/**
 * 矢印の形。
 *
 * 実際の路面標示（道路標識、区画線及び道路標示に関する命令 別表第 6 の
 * 「進行方向別通行区分」）に合わせて、根元から立ち上がって
 * 先端で曲がる形にする。カーナビの表示もこれに倣っている。
 *
 * @param dx 先端の横方向。-1 が左端、+1 が右端
 * @param headY 先端の高さ
 */
function arrowPath(dx: number, headY: number): string {
  const tipX = STEM_X + dx * (W / 2 - 4);
  if (dx === 0) {
    // 直進。まっすぐ上へ
    return `M${STEM_X} ${STEM_BOTTOM} L${STEM_X} ${headY}`;
  }
  // 途中まで立ち上げてから曲げる（路面標示と同じ）
  const bendY = headY + 7;
  return `M${STEM_X} ${STEM_BOTTOM} L${STEM_X} ${bendY} Q${STEM_X} ${headY} ${tipX} ${headY}`;
}

/** 矢じり。進む向きに合わせて三角を置く */
function headPath(dx: number, headY: number): string {
  const tipX = STEM_X + dx * (W / 2 - 4);
  if (dx === 0) {
    return `M${STEM_X - 4} ${headY + 4.5} L${STEM_X} ${headY - 2.5} L${STEM_X + 4} ${headY + 4.5} Z`;
  }
  const s = Math.sign(dx);
  return `M${tipX - s * 4.5} ${headY - 4} L${tipX + s * 2.5} ${headY} L${tipX - s * 4.5} ${headY + 4} Z`;
}

/** U ターンだけは形が違うので専用に描く */
const UTURN_PATH = `M${STEM_X + 4} ${STEM_BOTTOM} L${STEM_X + 4} ${H / 2} Q${STEM_X + 4} 7 ${STEM_X - 4} 7 Q${STEM_X - 4} 7 ${STEM_X - 4} 13`;
const UTURN_HEAD = `M${STEM_X - 8} 12 L${STEM_X - 4} 18 L${STEM_X} 12 Z`;

/** 矢印 1 本ぶんの線と矢じり */
function Arrow({ indication }: { indication: LaneIndication }) {
  if (indication === 'none') {
    // 矢印の指定が無い車線。線だけ引いて「車線はあるが指定は無い」と示す
    return <path d={arrowPath(0, 12)} fill="none" strokeLinecap="round" opacity={0.45} />;
  }
  if (indication === 'uturn') {
    return (
      <>
        <path d={UTURN_PATH} fill="none" strokeLinecap="round" />
        <path d={UTURN_HEAD} stroke="none" fill="currentColor" />
      </>
    );
  }

  // 曲がりの強さで先端の位置と高さを変える。
  // 鋭角ほど横に大きく、浅いほど上に伸びる
  const shape: Record<string, [dx: number, headY: number]> = {
    left: [-1, 10],
    right: [1, 10],
    slight_left: [-0.55, 7],
    slight_right: [0.55, 7],
    sharp_left: [-1, 17],
    sharp_right: [1, 17],
    merge_left: [-0.7, 9],
    merge_right: [0.7, 9],
    through: [0, 8],
  };
  const [dx, headY] = shape[indication] ?? [0, 8];

  return (
    <>
      <path d={arrowPath(dx, headY)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={headPath(dx, headY)} stroke="none" fill="currentColor" />
    </>
  );
}

export interface LaneGuideProps {
  lanes: Lane[];
}

/**
 * 左の車線から順に並べる。
 *
 * 通れる車線は明るく、通れない車線は沈める。
 * 「通れない車線を消す」のではなく暗く残すのは、
 * 実際の車線数が分かるようにするため（何本目に寄るかを数えられる）。
 */
export default function LaneGuide({ lanes }: LaneGuideProps) {
  if (lanes.length === 0) return null;

  return (
    <div
      className="mt-2 flex items-end justify-center gap-1 border-t border-white/8 pt-2"
      role="group"
      aria-label={`車線案内 全 ${lanes.length} 車線`}
    >
      {lanes.map((lane, i) => (
        <div
          key={i}
          title={laneLabel(lane, i, lanes.length)}
          aria-label={laneLabel(lane, i, lanes.length)}
          className={`flex h-[34px] w-[26px] items-end justify-center rounded-[5px] ${
            lane.valid ? 'bg-turn-500/18 text-turn-400' : 'bg-white/4 text-mist-600'
          }`}
        >
          <svg
            width={26}
            height={34}
            viewBox={`0 0 ${W} ${H}`}
            aria-hidden="true"
            stroke="currentColor"
            strokeWidth={lane.valid ? 2.4 : 1.8}
          >
            {(lane.indications.length > 0 ? lane.indications : (['none'] as LaneIndication[])).map(
              (indication, k) => (
                <Arrow key={k} indication={indication} />
              ),
            )}
          </svg>
        </div>
      ))}
    </div>
  );
}
