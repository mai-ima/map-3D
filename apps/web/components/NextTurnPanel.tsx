'use client';

import type { NavigationTickResult } from '@ijm/navigation';
import { formatDistance, formatDuration, maneuverIcon, maneuverLabel } from '@ijm/navigation';
import { Icon } from '@ijm/ui';

export interface NextTurnPanelProps {
  tick: NavigationTickResult | null;
  onStop: () => void;
  onResumeFollow: () => void;
}

const STATE_LABELS: Record<string, string> = {
  FOLLOW: '追従',
  APPROACH_TURN: '交差点接近',
  TURN: '旋回中',
  INTERSECTION: '交差点',
  ARRIVAL: '到着',
  FREE_LOOK: '自由視点',
};

/**
 * 画面上部の案内パネル（Immersive Navigation の主表示）。
 * 「次に何をするか」だけを大きく出し、残りは補助情報として小さく置く。
 */
export default function NextTurnPanel({ tick, onStop, onResumeFollow }: NextTurnPanelProps) {
  if (!tick) return null;

  const { outlook, progress, camera } = tick;
  const next = outlook.next;
  const arrived = progress.arrived;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 safe-top">
      <div className="glass pointer-events-auto w-full max-w-[560px] rounded-[18px] px-4 py-3">
        <div className="flex items-center gap-4">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${
              arrived ? 'bg-signal-500/20 text-signal-400' : 'bg-turn-500/20 text-turn-400'
            } ${camera.state === 'APPROACH_TURN' ? 'animate-pulse-soft' : ''}`}
          >
            <Icon
              name={arrived ? 'destination' : maneuverIcon(next)}
              size={32}
              strokeWidth={1.9}
              title={arrived ? '目的地' : maneuverLabel(next)}
            />
          </div>

          <div className="min-w-0 flex-1">
            {arrived ? (
              <>
                <p className="text-[19px] font-semibold tracking-tight">目的地に到着しました</p>
                <p className="truncate text-[13px] text-mist-500">お疲れさまでした</p>
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-[26px] font-semibold leading-none tabular-nums text-turn-400">
                    {formatDistance(outlook.distanceToNext)}
                  </span>
                  <span className="text-[17px] font-semibold leading-none">
                    {maneuverLabel(next)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[13px] text-mist-300">
                  {outlook.nextStreetName ?? next?.instruction ?? '直進します'}
                </p>
              </>
            )}
          </div>

          <button
            onClick={onStop}
            className="shrink-0 rounded-full border border-white/12 px-3 py-1.5 text-[12px] text-mist-300 transition-colors hover:border-alert-400/50 hover:text-alert-400"
          >
            終了
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-white/8 pt-2.5 text-[12px] text-mist-500">
          <span className="tabular-nums">残り {formatDistance(progress.remainingDistance)}</span>
          <span className="tabular-nums">約 {formatDuration(progress.remainingDuration)}</span>
          <span className="tabular-nums">{(progress.speed * 3.6).toFixed(0)} km/h</span>
          <span className="ml-auto flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                camera.state === 'FREE_LOOK'
                  ? 'bg-alert-400/15 text-alert-400'
                  : 'bg-white/6 text-mist-500'
              }`}
            >
              {STATE_LABELS[camera.state] ?? camera.state}
            </span>
            {camera.state === 'FREE_LOOK' && (
              <button
                onClick={onResumeFollow}
                className="rounded-full bg-signal-500/20 px-2 py-0.5 text-[11px] font-medium text-signal-400"
              >
                追従に戻る
              </button>
            )}
          </span>
        </div>

        {outlook.afterNext && !arrived && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-mist-500">
            <span className="opacity-70">その先</span>
            <Icon name={maneuverIcon(outlook.afterNext)} size={15} />
            <span>{maneuverLabel(outlook.afterNext)}</span>
            <span className="tabular-nums opacity-70">
              {formatDistance(outlook.distanceToAfterNext)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
