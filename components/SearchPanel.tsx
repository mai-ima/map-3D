'use client';

import { useEffect, useRef, useState } from 'react';
import type { IconName, LatLng, Route, SearchResult, TravelMode } from '@ijm/shared';
import { formatDistance, formatDuration } from '@ijm/navigation';
import { Icon } from '@ijm/ui';
import { searchPlaces } from '@/lib/api';

export interface PlacePoint {
  name: string;
  position: LatLng;
}

export interface SearchPanelProps {
  origin: PlacePoint | null;
  destination: PlacePoint | null;
  mode: TravelMode;
  route: Route | null;
  routing: boolean;
  viewCenter: () => LatLng | null;
  onSelectOrigin: (place: PlacePoint | null) => void;
  onSelectDestination: (place: PlacePoint | null) => void;
  onModeChange: (mode: TravelMode) => void;
  onCalculateRoute: () => void;
  onStartNavigation: () => void;
  onFocusPlace: (place: PlacePoint) => void;
  onClearRoute: () => void;
}

const MODES: { value: TravelMode; label: string; iconName: IconName }[] = [
  { value: 'walk', label: '徒歩', iconName: 'walk' },
  { value: 'drive', label: '車', iconName: 'car' },
  { value: 'bicycle', label: '自転車', iconName: 'bike' },
];

export default function SearchPanel(props: SearchPanelProps) {
  const {
    origin,
    destination,
    mode,
    route,
    routing,
    viewCenter,
    onSelectOrigin,
    onSelectDestination,
    onModeChange,
    onCalculateRoute,
    onStartNavigation,
    onFocusPlace,
    onClearRoute,
  } = props;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    // Nominatim の利用ポリシー（1req/s）に配慮してデバウンスする
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const near = viewCenter() ?? undefined;
        const res = await searchPlaces(query.trim(), near);
        setResults(res.results);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 550);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, viewCenter]);

  const pick = (result: SearchResult, as: 'origin' | 'destination') => {
    const place: PlacePoint = { name: result.name, position: { lat: result.lat, lng: result.lng } };
    if (as === 'origin') onSelectOrigin(place);
    else onSelectDestination(place);
    onFocusPlace(place);
    setQuery('');
    setResults([]);
    setExpanded(true);
  };

  return (
    <div className="glass w-full rounded-[18px] p-3">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500">
          <Icon name="search" size={16} />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setExpanded(true)}
          placeholder="どこへ行きますか？（例: 東京駅、皇居、渋谷）"
          className="w-full rounded-full border border-white/10 bg-ink-800/70 py-2.5 pl-9 pr-9 text-[14px] text-mist-100 outline-none placeholder:text-mist-500 focus:border-signal-400/50"
          inputMode="search"
          enterKeyHint="search"
        />
        {searching && (
          <span className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-white/20 border-t-signal-400" />
        )}
      </div>

      {error && <p className="mt-2 px-1 text-[12px] text-alert-400">{error}</p>}

      {results.length > 0 && (
        <ul className="mt-2 max-h-[38vh] overflow-y-auto rounded-xl border border-white/8 bg-ink-800/60">
          {results.map((r) => (
            <li key={r.id} className="border-b border-white/5 last:border-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => pick(r, 'destination')}
                >
                  <p className="truncate text-[14px] font-medium">{r.name}</p>
                  <p className="truncate text-[11px] text-mist-500">{r.address}</p>
                </button>
                <button
                  onClick={() => pick(r, 'origin')}
                  className="shrink-0 rounded-full border border-white/12 px-2 py-1 text-[11px] text-mist-300 hover:border-signal-400/50 hover:text-signal-400"
                >
                  出発地に
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(expanded || origin || destination || route) && (
        <div className="mt-3 space-y-2.5">
          <div className="space-y-1.5">
            <PlaceRow
              iconName="origin"
              iconClass="text-signal-400"
              label="出発地"
              place={origin}
              placeholder="未設定（画面中心を使用）"
              onClear={() => onSelectOrigin(null)}
              onFocus={onFocusPlace}
            />
            <PlaceRow
              iconName="destination"
              iconClass="text-alert-400"
              label="目的地"
              place={destination}
              placeholder="検索して選択してください"
              onClear={() => onSelectDestination(null)}
              onFocus={onFocusPlace}
            />
          </div>

          <div className="flex items-center gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => onModeChange(m.value)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full border px-2 py-1.5 text-[12px] transition-colors ${
                  mode === m.value
                    ? 'border-signal-400/60 bg-signal-500/15 text-signal-400'
                    : 'border-white/10 text-mist-300 hover:border-white/25'
                }`}
              >
                <Icon name={m.iconName} size={16} />
                {m.label}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={onCalculateRoute}
              disabled={!destination || routing}
              className="flex-1 rounded-full bg-signal-500 py-2 text-[13px] font-semibold text-ink-950 transition-colors hover:bg-signal-400 disabled:pointer-events-none disabled:opacity-40"
            >
              {routing ? '経路を計算中…' : 'ルート検索'}
            </button>
            {route && (
              <button
                onClick={onClearRoute}
                className="rounded-full border border-white/12 px-3 text-[12px] text-mist-300 hover:border-white/25"
              >
                消去
              </button>
            )}
          </div>

          {route && (
            <div className="rounded-xl border border-white/8 bg-ink-800/60 p-3">
              <div className="flex items-baseline gap-3">
                <span className="text-[22px] font-semibold tabular-nums text-signal-400">
                  {formatDistance(route.distance)}
                </span>
                <span className="text-[14px] tabular-nums text-mist-300">
                  約 {formatDuration(route.duration)}
                </span>
                <span className="ml-auto text-[11px] text-mist-500">{route.engine}</span>
              </div>

              <button
                onClick={onStartNavigation}
                className="mt-2.5 w-full rounded-full bg-turn-500 py-2 text-[13px] font-semibold text-ink-950 transition-colors hover:bg-turn-400"
              >
                3D ナビゲーションを開始
              </button>

              <ol className="mt-2.5 max-h-[26vh] space-y-1 overflow-y-auto">
                {route.maneuvers.slice(0, 40).map((m, i) => (
                  <li key={i} className="flex gap-2 rounded-lg px-1.5 py-1 text-[12px]">
                    <span className="w-14 shrink-0 tabular-nums text-mist-500">
                      {formatDistance(m.distanceToNext)}
                    </span>
                    <span className="min-w-0 flex-1 text-mist-300">
                      {m.instruction || m.streetName || '直進'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlaceRow({
  iconName,
  iconClass,
  label,
  place,
  placeholder,
  onClear,
  onFocus,
}: {
  iconName: IconName;
  iconClass: string;
  label: string;
  place: PlacePoint | null;
  placeholder: string;
  onClear: () => void;
  onFocus: (place: PlacePoint) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-ink-800/50 px-3 py-2">
      <span className={iconClass}>
        <Icon name={iconName} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-[0.14em] text-mist-500">{label}</p>
        {place ? (
          <button className="block max-w-full truncate text-left text-[13px]" onClick={() => onFocus(place)}>
            {place.name}
          </button>
        ) : (
          <p className="truncate text-[13px] text-mist-500">{placeholder}</p>
        )}
      </div>
      {place && (
        <button
          onClick={onClear}
          aria-label={`${label}を消去`}
          className="shrink-0 text-mist-500 transition-colors hover:text-alert-400"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
