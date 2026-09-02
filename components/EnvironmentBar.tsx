'use client';

import { useState } from 'react';
import type { City, District, IconName } from '@ijm/shared';
import { CITIES } from '@ijm/shared';
import { Icon } from '@ijm/ui';

export interface EnvironmentBarProps {
  city: City;
  hour: number;
  weather: string;
  imageryId: string;
  imagery: { id: string; label: string }[];
  qualityLabel: string;
  /** 'auto' なら端末に応じて自動判定する */
  qualityChoice: string;
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
  structuresEnabled: boolean;
  structuresLoading: boolean;
  onToggleStructures: () => void;
  roadsEnabled: boolean;
  roadsLoading: boolean;
  onToggleRoads: () => void;
  onQualityChange: (choice: string) => void;
  /** PLATEAU の追加レイヤ（LOD3 詳細・橋梁・都市設備・植生） */
  optionalLayers: string[];
  onToggleLayer: (id: string) => void;
}

/**
 * 建物のベース（LOD2）に重ねられる PLATEAU の追加レイヤ。
 *
 * LOD3（開口部）・LOD4（室内）は整備済みの区が限られており、
 * 未整備の範囲では重ねられない。その場合は選んでも変化しない旨を UI に出す。
 */
const OPTIONAL_LAYERS: { id: string; label: string; note: string }[] = [
  { id: 'detail', label: '詳細モデル（LOD3）', note: '窓・扉などの開口部。整備済みの区のみ' },
  { id: 'bridge', label: '橋梁', note: '' },
  { id: 'furniture', label: '都市設備', note: '' },
  { id: 'vegetation', label: '植生', note: '' },
];

/**
 * 描画品質の手動切り替え。
 *
 * 端末の判定とメモリ監視で自動調整はするが、GPU の実力は取得できる情報だけでは
 * 分からない。動作が重い・落ちるという場合に、利用者が自分で下げられるようにしておく。
 */
const QUALITY_CHOICES: { id: string; label: string }[] = [
  { id: 'auto', label: '自動' },
  { id: 'high', label: '高品質' },
  { id: 'balanced', label: 'バランス' },
  { id: 'low', label: '軽量' },
];

const TIME_PRESETS = [6, 9, 12, 17, 19, 22];
const WEATHERS: { kind: string; label: string; iconName: IconName }[] = [
  { kind: 'clear', label: '晴れ', iconName: 'sun' },
  { kind: 'cloudy', label: '曇り', iconName: 'cloud' },
  { kind: 'rain', label: '雨', iconName: 'rain' },
  { kind: 'snow', label: '雪', iconName: 'snow' },
  { kind: 'fog', label: '霧', iconName: 'fog' },
];
const POI_CATEGORIES: { id: string; label: string; iconName: IconName }[] = [
  { id: 'convenience', label: 'コンビニ', iconName: 'store' },
  { id: 'cafe', label: 'カフェ', iconName: 'cafe' },
  { id: 'restaurant', label: '飲食', iconName: 'restaurant' },
  { id: 'station', label: '駅', iconName: 'transit' },
  { id: 'park', label: '公園', iconName: 'park' },
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
        <span className="text-mist-300">
          <Icon name={WEATHERS.find((w) => w.kind === props.weather)?.iconName ?? 'sun'} size={15} />
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-mist-500">
          表示設定
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
        </span>
      </button>

      {/*
        小さい画面では設定項目が縦に長くなり、画面下の操作ボタンと重なる。
        パネル自体をスクロールさせ、下端にボタン 1 個ぶんの余白を確保する。
        高さは 100dvh 基準（iOS の Safari はツールバーの分だけ vh がずれる）。
      */}
      {open && (
        <div className="max-h-[calc(100dvh-13rem)] space-y-3.5 overflow-y-auto overscroll-contain border-t border-white/8 px-3.5 pt-3 pb-16">
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
                  iconName={w.iconName}
                >
                  {w.label}
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
                  iconName={c.iconName}
                >
                  {c.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="街路樹・街灯（OSM の実在位置）">
            <Chip active={props.furnitureEnabled} onClick={props.onToggleFurniture}>
              {props.furnitureEnabled ? '表示中' : '表示する'}
            </Chip>
          </Section>

          <Section title="車道・車線・信号・線路（OSM の実在位置）">
            <Chip active={props.roadsEnabled} onClick={props.onToggleRoads}>
              {props.roadsLoading ? '読み込み中…' : props.roadsEnabled ? '表示中' : '表示する'}
            </Chip>
            <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
              舗装・区画線・中央線・横断歩道・信号機・線路を地表に描きます。
              車線数や速度制限は OSM に入っている値だけを使い、推測はしません。
            </p>
          </Section>

          <Section title="高架・橋（OSM の実在位置）">
            <Chip active={props.structuresEnabled} onClick={props.onToggleStructures}>
              {props.structuresLoading
                ? '読み込み中…'
                : props.structuresEnabled
                  ? '表示中'
                  : '表示する'}
            </Chip>
            <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
              PLATEAU に橋梁モデルが無い地域でも、OSM の橋・高架から桁と橋脚を組み立てて表示します。
            </p>
          </Section>

          <Section title="PLATEAU の追加レイヤ">
            <div className="flex flex-wrap gap-1.5">
              {OPTIONAL_LAYERS.map((l) => (
                <Chip
                  key={l.id}
                  active={props.optionalLayers.includes(l.id)}
                  onClick={() => props.onToggleLayer(l.id)}
                >
                  {l.label}
                </Chip>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
              LOD3 は窓や扉の開口部まで再現したモデル。国土交通省 PLATEAU の整備範囲に
              限られるため、未整備の地域では表示が変わりません。
            </p>
          </Section>

          <Section title="描画品質">
            <div className="flex flex-wrap gap-1.5">
              {QUALITY_CHOICES.map((q) => (
                <Chip
                  key={q.id}
                  active={props.qualityChoice === q.id}
                  onClick={() => props.onQualityChange(q.id)}
                >
                  {q.label}
                </Chip>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-mist-500">
              現在: {props.qualityLabel}
              {props.qualityChoice === 'auto' && '（端末に応じて自動調整）'}
            </p>
          </Section>
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
  iconName,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  iconName?: IconName;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? 'border-signal-400/60 bg-signal-500/15 text-signal-400'
          : 'border-white/10 text-mist-300 hover:border-white/25'
      }`}
    >
      {iconName && <Icon name={iconName} size={14} />}
      {children}
    </button>
  );
}
