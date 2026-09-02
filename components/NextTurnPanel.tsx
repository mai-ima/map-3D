'use client';

import type { NavigationTickResult } from '@ijm/navigation';
import {
  formatDistance,
  formatDuration,
  formatEta,
  maneuverIcon,
  maneuverLabel,
} from '@ijm/navigation';
import { Icon } from '@ijm/ui';

export interface NextTurnPanelProps {
  tick: NavigationTickResult | null;
  /** 経路を外れて再検索している最中か */
  rerouting?: boolean;
  voiceEnabled?: boolean;
  /**
   * いま走っている道の制限速度 (km/h)。
   * OSM に maxspeed が入っている道の上にいるときだけ渡される。
   * 分からないときは null。種別からの推測はしない
   */
  speedLimit?: number | null;
  onToggleVoice?: () => void;
  onStop: () => void;
  onResumeFollow: () => void;
}

/**
 * 最高速度の規制標識。
 *
 * 日本の規制標識（301 最高速度）に合わせて、
 * 白地・赤の環・黒の数字で描く。
 * 赤は道路標識の「赤」（マンセル 7.5R 4/15）に近い色を使う。
 */
function SpeedLimitSign({ value }: { value: number }) {
  return (
    <span
      className="inline-flex items-center"
      role="img"
      aria-label={`最高速度 ${value} キロメートル毎時`}
      title={`最高速度 ${value} km/h（OSM の maxspeed）`}
    >
      <svg width="30" height="30" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="19" fill="#ffffff" />
        <circle cx="20" cy="20" r="16" fill="none" stroke="#c8161e" strokeWidth="5.5" />
        <text
          x="20"
          y="20"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={value >= 100 ? 15 : 19}
          fontWeight="700"
          fill="#16181a"
          fontFamily="system-ui, sans-serif"
        >
          {value}
        </text>
      </svg>
    </span>
  );
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
export default function NextTurnPanel({
  tick,
  rerouting,
  voiceEnabled = true,
  speedLimit = null,
  onToggleVoice,
  onStop,
  onResumeFollow,
}: NextTurnPanelProps) {
  if (!tick) return null;

  const { outlook, progress, camera } = tick;
  const next = outlook.next;
  const arrived = progress.arrived;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 safe-top">
      <div className="glass pointer-events-auto w-full max-w-[560px] rounded-[18px] px-4 py-3">
        {rerouting && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-turn-500/12 px-2.5 py-1.5 text-[12px] text-turn-400">
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-turn-400/30 border-t-turn-400" />
            経路を再検索しています
          </div>
        )}

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

          <div className="flex shrink-0 items-center gap-1.5">
            {onToggleVoice && (
              <button
                onClick={onToggleVoice}
                aria-pressed={voiceEnabled}
                aria-label={voiceEnabled ? '音声案内を切る' : '音声案内を入れる'}
                className={`tap-target inline-flex items-center justify-center rounded-full border px-2.5 transition-colors ${
                  voiceEnabled
                    ? 'border-white/12 text-mist-200'
                    : 'border-white/8 text-mist-600'
                }`}
              >
                <Icon name={voiceEnabled ? 'volumeOn' : 'volumeOff'} size={17} />
              </button>
            )}
            <button
              onClick={onStop}
              className="tap-target shrink-0 rounded-full border border-white/12 px-3 text-[12px] text-mist-300 transition-colors hover:border-alert-400/50 hover:text-alert-400"
            >
              終了
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-white/8 pt-2.5 text-[12px] text-mist-500">
          {/* 到着予想時刻。約束の時間に間に合うかを判断できるよう、残り時間より先に出す */}
          <span className="tabular-nums font-medium text-mist-200">
            {formatEta(progress.remainingDuration)} 着
          </span>
          <span className="tabular-nums">残り {formatDistance(progress.remainingDistance)}</span>
          <span className="tabular-nums">{formatDuration(progress.remainingDuration)}</span>
          {/* 現在速度。制限を超えていたら色で知らせる（超過分は出さない） */}
          <span
            className={`tabular-nums ${
              speedLimit !== null && progress.speed * 3.6 > speedLimit + 1
                ? 'font-semibold text-alert-400'
                : ''
            }`}
          >
            {(progress.speed * 3.6).toFixed(0)} km/h
          </span>
          {speedLimit !== null && <SpeedLimitSign value={speedLimit} />}
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
