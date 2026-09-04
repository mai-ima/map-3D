'use client';

import type { LatLng, Route } from '@ijm/shared';
import {
  formatDistance,
  formatEta,
  maneuverIcon,
  maneuverLabel,
  maneuverOffsets,
} from '@ijm/navigation';
import { Icon } from '@ijm/ui';

/**
 * 案内一覧（ターンリスト）。
 *
 * 市販カーナビにある「経路の全案内を順に並べたもの」。
 * 出発前に道筋を確かめたり、走行中に先の分岐を見たりするのに使う。
 *
 * 出しているのは経路エンジンが返した値だけで、こちらで足したものは無い。
 *
 *   出発からの距離   … 各案内の距離を積み上げたもの
 *   到着予想時刻     … 各案内の所要時間を積み上げて現在時刻に足したもの
 *   方面・路線番号   … OSM の destination / ref（無ければ出さない）
 *
 * 行を押すと、その地点へ地図が飛ぶ。
 */

/** 一度に並べる上限。長距離では案内が数百件になる */
const MAX_ROWS = 120;

export interface TurnListProps {
  route: Route;
  /** 行を押したときの移動先 */
  onFocus?: (place: { name: string; position: LatLng }) => void;
  /** 一覧の高さ（Tailwind のクラス）。画面によって変えたいので外から渡す */
  className?: string;
}

export default function TurnList({ route, onFocus, className }: TurnListProps) {
  const rows = route.maneuvers.slice(0, MAX_ROWS);
  const hidden = route.maneuvers.length - rows.length;
  // 出発からの距離と時間。積み上げ方は navigation 側に置いてある（測れるように）
  const offsets = maneuverOffsets(route.maneuvers);

  return (
    <div className={className}>
      <ol className="space-y-0.5">
        {rows.map((m, i) => {
          const { distanceM, seconds } = offsets[i];
          const label = maneuverLabel(m);
          const detail = m.streetName ?? m.instruction;
          const place = {
            name: detail || label || '経路上の地点',
            position: m.location,
          };

          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => onFocus?.(place)}
                disabled={!onFocus}
                className={`flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] ${
                  onFocus ? 'transition-colors hover:bg-white/6' : ''
                }`}
              >
                <span className="mt-px w-14 shrink-0 tabular-nums text-mist-500">
                  {formatDistance(distanceM)}
                </span>
                <span className="mt-px shrink-0 text-turn-400">
                  <Icon name={maneuverIcon(m)} size={15} title={label} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-mist-200">{label}</span>
                  {detail && <span className="block truncate text-mist-500">{detail}</span>}
                  {(m.routeRef || m.destination || m.exitNumber) && (
                    <span className="mt-0.5 flex items-center gap-1.5">
                      {m.exitNumber && (
                        <span className="shrink-0 rounded-[3px] bg-signal-500/25 px-1 text-[10px] font-semibold tabular-nums text-signal-300">
                          出口 {m.exitNumber}
                        </span>
                      )}
                      {m.routeRef && (
                        <span className="shrink-0 rounded-[3px] border border-mist-500/50 px-1 text-[10px] font-semibold tabular-nums text-mist-300">
                          {m.routeRef}
                        </span>
                      )}
                      {m.exitName && (
                        <span className="shrink-0 truncate text-[11px] text-mist-300">
                          {m.exitName}
                        </span>
                      )}
                      {m.destination && (
                        <span className="truncate text-[11px] text-mist-400">
                          {m.destination}方面
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {/*
                  通過予想時刻。「いま出発したら」を起点にしている。
                  約束の時間に間に合うかを、途中の地点でも見られるように
                */}
                <span className="mt-px shrink-0 tabular-nums text-[11px] text-mist-600">
                  {formatEta(seconds)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hidden > 0 && (
        <p className="px-1.5 pt-1 text-[11px] text-mist-600">ほか {hidden} 件の案内があります</p>
      )}
    </div>
  );
}
