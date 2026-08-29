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
} from '@/lib/api';
import AIPanel from './AIPanel';
import AttributionPanel from './AttributionPanel';
import BuildingInfoCard from './BuildingInfoCard';
import EnvironmentBar from './EnvironmentBar';
import NextTurnPanel from './NextTurnPanel';
import SearchPanel, { type PlacePoint } from './SearchPanel';

import DiagnosticsPanel from './DiagnosticsPanel';
import ErrorBoundary from './ErrorBoundary';

const MapCanvas = dynamic(() => import('./MapCanvas'), { ssr: false });

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

  const [hour, setHour] = useState(12);
  const [followRealTime, setFollowRealTime] = useState(false);
  const [weather, setWeather] = useState('clear');
  const [imageryId, setImageryId] = useState('seamlessphoto');
  const [qualityLabel, setQualityLabel] = useState('自動判定中');
  const [qualityChoice, setQualityChoice] = useState('auto');
  const [optionalLayers, setOptionalLayers] = useState<string[]>([]);

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
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(announcement.text);
        utterance.lang = 'ja-JP';
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
      }
    }

    if (result.progress.arrived) setNavigating(false);
  }, []);

  const handleReady = useCallback(
    (engine: MapEngine) => {
      engineRef.current = engine;
      setEngineReady(true);
      setQualityLabel(engine.qualitySettings.label);
      engine.setTimeOfDay(12);
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

  const stopNavigation = useCallback(() => {
    engineRef.current?.stopNavigation();
    setNavigating(false);
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
      try {
        await engine.loadCity(next);
        engine.flyTo({
          position: next.center,
          height: next.initialHeight,
          pitch: -40,
          duration: 2.5,
        });
      } catch (error) {
        notify(`${next.name} の 3D 都市データを読み込めませんでした: ${(error as Error).message}`);
      }
    },
    [notify],
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
          onStop={stopNavigation}
          onResumeFollow={() => engineRef.current?.resumeFollow()}
        />
      )}

      {/* 左上: 検索とルート */}
      {!navigating && (
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
            />
          </div>
        </div>
      )}

      {/* 右下: 建物情報・AI・出典 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-end gap-2 pt-3 safe-bottom safe-x">
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
