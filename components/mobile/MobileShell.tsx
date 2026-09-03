'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BuildingModelMode,
  City,
  DataSource,
  District,
  IconName,
  LatLng,
  Route,
  SearchResult,
  TravelMode,
} from '@ijm/shared';
import { BUILDING_MODEL_MODES, CITIES, availableBuildingModes } from '@ijm/shared';
import { formatDistance, formatDuration } from '@ijm/navigation';
import { Icon } from '@ijm/ui';
import { searchPlaces } from '@/lib/api';
import type { PlacePoint } from '@/components/SearchPanel';
import BottomSheet from './BottomSheet';
import { Chip, ChipRow, FloatingButton, ListGroup, ListRow, Segmented, SheetSection } from './controls';

/**
 * iPhone 向けのレイアウト。
 *
 * デスクトップは「地図の上にパネルが浮かぶ」形だが、片手で持つ端末では
 * 画面上部に手が届かない。そこで iOS の地図アプリと同じく、
 * 操作系をすべて下から出るシートに集約している。
 *
 * 画面に出るものは 3 つだけ:
 *   - 全画面の地図
 *   - 右側に縦に並ぶ丸ボタン（親指の届く高さ）
 *   - 下から引き上げるシート（検索・経路・表示）
 */

export interface MobileShellProps {
  city: City;
  origin: PlacePoint | null;
  destination: PlacePoint | null;
  mode: TravelMode;
  route: Route | null;
  routing: boolean;
  navigating: boolean;
  hour: number;
  weather: string;
  imageryId: string;
  imagery: { id: string; label: string }[];
  qualityLabel: string;
  qualityChoice: string;
  optionalLayers: string[];
  buildingModel: BuildingModelMode;
  buildingModelBusy: boolean;
  poiCategories: string[];
  furnitureEnabled: boolean;
  structuresEnabled: boolean;
  structuresLoading: boolean;
  roadsEnabled: boolean;
  roadsLoading: boolean;
  followRealTime: boolean;
  attributions: DataSource[];
  aiEnabled: boolean;

  viewCenter: () => LatLng | null;
  onSelectOrigin: (place: PlacePoint | null) => void;
  onSelectDestination: (place: PlacePoint | null) => void;
  onModeChange: (mode: TravelMode) => void;
  onCalculateRoute: () => void;
  onStartNavigation: () => void;
  onFocusPlace: (place: PlacePoint) => void;
  onClearRoute: () => void;
  onCityChange: (city: City) => void;
  onDistrict: (district: District) => void;
  onHourChange: (hour: number) => void;
  onFollowRealTime: (follow: boolean) => void;
  onWeatherChange: (weather: string) => void;
  onImageryChange: (id: string) => void;
  onQualityChange: (choice: string) => void;
  onToggleLayer: (id: string) => void;
  onBuildingModelChange: (mode: BuildingModelMode) => void;
  onTogglePoi: (category: string) => void;
  onToggleFurniture: () => void;
  onToggleStructures: () => void;
  onToggleRoads: () => void;
  onOpenAI: () => void;
}

type Tab = 'search' | 'route' | 'view';

const TABS: { value: Tab; label: string; iconName: IconName }[] = [
  { value: 'search', label: '検索', iconName: 'search' },
  { value: 'route', label: '経路', iconName: 'straight' },
  { value: 'view', label: '表示', iconName: 'layers' },
];

const MODES: { value: TravelMode; label: string; iconName: IconName }[] = [
  { value: 'walk', label: '徒歩', iconName: 'walk' },
  { value: 'drive', label: '車', iconName: 'car' },
  { value: 'bicycle', label: '自転車', iconName: 'bike' },
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
const LAYERS: { id: string; label: string }[] = [
  { id: 'detail', label: '詳細モデル' },
  { id: 'bridge', label: '橋梁' },
  { id: 'furniture', label: '都市設備' },
  { id: 'vegetation', label: '植生' },
];
const QUALITY_CHOICES = [
  { id: 'auto', label: '自動' },
  { id: 'high', label: '高品質' },
  { id: 'balanced', label: 'バランス' },
  { id: 'low', label: '軽量' },
];

/**
 * シートのスナップ位置（画面高さに対する比率）。
 *
 * 一番低い位置でも、タブと検索欄までは見えているようにする。
 * iOS の地図アプリと同じく「畳んでいても次の操作が始められる」状態を保つため。
 * iPhone 17（874pt）ではおよそ 175pt になる。
 */
const DETENTS = [0.2, 0.52, 0.92];

export default function MobileShell(props: MobileShellProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickingOrigin, setPickingOrigin] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ナビ中はシートを畳んで地図に集中させる
  useEffect(() => {
    if (props.navigating) setSheetIndex(0);
  }, [props.navigating]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    // 通信の途中で入力が変わると、古い検索の結果が後から届いて
    // 新しい検索の結果を上書きすることがある
    let current = true;
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const near = props.viewCenter() ?? undefined;
        const res = await searchPlaces(q, near);
        if (current) setResults(res.results);
      } catch {
        if (current) setResults([]);
      } finally {
        if (current) setSearching(false);
      }
    }, 350);
    return () => {
      current = false;
      if (debounce.current) clearTimeout(debounce.current);
    };
    // viewCenter は毎回同じ関数を渡す前提
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const choose = useCallback(
    (r: SearchResult) => {
      const place: PlacePoint = { name: r.name, position: { lat: r.lat, lng: r.lng } };
      if (pickingOrigin) {
        props.onSelectOrigin(place);
        setPickingOrigin(false);
        setTab('route');
      } else {
        props.onSelectDestination(place);
        props.onFocusPlace(place);
        setTab('route');
      }
      setQuery('');
      setResults([]);
      setSheetIndex(1);
    },
    [pickingOrigin, props],
  );

  return (
    <>
      {/* 右側の丸ボタン。親指が届く高さに置く */}
      <div className="pointer-events-none absolute right-0 top-0 z-10 flex flex-col items-end gap-2 p-3 safe-top safe-x">
        <div className="pointer-events-auto flex flex-col gap-2">
          <FloatingButton
            iconName="sparkle"
            label="AI に頼む"
            onClick={props.onOpenAI}
            active={props.aiEnabled}
          />
          <FloatingButton
            iconName="origin"
            label="現在の街の中心に戻る"
            onClick={() => props.onDistrict(props.city.districts[0])}
          />
        </div>
      </div>

      <BottomSheet detents={DETENTS} index={sheetIndex} onIndexChange={setSheetIndex}>
        <div className="pb-2">
          <Segmented options={TABS} value={tab} onChange={setTab} />
        </div>

        {tab === 'search' && (
          <SheetSection>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500">
                <Icon name="search" size={16} />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSheetIndex(2)}
                enterKeyHint="search"
                placeholder={pickingOrigin ? '出発地を検索' : '目的地を検索'}
                className="w-full rounded-[12px] bg-white/8 py-3 pl-9 pr-9 text-[16px] text-mist-100 outline-none ring-1 ring-white/8 placeholder:text-mist-500 focus:ring-signal-400/50"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="入力を消す"
                  className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-mist-500 active:bg-white/10"
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </div>

            {searching && <p className="px-1 pt-3 text-[13px] text-mist-500">検索しています…</p>}

            {results.length > 0 && (
              <div className="pt-3">
                <ListGroup>
                  {results.map((r) => (
                    <ListRow
                      key={r.id}
                      iconName="pin"
                      title={r.name}
                      detail={r.address}
                      onClick={() => choose(r)}
                    />
                  ))}
                </ListGroup>
              </div>
            )}

            {!searching && results.length === 0 && query.trim().length >= 2 && (
              <p className="px-1 pt-3 text-[13px] text-mist-500">見つかりませんでした</p>
            )}

            {query.length === 0 && (
              <div className="pt-3">
                <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-mist-500">
                  {props.city.name}の主なエリア
                </p>
                <ListGroup>
                  {props.city.districts.map((d) => (
                    <ListRow
                      key={d.id}
                      iconName="pin"
                      title={d.name}
                      detail={d.description}
                      onClick={() => {
                        props.onDistrict(d);
                        setSheetIndex(0);
                      }}
                    />
                  ))}
                </ListGroup>
              </div>
            )}
          </SheetSection>
        )}

        {tab === 'route' && (
          <SheetSection>
            <ListGroup>
              <ListRow
                iconName="origin"
                title={props.origin?.name ?? '現在の画面中心から'}
                detail="出発地"
                onClick={() => {
                  setPickingOrigin(true);
                  setTab('search');
                  setSheetIndex(2);
                }}
              />
              <ListRow
                iconName="destination"
                title={props.destination?.name ?? '目的地を選ぶ'}
                detail="目的地"
                onClick={() => {
                  setPickingOrigin(false);
                  setTab('search');
                  setSheetIndex(2);
                }}
              />
            </ListGroup>

            <div className="pt-3">
              <Segmented options={MODES} value={props.mode} onChange={props.onModeChange} />
            </div>

            {props.route && (
              <div className="mt-3 rounded-[14px] bg-white/6 p-3.5 ring-1 ring-white/8">
                <div className="flex items-baseline gap-2">
                  <span className="text-[26px] font-semibold tabular-nums text-white">
                    {formatDuration(props.route.duration)}
                  </span>
                  <span className="text-[15px] text-mist-400">
                    {formatDistance(props.route.distance)}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-mist-500">
                  {props.route.maneuvers.length} 手順 / {props.route.engine}
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-3">
              <button
                type="button"
                onClick={props.onCalculateRoute}
                disabled={!props.destination || props.routing}
                className="tap-target flex-1 rounded-[12px] bg-white/10 px-4 text-[15px] font-medium text-mist-100 transition-transform active:scale-[0.98] disabled:opacity-40"
              >
                {props.routing ? '計算中…' : '経路を検索'}
              </button>
              <button
                type="button"
                onClick={props.onStartNavigation}
                disabled={!props.route}
                className="tap-target flex-1 rounded-[12px] bg-signal-500 px-4 text-[15px] font-semibold text-ink-950 transition-transform active:scale-[0.98] disabled:opacity-40"
              >
                案内を開始
              </button>
            </div>

            {props.route && (
              <button
                type="button"
                onClick={props.onClearRoute}
                className="tap-target mt-2 w-full rounded-[12px] text-[14px] text-mist-500 active:bg-white/8"
              >
                経路を消す
              </button>
            )}
          </SheetSection>
        )}

        {tab === 'view' && (
          <>
            <SheetSection title="都市">
              <ChipRow>
                {CITIES.map((c) => (
                  <Chip
                    key={c.id}
                    active={c.id === props.city.id}
                    onClick={() => props.onCityChange(c)}
                  >
                    {c.name}
                  </Chip>
                ))}
              </ChipRow>
            </SheetSection>

            <SheetSection title="時間帯">
              <ChipRow>
                {TIME_PRESETS.map((h) => (
                  <Chip
                    key={h}
                    active={!props.followRealTime && props.hour === h}
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
              </ChipRow>
            </SheetSection>

            <SheetSection title="天候">
              <ChipRow>
                {WEATHERS.map((w) => (
                  <Chip
                    key={w.kind}
                    active={props.weather === w.kind}
                    iconName={w.iconName}
                    onClick={() => props.onWeatherChange(w.kind)}
                  >
                    {w.label}
                  </Chip>
                ))}
              </ChipRow>
            </SheetSection>

            <SheetSection title="ベースマップ">
              <ChipRow>
                {props.imagery.map((i) => (
                  <Chip
                    key={i.id}
                    active={props.imageryId === i.id}
                    onClick={() => props.onImageryChange(i.id)}
                  >
                    {i.label}
                  </Chip>
                ))}
              </ChipRow>
            </SheetSection>

            <SheetSection title="周辺の施設">
              <ChipRow>
                {POI_CATEGORIES.map((c) => (
                  <Chip
                    key={c.id}
                    active={props.poiCategories.includes(c.id)}
                    iconName={c.iconName}
                    onClick={() => props.onTogglePoi(c.id)}
                  >
                    {c.label}
                  </Chip>
                ))}
                <Chip active={props.furnitureEnabled} onClick={props.onToggleFurniture}>
                  街路樹・街灯
                </Chip>
                <Chip active={props.structuresEnabled} onClick={props.onToggleStructures}>
                  {props.structuresLoading ? '高架を読み込み中…' : '高架・橋'}
                </Chip>
                <Chip active={props.roadsEnabled} onClick={props.onToggleRoads}>
                  {props.roadsLoading ? '道路を読み込み中…' : '車道・信号・線路'}
                </Chip>
              </ChipRow>
            </SheetSection>

            <SheetSection title="建物モデル">
              <ChipRow>
                {BUILDING_MODEL_MODES.filter((m) =>
                  availableBuildingModes(props.city).includes(m.id),
                ).map((m) => (
                  <Chip
                    key={m.id}
                    active={props.buildingModel === m.id}
                    onClick={() => props.onBuildingModelChange(m.id)}
                  >
                    {m.label}
                  </Chip>
                ))}
              </ChipRow>
              <p className="px-1 pt-1.5 text-[11px] leading-relaxed text-mist-500">
                {props.buildingModelBusy
                  ? '建物を読み直しています…'
                  : (BUILDING_MODEL_MODES.find((m) => m.id === props.buildingModel)?.description ??
                    '')}
              </p>
            </SheetSection>

            <SheetSection title="PLATEAU の追加レイヤ">
              <ChipRow>
                {LAYERS.map((l) => (
                  <Chip
                    key={l.id}
                    active={props.optionalLayers.includes(l.id)}
                    onClick={() => props.onToggleLayer(l.id)}
                  >
                    {l.label}
                  </Chip>
                ))}
              </ChipRow>
              <p className="px-1 pt-1.5 text-[11px] leading-relaxed text-mist-500">
                詳細モデルは窓や扉まで再現した LOD3。整備済みの地域でのみ表示されます。
              </p>
            </SheetSection>

            <SheetSection title="描画品質">
              <ChipRow>
                {QUALITY_CHOICES.map((q) => (
                  <Chip
                    key={q.id}
                    active={props.qualityChoice === q.id}
                    onClick={() => props.onQualityChange(q.id)}
                  >
                    {q.label}
                  </Chip>
                ))}
              </ChipRow>
              <p className="px-1 pt-1.5 text-[11px] text-mist-500">現在: {props.qualityLabel}</p>
            </SheetSection>

            <SheetSection title="データ出典">
              <ListGroup>
                {props.attributions.map((s) => (
                  <ListRow key={s.id} title={s.label} detail={s.license} />
                ))}
              </ListGroup>
            </SheetSection>
          </>
        )}
      </BottomSheet>
    </>
  );
}
