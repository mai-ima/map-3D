'use client';

import { useState } from 'react';
import type { City, District } from '@ijm/shared';
import { CITIES } from '@ijm/shared';

export interface EnvironmentBarProps {
  city: City;
  hour: number;
  weather: string;
  imageryId: string;
  imagery: { id: string; label: string }[];
  qualityLabel: string;
  followRealTime: boolean;
  poiCategories: string[];
  furnitureEnabled: boolean;
  onCityChange: (city: City) => void;
  onDistrict: (district: District) => void;
  onHourChange: (hour: number) => void;
  onFollowRealTime: (follow: boolean) => void;
  onWeatherChange: (weather: string) => void;
  onImageryChange: (id: string) => void;
  onTogglePoi: (category: string) => void;
  onToggleFurniture: () => void;
}

const TIME_PRESETS = [6, 9, 12, 17, 19, 22];
const WEATHERS = [
  { kind: 'clear', label: '晴れ', icon: '☀️' },
  { kind: 'cloudy', label: '曇り', icon: '☁️' },
  { kind: 'rain', label: '雨', icon: '🌧️' },
  { kind: 'snow', label: '雪', icon: '🌨️' },
  { kind: 'fog', label: '霧', icon: '🌫️' },
];
const POI_CATEGORIES = [
  { id: 'convenience', label: 'コンビニ', icon: '🏪' },
  { id: 'cafe', label: 'カフェ', icon: '☕' },
  { id: 'restaurant', label: '飲食', icon: '🍜' },
  { id: 'station', label: '駅', icon: '🚉' },
  { id: 'park', label: '公園', icon: '🌳' },
];

/**
 * 環境コントロール。
 * 3D の見た目（時刻・天候・地図種別）と、表示するデータを切り替える。
 */
export default function EnvironmentBar(props: EnvironmentBarProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass rounded-[18px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="text-[13px] font-semibold">{props.city.name}</span>
        <span className="text-[12px] tabular-nums text-mist-500">
          {String(Math.floor(props.hour)).padStart(2, '0')}:00
        </span>
        <span className="text-[12px]">
          {WEATHERS.find((w) => w.kind === props.weather)?.icon ?? '☀️'}
        </span>
        <span className="ml-auto text-[11px] text-mist-500">{open ? '閉じる' : '表示設定'}</span>
      </button>

      {open && (
        <div className="space-y-3.5 border-t border-white/8 px-3.5 py-3">
          <Section title="都市">
            <div className="flex flex-wrap gap-1.5">
              {CITIES.map((c) => (
                <Chip
                  key={c.id}
                  active={c.id === props.city.id}
                  onClick={() => props.onCityChange(c)}
                >
                  {c.name}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="エリア">
            <div className="flex flex-wrap gap-1.5">
              {props.city.districts.map((d) => (
                <Chip key={d.id} onClick={() => props.onDistrict(d)}>
                  {d.name}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="時間帯">
            <div className="flex flex-wrap items-center gap-1.5">
              {TIME_PRESETS.map((h) => (
                <Chip
                  key={h}
                  active={!props.followRealTime && Math.floor(props.hour) === h}
                  onClick={() => props.onHourChange(h)}
                >
                  {String(h).padStart(2, '0')}:00
                </Chip>
              ))}
              <Chip
                active={props.followRealTime}
                onClick={() => props.onFollowRealTime(!props.followRealTime)}
              >
                現在時刻
              </Chip>
            </div>
            <input
              type="range"
              min={0}
              max={23.5}
              step={0.5}
              value={props.hour}
              onChange={(e) => props.onHourChange(Number(e.target.value))}
              className="mt-2 w-full accent-[color:var(--color-turn-400)]"
              aria-label="時刻"
            />
          </Section>

          <Section title="天候">
            <div className="flex flex-wrap gap-1.5">
              {WEATHERS.map((w) => (
                <Chip
                  key={w.kind}
                  active={props.weather === w.kind}
                  onClick={() => props.onWeatherChange(w.kind)}
                >
                  {w.icon} {w.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="ベースマップ">
            <div className="flex flex-wrap gap-1.5">
              {props.imagery.map((i) => (
                <Chip
                  key={i.id}
                  active={props.imageryId === i.id}
                  onClick={() => props.onImageryChange(i.id)}
                >
                  {i.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="周辺の施設 (OSM)">
            <div className="flex flex-wrap gap-1.5">
              {POI_CATEGORIES.map((c) => (
                <Chip
                  key={c.id}
                  active={props.poiCategories.includes(c.id)}
                  onClick={() => props.onTogglePoi(c.id)}
                >
                  {c.icon} {c.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="街路樹・街灯（OSM の実在位置）">
            <Chip active={props.furnitureEnabled} onClick={props.onToggleFurniture}>
              {props.furnitureEnabled ? '表示中' : '表示する'}
            </Chip>
          </Section>

          <p className="text-[11px] text-mist-500">描画品質: {props.qualityLabel}</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist-500">
        {title}
      </p>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? 'border-signal-400/60 bg-signal-500/15 text-signal-400'
          : 'border-white/10 text-mist-300 hover:border-white/25'
      }`}
    >
      {children}
    </button>
  );
}
