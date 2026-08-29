'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BuildingInfo,
  City,
  DataSource,
  District,
  LatLng,
  PublicConfig,
  Route,
  TravelMode,
} from '@ijm/shared';
import { BASE_ATTRIBUTION_IDS, getDefaultCity, resolveAttributions } from '@ijm/shared';
import type { MapEngine, OptionalLayerId, QualityTier } from '@ijm/map-engine';
import type { NavigationTickResult } from '@ijm/navigation';
import type { ChatMessage, UICommand } from '@ijm/ai';
import { Icon } from '@ijm/ui';
import {
  askAI,
  fetchBuilding,
  fetchConfig,
  fetchPois,
  fetchRoute,
  fetchStreetFurniture,
  fetchStructures,
} from '@/lib/api';
import AIPanel from './AIPanel';
import AttributionPanel from './AttributionPanel';
import BuildingInfoCard from './BuildingInfoCard';
import EnvironmentBar from './EnvironmentBar';
import NextTurnPanel from './NextTurnPanel';
import SearchPanel, { type PlacePoint } from './SearchPanel';

import DiagnosticsPanel from './DiagnosticsPanel';
import ErrorBoundary from './ErrorBoundary';
import MobileShell from './mobile/MobileShell';
import { useIsMobile } from './mobile/useIsMobile';

const MapCanvas = dynamic(() => import('./MapCanvas'), { ssr: false });

/**
 * 経路を外れた状態がこれだけ続いたら再検索する。
 * 一瞬の測位のぶれで再検索すると案内が落ち着かない。
 */
const OFF_ROUTE_GRACE_MS = 4000;
/** 再検索の最小間隔。連続して引き直さないための間 */
const REROUTE_COOLDOWN_MS = 15000;
/** 音声案内のオン/オフを覚えておくキー */
const VOICE_STORAGE_KEY = 'ijm:voice';

export default function AppShell() {
  const engineRef = useRef<MapEngine | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [city, setCity] = useState<City>(getDefaultCity());

  const [origin, setOrigin] = useState<PlacePoint | null>(null);
  const [destination, setDestination] = useState<PlacePoint | null>(null);
  const [mode, setMode] = useState<TravelMode>('walk');
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);

  const [tick, setTick] = useState<NavigationTickResult | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  /**
   * 音声案内のオン/オフ。
   * 同乗者がいるときや音楽を聴いているときに切れないと使いづらい。
   * 選択は端末に覚えさせる（毎回切り直す手間をなくす）。
   */
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceRef = useRef(true);
  // tick ハンドラは再生成しないので、最新の目的地と移動手段は ref で参照する
  const destinationRef = useRef<PlacePoint | null>(null);
  const modeRef = useRef<TravelMode>('walk');
  /** 経路を外れ始めた時刻。一定時間続いたら再検索する */
  const offRouteSinceRef = useRef<number | null>(null);
  const lastRerouteAtRef = useRef(0);

  const [hour, setHour] = useState(12);
  const [followRealTime, setFollowRealTime] = useState(false);
  const [weather, setWeather] = useState('clear');
  const [imageryId, setImageryId] = useState('seamlessphoto');
  const [qualityLabel, setQualityLabel] = useState('自動判定中');
  const [qualityChoice, setQualityChoice] = useState('auto');
  const [optionalLayers, setOptionalLayers] = useState<string[]>([]);
  // 高架・橋（OSM 由来の立体構造物）
  const [structuresEnabled, setStructuresEnabled] = useState(false);
  const [structuresLoading, setStructuresLoading] = useState(false);
  // iPhone などのタッチ端末では、片手で操作できるボトムシート主体の画面に切り替える
  const isMobile = useIsMobile();

  const [poiCategories, setPoiCategories] = useState<string[]>([]);
  const [furnitureEnabled, setFurnitureEnabled] = useState(false);

  const [building, setBuilding] = useState<BuildingInfo | null>(null);
  const [buildingLoading, setBuildingLoading] = useState(false);

  const [aiOpen, setAiOpen] = useState(false);
  // URL に ?debug=1 が付いているときだけ描画診断を出す
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>([]);

  const [toast, setToast] = useState<string | null>(null);
  const spokenRef = useRef<string | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 5000);
  }, []);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => notify('設定の取得に失敗しました。既定値で動作します。'));
  }, [notify]);

  // ---- ナビゲーション ---------------------------------------------------

  const handleTick = useCallback((result: NavigationTickResult) => {
    setTick(result);

    // 音声案内（Web Speech API）。同じ案内を二重に読み上げない。
    const announcement = result.announcement;
    if (announcement && spokenRef.current !== announcement.id) {
      spokenRef.current = announcement.id;
      if (voiceRef.current && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(announcement.text);
        utterance.lang = 'ja-JP';
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
      }
    }

    if (result.progress.arrived) {
      setNavigating(false);
      offRouteSinceRef.current = null;
      return;
    }

    // 自動リルート。
    // 一瞬の測位のぶれで再検索すると案内が落ち着かないので、
    // 「外れた状態が続いていること」を条件にする。
    if (result.progress.offRoute) {
      const now = Date.now();
      offRouteSinceRef.current ??= now;
      const offFor = now - offRouteSinceRef.current;
      const sinceLast = now - lastRerouteAtRef.current;
      if (offFor >= OFF_ROUTE_GRACE_MS && sinceLast >= REROUTE_COOLDOWN_MS) {
        lastRerouteAtRef.current = now;
        offRouteSinceRef.current = null;
        void rerouteFromCurrent(result.progress.rawPosition);
      }
    } else {
      offRouteSinceRef.current = null;
    }
    // rerouteFromCurrent は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReady = useCallback(
    (engine: MapEngine) => {
      engineRef.current = engine;
      setEngineReady(true);
      setQualityLabel(engine.qualitySettings.label);
      engine.setTimeOfDay(12);
      // 起動時の都市が高架モデルを持たない場合も、街の骨格を見せる
      if (city.texturedBuildings === false) {
        void loadStructuresForView(3500);
      }
    },
    [],
  );

  // ?debug=1 で描画診断パネルを表示する（実機での負荷を確認するため）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') setShowDiagnostics(true);
  }, []);

  const handleToggleLayer = useCallback(
    async (id: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const layer = id as OptionalLayerId;

      if (engine.isOptionalLayerEnabled(layer)) {
        await engine.setOptionalLayer(layer, false);
        setOptionalLayers((prev) => prev.filter((v) => v !== id));
        return;
      }

      const ok = await engine.setOptionalLayer(layer, true);
      if (ok) {
        setOptionalLayers((prev) => [...prev, id]);
      } else {
        // 未整備の範囲では重ねられない。異常ではないので、その旨だけ伝える
        notify('この範囲には該当する PLATEAU データがありません');
      }
    },
    // notify は再生成されないため依存に含めなくてよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    destinationRef.current = destination;
  }, [destination]);

  // 音声のオン/オフは端末に覚えさせる
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VOICE_STORAGE_KEY);
      if (saved !== null) {
        const on = saved === '1';
        setVoiceEnabled(on);
        voiceRef.current = on;
      }
    } catch {
      // プライベートブラウズなどで使えない場合は既定（オン）のまま
    }
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled((prev) => {
      const next = !prev;
      voiceRef.current = next;
      try {
        window.localStorage.setItem(VOICE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // 保存できなくても今回の選択は効く
      }
      if (!next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        // 読み上げ中の案内はその場で止める
        window.speechSynthesis.cancel();
      }
      return next;
    });
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const handleQualityChange = useCallback((choice: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    setQualityChoice(choice);
    // 'auto' は端末判定に戻す。それ以外は利用者の指定を優先する
    engine.setQualityTier(choice === 'auto' ? engine.autoQualityTier : (choice as QualityTier));
    setQualityLabel(engine.qualitySettings.label);
  }, []);

  const viewCenter = useCallback((): LatLng | null => {
    return engineRef.current?.getViewCenter() ?? null;
  }, []);

  const calculateRoute = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !destination) return;

    const from = origin?.position ?? engine.getViewCenter();
    if (!from) {
      notify('出発地を特定できませんでした');
      return;
    }

    setRouting(true);
    try {
      const result = await fetchRoute(from, destination.position, mode);
      setRoute(result);
      await engine.showRoute(result);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setRouting(false);
    }
  }, [destination, mode, notify, origin]);

  const startNavigation = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !route) return;
    spokenRef.current = null;
    engine.startNavigation(route, { useRealPosition: false });
    setNavigating(true);
  }, [route]);

  /**
   * 現在地から目的地へ経路を引き直す。
   *
   * 曲がり損ねたときに元の経路へ戻そうとし続けるより、
   * 今いる場所からの最短を出し直す方が実用的。
   * 再検索中も案内は止めず、新しい経路が出てから切り替える。
   */
  const rerouteFromCurrent = useCallback(
    async (from: LatLng) => {
      const engine = engineRef.current;
      const to = destinationRef.current;
      if (!engine || !to) return;

      setRerouting(true);
      try {
        const next = await fetchRoute(from, to.position, modeRef.current);
        // 再検索中に案内が終わっていたら捨てる
        if (!engine.isNavigating) return;
        setRoute(next);
        engine.showRoute(next);
        spokenRef.current = null;
        engine.startNavigation(next, { useRealPosition: false });
        notify('経路を再検索しました');
      } catch {
        // 再検索に失敗しても、元の経路の案内は続いている
        notify('経路を再検索できませんでした');
      } finally {
        setRerouting(false);
      }
    },
    // notify は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stopNavigation = useCallback(() => {
    engineRef.current?.stopNavigation();
    setNavigating(false);
    setRerouting(false);
    offRouteSinceRef.current = null;
    setTick(null);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const clearRoute = useCallback(() => {
    stopNavigation();
    engineRef.current?.clearRoute();
    setRoute(null);
  }, [stopNavigation]);

  // ---- 表示設定 ---------------------------------------------------------

  const changeCity = useCallback(
    async (next: City) => {
      const engine = engineRef.current;
      if (!engine) return;
      setCity(next);
      engine.clearElevatedStructures();
      setStructuresEnabled(false);

      // カメラ移動は建物データと無関係なので、先に動かす。
      // 建物の取得を待ってから動かすと、取得に失敗したときに
      // 前の都市を見たまま止まってしまう。
      engine.flyTo({
        position: next.center,
        height: next.initialHeight,
        pitch: -40,
        duration: 2.5,
      });

      try {
        await engine.loadCity(next);
      } catch (error) {
        notify(`${next.name} の 3D 都市データを読み込めませんでした: ${(error as Error).message}`);
      }

      // 高架は建物とは別のデータ源（OSM）なので、建物が読めなくても出せる。
      // PLATEAU に橋梁モデルが無い都市では、これが無いと街の骨格が抜け落ちる。
      if (next.texturedBuildings === false) {
        void loadStructuresForView(3000);
      }
    },
    // notify と loadStructuresForView は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const focusPlace = useCallback((place: PlacePoint) => {
    engineRef.current?.flyTo({
      position: place.position,
      height: 420,
      pitch: -35,
      duration: 1.8,
    });
  }, []);

  const togglePoi = useCallback(
    async (category: string) => {
      const engine = engineRef.current;
      if (!engine) return;

      const next = poiCategories.includes(category)
        ? poiCategories.filter((c) => c !== category)
        : [...poiCategories, category];
      setPoiCategories(next);

      if (next.length === 0) {
        engine.clearPois();
        return;
      }

      const center = engine.getViewCenter();
      if (!center) return;
      try {
        const res = await fetchPois(center, next, 800);
        if (res.degraded) {
          notify(res.message ?? 'POI データを取得できませんでした');
          return;
        }
        engine.showPois(res.pois);
        if (res.pois.length === 0) notify('この範囲では該当する施設が見つかりませんでした');
      } catch (error) {
        notify((error as Error).message);
      }
    },
    [notify, poiCategories],
  );

  /**
   * 表示範囲の高架・橋を読み込む。
   *
   * 都市の切り替え直後は建物タイルの取得が集中しているので、
   * 少し待ってから始める（同時に走らせると初期表示が遅くなる）。
   */
  const loadStructuresForView = useCallback(async (delayMs = 0) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    // 画面いっぱいの範囲は斜め見下ろしだと数十 km 四方になり、API 側で弾かれる。
    // カメラ周辺 1.5km に切って確実に取得する
    const bbox = engine.getSurroundingBBox(1500);
    if (!bbox) return;

    setStructuresLoading(true);
    try {
      const res = await fetchStructures(bbox);
      if (res.structures.length === 0) return;
      await engine.showElevatedStructures(res.structures, bbox.join(','));
      setStructuresEnabled(true);
    } catch {
      // 構造物が出なくても地図とナビは成立する
    } finally {
      setStructuresLoading(false);
    }
  }, []);

  const toggleStructures = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (structuresEnabled) {
      engine.clearElevatedStructures();
      setStructuresEnabled(false);
      return;
    }

    const bbox = engine.getSurroundingBBox(1500);
    if (!bbox) {
      notify('表示範囲を特定できませんでした。ズームインしてください。');
      return;
    }

    setStructuresLoading(true);
    try {
      const res = await fetchStructures(bbox);
      if (res.structures.length === 0) {
        notify('この範囲に高架・橋のデータがありません');
        return;
      }
      await engine.showElevatedStructures(res.structures, bbox.join(','));
      setStructuresEnabled(true);
      notify(`高架・橋を ${res.structures.length} 件表示しました`);
    } catch (error) {
      notify((error as Error).message ?? '高架データを取得できませんでした');
    } finally {
      setStructuresLoading(false);
    }
    // notify は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuresEnabled]);

  const toggleFurniture = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (furnitureEnabled) {
      engine.furniture.clear();
      setFurnitureEnabled(false);
      return;
    }

    const bbox = engine.getViewBBox();
    if (!bbox) {
      notify('表示範囲を特定できませんでした。ズームインしてください。');
      return;
    }

    try {
      const res = await fetchStreetFurniture(bbox);
      if (res.degraded || res.points.length === 0) {
        notify('街路樹・街灯のデータを取得できませんでした（OSM に登録がないか、範囲が広すぎます）');
        return;
      }
      await engine.loadStreetFurniture(res.points, bbox);
      setFurnitureEnabled(true);
    } catch (error) {
      notify((error as Error).message);
    }
  }, [furnitureEnabled, notify]);

  const changeHour = useCallback((next: number) => {
    setHour(next);
    setFollowRealTime(false);
    engineRef.current?.setTimeOfDay(next);
  }, []);

  const changeFollowRealTime = useCallback((follow: boolean) => {
    setFollowRealTime(follow);
    engineRef.current?.setFollowRealTime(follow);
    if (follow) {
      const now = new Date();
      setHour(now.getHours() + now.getMinutes() / 60);
    }
  }, []);

  const changeWeather = useCallback((next: string) => {
    setWeather(next);
    engineRef.current?.setWeather(next as 'clear');
  }, []);

  const changeImagery = useCallback((id: string) => {
    setImageryId(id);
    engineRef.current?.setImagery(id);
  }, []);

  // ---- 建物クリック -----------------------------------------------------

  useEffect(() => {
    if (!engineReady) return;
    const engine = engineRef.current;
    if (!engine) return;

    const canvas = engine.viewer.scene.canvas;
    const onClick = async (event: MouseEvent) => {
      if (navigating) return;
      const rect = canvas.getBoundingClientRect();
      const { Cartesian2 } = await import('cesium');
      const picked = engine.pickBuilding(
        new Cartesian2(event.clientX - rect.left, event.clientY - rect.top),
      );
      if (!picked) return;

      setBuildingLoading(true);
      setBuilding(null);
      try {
        const res = await fetchBuilding(picked.position, picked.attributes);
        setBuilding(res.building);
      } catch {
        notify('建物情報を取得できませんでした');
      } finally {
        setBuildingLoading(false);
      }
    };

    canvas.addEventListener('click', onClick);
    return () => canvas.removeEventListener('click', onClick);
  }, [engineReady, navigating, notify]);

  // ---- AI ---------------------------------------------------------------

  const applyUICommands = useCallback(
    async (commands: UICommand[]) => {
      const engine = engineRef.current;
      if (!engine) return;

      for (const command of commands) {
        switch (command.type) {
          case 'setCamera':
            engine.flyTo({
              position: command.payload.position,
              height: command.payload.height ?? 500,
              heading: command.payload.heading,
              pitch: command.payload.pitch ?? -40,
              duration: 2.0,
            });
            break;
          case 'highlightLocation':
            engine.routeLayer.setMarker({
              id: `ai-${command.payload.label}`,
              position: command.payload.position,
              label: command.payload.label,
              kind: 'highlight',
            });
            engine.requestRender();
            break;
          case 'showRoute':
            setRoute(command.payload.route);
            await engine.showRoute(command.payload.route);
            break;
          case 'showPois':
            engine.showPois(command.payload.pois);
            break;
          case 'startNavigation':
            if (route ?? command.payload.routeId) {
              const target = route;
              if (target) {
                spokenRef.current = null;
                engine.startNavigation(target, { useRealPosition: false });
                setNavigating(true);
              }
            }
            break;
          case 'setTimeOfDay':
            changeHour(command.payload.hour);
            break;
          case 'setWeather':
            changeWeather(command.payload.weather);
            break;
          case 'showSearchResults': {
            const first = command.payload.results[0];
            if (first) {
              setDestination({ name: first.name, position: { lat: first.lat, lng: first.lng } });
            }
            break;
          }
          case 'showBuildingInfo':
            break;
        }
      }
    },
    [changeHour, changeWeather, route],
  );

  const sendToAI = useCallback(
    async (text: string) => {
      const engine = engineRef.current;
      const nextMessages: ChatMessage[] = [...aiMessages, { role: 'user', content: text }];
      setAiMessages(nextMessages);
      setAiBusy(true);

      try {
        const camera = engine?.getCameraState();
        const result = await askAI(nextMessages, {
          camera,
          viewCenter: engine?.getViewCenter(),
          cityName: city.name,
          activeRoute: route
            ? { id: route.id, mode: route.mode, distance: route.distance, duration: route.duration }
            : null,
          timeOfDay: hour,
        });

        setAiMessages([...nextMessages, { role: 'assistant', content: result.reply }]);
        await applyUICommands(result.uiCommands);
      } catch (error) {
        setAiMessages([
          ...nextMessages,
          { role: 'assistant', content: `エラー: ${(error as Error).message}` },
        ]);
      } finally {
        setAiBusy(false);
      }
    },
    [aiMessages, applyUICommands, city.name, hour, route],
  );

  // ---- 表示 -------------------------------------------------------------

  const attributions: DataSource[] =
    config?.attributions ??
    resolveAttributions([...BASE_ATTRIBUTION_IDS, 'valhalla', 'nominatim', 'overpass']);

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-ink-950">
      <ErrorBoundary>
        <MapCanvas
          city={city}
          onReady={handleReady}
          onNavigationTick={handleTick}
          onError={notify}
        />
      </ErrorBoundary>

      {showDiagnostics && (
        <DiagnosticsPanel
          engine={engineReady ? engineRef.current : null}
          onClose={() => setShowDiagnostics(false)}
        />
      )}

      {navigating && (
        <NextTurnPanel
          tick={tick}
          rerouting={rerouting}
          voiceEnabled={voiceEnabled}
          onToggleVoice={toggleVoice}
          onStop={stopNavigation}
          onResumeFollow={() => engineRef.current?.resumeFollow()}
        />
      )}

      {/* 左上: 検索とルート（デスクトップ）*/}
      {!navigating && !isMobile && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 safe-top safe-x">
          <div className="pointer-events-auto mx-auto w-full max-w-[420px] space-y-2 sm:mx-0">
            <SearchPanel
              origin={origin}
              destination={destination}
              mode={mode}
              route={route}
              routing={routing}
              viewCenter={viewCenter}
              onSelectOrigin={setOrigin}
              onSelectDestination={setDestination}
              onModeChange={setMode}
              onCalculateRoute={calculateRoute}
              onStartNavigation={startNavigation}
              onFocusPlace={focusPlace}
              onClearRoute={clearRoute}
            />
            <EnvironmentBar
              city={city}
              hour={hour}
              weather={weather}
              imageryId={imageryId}
              imagery={config?.imagery ?? []}
              qualityLabel={qualityLabel}
              qualityChoice={qualityChoice}
              onQualityChange={handleQualityChange}
              optionalLayers={optionalLayers}
              onToggleLayer={handleToggleLayer}
              followRealTime={followRealTime}
              poiCategories={poiCategories}
              furnitureEnabled={furnitureEnabled}
              onCityChange={changeCity}
              onDistrict={(d: District) => engineRef.current?.flyToDistrict(d)}
              onHourChange={changeHour}
              onFollowRealTime={changeFollowRealTime}
              onWeatherChange={changeWeather}
              onImageryChange={changeImagery}
              onTogglePoi={togglePoi}
              onToggleFurniture={toggleFurniture}
              structuresEnabled={structuresEnabled}
              structuresLoading={structuresLoading}
              onToggleStructures={toggleStructures}
            />
          </div>
        </div>
      )}

      {/* iPhone などのタッチ端末: 操作系を下から出るシートに集約する */}
      {isMobile && !navigating && (
        <MobileShell
          city={city}
          origin={origin}
          destination={destination}
          mode={mode}
          route={route}
          routing={routing}
          navigating={navigating}
          hour={hour}
          weather={weather}
          imageryId={imageryId}
          imagery={config?.imagery ?? []}
          qualityLabel={qualityLabel}
          qualityChoice={qualityChoice}
          optionalLayers={optionalLayers}
          poiCategories={poiCategories}
          furnitureEnabled={furnitureEnabled}
          followRealTime={followRealTime}
          attributions={attributions}
          aiEnabled={aiOpen}
          viewCenter={viewCenter}
          onSelectOrigin={setOrigin}
          onSelectDestination={setDestination}
          onModeChange={setMode}
          onCalculateRoute={calculateRoute}
          onStartNavigation={startNavigation}
          onFocusPlace={focusPlace}
          onClearRoute={clearRoute}
          onCityChange={changeCity}
          onDistrict={(d: District) => engineRef.current?.flyToDistrict(d)}
          onHourChange={changeHour}
          onFollowRealTime={changeFollowRealTime}
          onWeatherChange={changeWeather}
          onImageryChange={changeImagery}
          onQualityChange={handleQualityChange}
          onToggleLayer={handleToggleLayer}
          onTogglePoi={togglePoi}
          onToggleFurniture={toggleFurniture}
          structuresEnabled={structuresEnabled}
          structuresLoading={structuresLoading}
          onToggleStructures={toggleStructures}
          onOpenAI={() => setAiOpen((v) => !v)}
        />
      )}

      {/* 右下: 建物情報・AI・出典 */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-end gap-2 pt-3 safe-bottom safe-x ${
          // シートと重なるため、モバイルでは出典と AI ボタンをシート側に任せる
          isMobile ? 'hidden' : ''
        }`}
      >
        <div className="pointer-events-auto">
          <BuildingInfoCard
            building={building}
            loading={buildingLoading}
            onClose={() => {
              setBuilding(null);
              setBuildingLoading(false);
            }}
          />
        </div>

        {aiOpen && (
          <div className="pointer-events-auto">
            <AIPanel
              enabled={config?.features.ai ?? false}
              busy={aiBusy}
              messages={aiMessages}
              onSend={sendToAI}
              onClose={() => setAiOpen(false)}
            />
          </div>
        )}

        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
          <AttributionPanel sources={attributions} />
          <button
            onClick={() => setAiOpen((v) => !v)}
            aria-label="AI に頼む"
            className="glass tap-target inline-flex items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-signal-400"
          >
            <Icon name="sparkle" size={15} />
            AI に頼む
          </button>
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <div className="glass max-w-[92vw] rounded-full px-4 py-2 text-[12px] text-mist-100">
            {toast}
          </div>
        </div>
      )}
    </main>
  );
}
