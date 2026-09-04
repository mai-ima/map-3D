'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BuildingInfo,
  BuildingModelMode,
  City,
  DataSource,
  District,
  ElevatedStructure,
  LatLng,
  PublicConfig,
  Route,
  TravelMode,
} from '@ijm/shared';
import {
  BASE_ATTRIBUTION_IDS,
  getDefaultCity,
  resolveAttributions,
  resolveBuildingMode,
} from '@ijm/shared';
import type { MapEngine, OptionalLayerId, QualityTier } from '@ijm/map-engine';
import type { NavigationTickResult } from '@ijm/navigation';
import { advancePassedVia, remainingVia } from '@ijm/navigation';
import type { ChatMessage, UICommand } from '@ijm/ai';
import {
  nearestRoad,
  type ArrivalPoint,
  type RailPiece,
  type RoadPiece,
  type RoadPoint,
} from '@ijm/gis';
import { Icon } from '@ijm/ui';
import {
  askAI,
  fetchArrivalGuide,
  fetchBuilding,
  fetchConfig,
  fetchPois,
  fetchRoute,
  fetchStreetFurniture,
  fetchRoads,
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
/**
 * 制限速度を引き直す間隔 (ms)。
 * 標識の値は走っている道が変わったときにしか変わらないので、
 * 毎フレーム探し直す必要はない。
 */
const SPEED_LIMIT_INTERVAL_MS = 700;
/**
 * 到着地点の案内（入口・駐車場）を取りに行く残距離 (m)。
 *
 * 着いてから取ると、案内が要るときに間に合わない。
 * 400m あれば法定速度 60km/h でおよそ 24 秒あり、通信が間に合う。
 */
const ARRIVAL_LOOKUP_M = 400;

export default function AppShell() {
  const engineRef = useRef<MapEngine | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [city, setCity] = useState<City>(getDefaultCity());

  const [origin, setOrigin] = useState<PlacePoint | null>(null);
  const [destination, setDestination] = useState<PlacePoint | null>(null);
  /**
   * 経由地。出発地から目的地へ向かう途中で、この順に必ず通る。
   * 市販カーナビの標準機能で、「先に寄ってから」を表す
   */
  const [via, setVia] = useState<PlacePoint[]>([]);
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
  /**
   * 建物モデルの見え方。
   *
   * 都市ごとの決め打ちではなく利用者の選択にする。
   * 東京は実写テクスチャ・用途で塗り分け・箱型の 3 通りから選べる。
   */
  const [buildingModel, setBuildingModel] = useState<BuildingModelMode>('textured');
  /** 切り替え中は建物を読み直している（連打で二重に読ませない） */
  const [buildingModelBusy, setBuildingModelBusy] = useState(false);
  // 高架・橋（OSM 由来の立体構造物）
  const [structuresEnabled, setStructuresEnabled] = useState(false);
  const [structuresLoading, setStructuresLoading] = useState(false);
  // カメラ操作のコールバックは毎フレーム走るので、再生成されない ref から読む
  const structuresEnabledRef = useRef(false);
  /**
   * いま取り寄せ中か。二重に走らせないための門。
   *
   * **`useState` を `useEffect` で写すのでは間に合わない。**
   * 状態の反映は再描画のあとなので、同じフレームでカメラの移動が
   * 2 回届くと、どちらも「取り寄せ中ではない」と見て両方が走る。
   * 実測（2026-09-04、実機ブラウザ）で、まったく同じ範囲の
   * `/api/structures` が 1.3 秒差で 2 本飛んでいた。
   * ここは ref に直接書いて、その場で閉める。
   */
  const structuresLoadingRef = useRef(false);
  // 車道・車線・横断歩道・信号・線路（OSM 由来）
  const [roadsEnabled, setRoadsEnabled] = useState(false);
  const [roadsLoading, setRoadsLoading] = useState(false);
  const roadsEnabledRef = useRef(false);
  /** 道路も同じ。取り寄せ中かは ref に直接書く（上の理由と同じ） */
  const roadsLoadingRef = useRef(false);
  /** いま選ばれている周辺施設のカテゴリ。カメラ追従の判定に使う */
  const poiCategoriesRef = useRef<string[]>([]);
  const poiLoadingRef = useRef(false);
  const furnitureEnabledRef = useRef(false);
  const furnitureLoadingRef = useRef(false);
  /** 建物モデルを読み直している最中か。連打で二重に読ませないための門 */
  const buildingModelBusyRef = useRef(false);
  /** 案内中の経由地と、そのうち通過した数。再検索で引き返さないために持つ */
  const viaRef = useRef<PlacePoint[]>([]);
  const passedViaRef = useRef(0);
  /**
   * 読み込んだ道路。走行中の制限速度を引くために持っておく。
   * tick は毎秒走るので、再生成されない ref に置く。
   */
  const roadPiecesRef = useRef<RoadPiece[]>([]);
  /** 最後に制限速度を引いた時刻。毎フレーム引かないための間引き */
  const lastSpeedCheckRef = useRef(0);
  /**
   * 最後に読み込んだ道路のひとまとまりと、その範囲。
   * 上空へ引いたときに区画線を落とす切り替えで、
   * 取り直さずに組み直すために持っておく。
   */
  const roadSceneRef = useRef<{
    scene: { roads: RoadPiece[]; rails: RailPiece[]; points: RoadPoint[] };
    bbox: [number, number, number, number];
    key: string;
  } | null>(null);
  /**
   * 最後に読み込んだ高架・橋と、その範囲。
   *
   * 上空から降りてきたときに、高架の上へ軌道を敷き直すために持っておく
   * （範囲は変わっていないので取り直しは要らない）。
   */
  const structuresHeldRef = useRef<{ structures: ElevatedStructure[]; key: string } | null>(null);
  /** いま走っている道の制限速度 (km/h)。OSM に入っているときだけ */
  const [speedLimit, setSpeedLimit] = useState<number | null>(null);
  /**
   * 到着地点の案内（建物の出入口と駐車場）。
   *
   * カーナビで最後に困るのは「着いたけれど、どこから入るのか」。
   * 目的地が近づいたら 1 回だけ取る。OSM に無ければ空のまま
   */
  const [arrival, setArrival] = useState<{
    entrances: ArrivalPoint[];
    parking: ArrivalPoint[];
  } | null>(null);
  /** 到着案内を取りに行ったかどうか。案内 1 回につき 1 度だけ */
  const arrivalRequestedRef = useRef(false);
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

  /** 出しっぱなしの通知を消すためのタイマー。画面を離れるときに止める */
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(
      () => setToast((current) => (current === message ? null : current)),
      5000,
    );
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => notify('設定の取得に失敗しました。既定値で動作します。'));
  }, [notify]);

  // ---- ナビゲーション ---------------------------------------------------

  const handleTick = useCallback((result: NavigationTickResult) => {
    setTick(result);

    // いま走っている道の制限速度。
    // OSM に maxspeed が入っている道の上にいるときだけ出す。
    // 種別からの推測はしない（標識に無い数字を見せることになる）。
    //
    // tick は毎フレーム走るが、標識の値が毎フレーム変わることはない。
    // 道路 533 本で 1 回 0.86ms かかるので、毎フレーム引くと 60fps で
    // CPU の 5% を使ってしまう（東京の密度なら 20%）
    const now = performance.now();
    if (now - lastSpeedCheckRef.current >= SPEED_LIMIT_INTERVAL_MS) {
      lastSpeedCheckRef.current = now;
      const road = nearestRoad(roadPiecesRef.current, result.progress.rawPosition);
      setSpeedLimit(road?.speedLimit ?? null);
    }

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
    /**
     * 目的地が近づいたら、入口と駐車場を取りに行く。
     *
     * 着いてから取ると、案内が要るときに間に合わない。
     * 400m あれば、法定速度 60km/h でおよそ 24 秒あり、通信が間に合う。
     * 1 回の案内につき 1 度だけ取る（毎フレーム取りに行かない）
     */
    if (
      !arrivalRequestedRef.current &&
      destinationRef.current &&
      result.progress.remainingDistance <= ARRIVAL_LOOKUP_M
    ) {
      arrivalRequestedRef.current = true;
      const to = destinationRef.current.position;
      void fetchArrivalGuide(to)
        .then((guide) => setArrival({ entrances: guide.entrances, parking: guide.parking }))
        // 取れなくても案内そのものは成立する。黙って何も出さない
        .catch(() => setArrival(null));
    }

    /**
     * 経由地の通過を進める。
     *
     * 順に通るので、先頭から見て近づいたものを通過済みにする。
     * 再検索のときに、通過済みの経由地を渡さないために要る
     */
    if (viaRef.current.length > 0) {
      passedViaRef.current = advancePassedVia(
        viaRef.current.map((v) => v.position),
        passedViaRef.current,
        result.progress.rawPosition,
      );
    }

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
      // 起動時の都市で実際に選ばれた見え方に合わせる
      // （その都市に無い見え方は engine 側で寄せ直されている）
      setBuildingModel(engine.buildingModel);
      engine.setTimeOfDay(12);
      // 起動時の都市が高架モデルを持たない場合も、街の骨格を見せる
      if (city.texturedBuildings === false) {
        void loadStructuresForView(3500);
      }
    },
    [],
  );

  useEffect(() => {
    structuresEnabledRef.current = structuresEnabled;
  }, [structuresEnabled]);
  useEffect(() => {
    roadsEnabledRef.current = roadsEnabled;
  }, [roadsEnabled]);
  useEffect(() => {
    poiCategoriesRef.current = poiCategories;
  }, [poiCategories]);
  useEffect(() => {
    furnitureEnabledRef.current = furnitureEnabled;
  }, [furnitureEnabled]);

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

  useEffect(() => {
    viaRef.current = via;
    // 経由地を編集したら、通過の記録もやり直す
    passedViaRef.current = 0;
  }, [via]);

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

  /**
   * 建物モデルの見え方を切り替える。
   *
   * 配信されているデータセットそのものが変わるので、近景を読み直す。
   * 新しいほうが出そろってから差し替わるため、街から建物が消える瞬間はない。
   */
  const changeBuildingModel = useCallback(async (mode: BuildingModelMode) => {
    const engine = engineRef.current;
    if (!engine || buildingModelBusyRef.current) return;
    if (engine.buildingModel === mode) return;

    buildingModelBusyRef.current = true;
    setBuildingModelBusy(true);
    try {
      await engine.setBuildingModel(mode);
    } finally {
      // 実際に何が出ているかはエンジン側が持っている。
      // 選べない見え方や読み直しの失敗があっても、表示と設定を食い違わせない
      setBuildingModel(engine.buildingModel);
      buildingModelBusyRef.current = false;
      setBuildingModelBusy(false);
    }
  }, []);

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
      const result = await fetchRoute(
        from,
        destination.position,
        mode,
        via.map((v) => v.position),
      );
      setRoute(result);
      passedViaRef.current = 0;
      await engine.showRoute(result);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setRouting(false);
    }
  }, [destination, mode, notify, origin, via]);

  const startNavigation = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !route) return;
    spokenRef.current = null;
    // 前の案内で取った到着案内を持ち越さない
    setArrival(null);
    arrivalRequestedRef.current = false;
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
        /**
         * まだ通っていない経由地だけを渡す。
         *
         * 通過済みまで渡すと、一度通った場所へ引き返す経路が出る。
         * 経由地を通り過ぎた直後の再検索で U ターンを指示されることになる。
         */
        const rest = remainingVia(
          viaRef.current.map((v) => v.position),
          passedViaRef.current,
        );
        const next = await fetchRoute(from, to.position, modeRef.current, rest);
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
    setArrival(null);
    arrivalRequestedRef.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const clearRoute = useCallback(() => {
    stopNavigation();
    engineRef.current?.clearRoute();
    setRoute(null);
    // 経由地は経路といっしょに消す。残しておくと、次の検索で
    // 前の経路の経由地を通ることになる
    setVia([]);
    passedViaRef.current = 0;
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

      // 都市によって配信されているデータセットが違う（浜松はテクスチャ無しのみ）。
      // 選べない見え方が残らないよう、先に寄せ直しておく
      setBuildingModel((prev) => resolveBuildingMode(next, prev));

      try {
        await engine.loadCity(next);
      } catch (error) {
        notify(`${next.name} の 3D 都市データを読み込めませんでした: ${(error as Error).message}`);
      }
      setBuildingModel(engine.buildingModel);

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

  /**
   * 周辺施設を、いまの画面中心で取り直す。
   *
   * カメラの移動からも呼ぶ。以前は種別を選び直したときにしか読んでおらず、
   * 街を移動すると施設だけが元の場所に取り残されていた。
   *
   * @param quiet 追従で呼ばれたとき。結果が 0 件でも通知しない
   */
  const loadPoisForView = useCallback(
    async (categories: string[], quiet = false) => {
      const engine = engineRef.current;
      if (!engine || categories.length === 0) return;
      if (poiLoadingRef.current) return;

      const center = engine.getViewCenter();
      if (!center) return;

      poiLoadingRef.current = true;
      try {
        const res = await fetchPois(center, categories, 800);
        if (engine.isDestroyed) return;
        if (res.degraded) {
          if (!quiet) notify(res.message ?? 'POI データを取得できませんでした');
          return;
        }
        engine.showPois(res.pois);
        engine.markPoisLoaded();
        if (res.pois.length === 0 && !quiet) {
          notify('この範囲では該当する施設が見つかりませんでした');
        }
      } catch (error) {
        if (!quiet) notify((error as Error).message);
      } finally {
        poiLoadingRef.current = false;
      }
    },
    [notify],
  );

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
      await loadPoisForView(next);
    },
    [loadPoisForView, poiCategories],
  );

  /**
   * 街路樹・街灯を、いまの表示範囲で取り直す。
   * こちらもカメラの移動から呼ぶ（以前は手動で入れ直すまで付いてこなかった）。
   */
  const loadFurnitureForView = useCallback(
    async (quiet = false) => {
      const engine = engineRef.current;
      if (!engine || furnitureLoadingRef.current) return;
      const bbox = engine.getViewBBox();
      if (!bbox) {
        if (!quiet) notify('表示範囲を特定できませんでした。ズームインしてください。');
        return;
      }

      furnitureLoadingRef.current = true;
      try {
        const res = await fetchStreetFurniture(bbox);
        if (engine.isDestroyed) return;
        // 取り寄せに失敗したときだけ戻る。
        // 「この範囲に無い」で戻ると、以後まったく追従しなくなる
        // （街路樹の無い場所で入れると、ある場所へ移動しても出てこなかった）
        if (res.degraded) {
          if (!quiet) {
            notify('街路樹のデータを取り寄せられませんでした。少し待ってお試しください。');
          }
          return;
        }
        if (res.points.length === 0 && !quiet) {
          notify('この範囲には街路樹・街灯が OSM に登録されていません（移動すると読み込みます）');
        }
        await engine.loadStreetFurniture(res.points, bbox);
        if (engine.isDestroyed) return;
        engine.markFurnitureLoaded();
        setFurnitureEnabled(true);
      } catch (error) {
        if (!quiet) notify((error as Error).message);
      } finally {
        furnitureLoadingRef.current = false;
      }
    },
    [notify],
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
    // 待っている間に画面を離れているかもしれない
    if (engine.isDestroyed) return;

    // 画面いっぱいの範囲は斜め見下ろしだと数十 km 四方になり、API 側で弾かれる。
    // カメラ周辺 1.5km に切って確実に取得する。
    // 中心は 500m 格子に載せる。少し動くたびに違う範囲を要求すると
    // キャッシュがまったく当たらず、構造物の組み立て直しも毎回走る
    const bbox = engine.getSurroundingBBox(1500, 500);
    if (!bbox) return;

    structuresLoadingRef.current = true;
    setStructuresLoading(true);
    try {
      const res = await fetchStructures(bbox);
      if (engine.isDestroyed) return;
      /**
       * 取り寄せに失敗したときだけ、何も控えずに戻る。
       *
       * 「この範囲に高架が無い」ときは**空のまま反映する**のが正しい。
       * 以前はここで `structures.length === 0` でも戻っていたため、
       *
       *   - `structuresEnabled` が false のままになり、
       *     `handleCameraMoved` が二度と高架を見に行かなくなる
       *   - 中心（`structuresCentre`）も控えられないので、
       *     仮に見に行っても「移動していない」と判断される
       *
       * となり、**高架の無い場所で起動すると、高架のある場所へ移動しても
       * 二度と出てこない**という状態になっていた。道路も同じ形の欠陥。
       */
      if (res.degraded) return;
      await engine.showElevatedStructures(res.structures, bbox.join(','));
      if (engine.isDestroyed) return;
      structuresHeldRef.current = { structures: res.structures, key: bbox.join(',') };
      setStructuresEnabled(true);
    } catch {
      // 構造物が出なくても地図とナビは成立する
    } finally {
      structuresLoadingRef.current = false;
      setStructuresLoading(false);
    }
  }, []);

  /**
   * 車道・車線・横断歩道・信号・線路を読み込む。
   *
   * 道路は要素が多いので、高架より狭い範囲（1km）に絞る。
   * 中心を 400m 格子に載せて、少し動くたびに違う範囲を要求しないようにする。
   */
  const loadRoadsForView = useCallback(async (delayMs = 0) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    // 待っている間に画面を離れているかもしれない
    if (engine.isDestroyed) return;

    const bbox = engine.getSurroundingBBox(1000, 400);
    if (!bbox) return;

    roadsLoadingRef.current = true;
    setRoadsLoading(true);
    try {
      const res = await fetchRoads(bbox);
      if (engine.isDestroyed) return;
      // 取り寄せに失敗したときだけ戻る。「この範囲に道が無い」は
      // 空のまま反映する（控えないと、以後まったく追従しなくなる）
      if (res.degraded) return;
      const key = bbox.join(',');
      await engine.showRoadScene(res, bbox, key);
      if (engine.isDestroyed) return;
      roadPiecesRef.current = res.roads;
      roadSceneRef.current = { scene: res, bbox, key };
      setRoadsEnabled(true);
    } catch {
      // 道が出なくても地図とナビは成立する
    } finally {
      roadsLoadingRef.current = false;
      setRoadsLoading(false);
    }
  }, []);

  /**
   * カメラが動いたら高架と道路を取り直す。
   *
   * どちらもカメラ周辺ぶんしか読んでいないので、街を移動すると
   * その範囲から出てしまい、付いてこない。
   * 取り直しは通信とジオメトリの再生成を伴うので、
   * 十分に離れたときだけ、しかも 1 件ずつ実行する。
   */
  const handleCameraMoved = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (structuresEnabledRef.current && !structuresLoadingRef.current) {
      if (engine.needsStructureRefresh()) {
        void loadStructuresForView();
      } else if (engine.needsStructureDetailChange()) {
        // 高度が変わっただけ。範囲は同じなので取り直さず、
        // 手元のデータで組み直す（降りてきたら高架の上に軌道を敷く）
        const held = structuresHeldRef.current;
        if (held) void engine.showElevatedStructures(held.structures, held.key);
      }
    }
    if (roadsEnabledRef.current && !roadsLoadingRef.current) {
      if (engine.needsRoadRefresh()) {
        void loadRoadsForView();
      } else if (engine.needsRoadDetailChange()) {
        // 高度が変わっただけ。範囲は同じなので取り直さず、
        // 手元のデータで組み直す（通信も待ちも要らない）
        const held = roadSceneRef.current;
        if (held) void engine.showRoadScene(held.scene, held.bbox, held.key);
      }
    }
    // 周辺施設と街路樹も付いてこさせる。
    // どちらも「カメラ周辺ぶんだけ」取っているので、
    // 追従させないと移動した先では何も出ない
    const categories = poiCategoriesRef.current;
    if (categories.length > 0 && !poiLoadingRef.current && engine.needsPoiRefresh()) {
      void loadPoisForView(categories, true);
    }
    if (
      furnitureEnabledRef.current &&
      !furnitureLoadingRef.current &&
      engine.needsFurnitureRefresh()
    ) {
      void loadFurnitureForView(true);
    }
    // loadStructuresForView / loadRoadsForView は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleStructures = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (structuresEnabled) {
      engine.clearElevatedStructures();
      structuresHeldRef.current = null;
      setStructuresEnabled(false);
      return;
    }

    // 手動で出すときも、自動で追従するときと同じ格子に載せる
    const bbox = engine.getSurroundingBBox(1500, 500);
    if (!bbox) {
      notify('表示範囲を特定できませんでした。ズームインしてください。');
      return;
    }

    structuresLoadingRef.current = true;
    setStructuresLoading(true);
    try {
      const res = await fetchStructures(bbox);
      // 「この範囲に無い」と「取り寄せられなかった」は別のこと。
      // OSM の公開サーバが混んでいるときに前者と言うと、
      // 高架のある場所でも「データがありません」と出てしまう
      if (res.degraded) {
        notify('地図データの取り寄せに時間がかかっています。少し待って、もう一度お試しください。');
        return;
      }
      const key = bbox.join(',');
      await engine.showElevatedStructures(res.structures, key);
      structuresHeldRef.current = { structures: res.structures, key };
      // この範囲に無くても「表示する」状態にはしておく。
      // ここで戻ると、高架のある場所へ移動しても追従が始まらない
      setStructuresEnabled(true);
      notify(
        res.structures.length === 0
          ? 'この範囲に高架・橋のデータがありません（移動すると読み込みます）'
          : `高架・橋を ${res.structures.length} 件表示しました`,
      );
    } catch (error) {
      notify((error as Error).message ?? '高架データを取得できませんでした');
    } finally {
      structuresLoadingRef.current = false;
      setStructuresLoading(false);
    }
    // notify は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuresEnabled]);

  const toggleRoads = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (roadsEnabled) {
      engine.clearRoadScene();
      roadPiecesRef.current = [];
      roadSceneRef.current = null;
      setRoadsEnabled(false);
      setSpeedLimit(null);
      return;
    }

    const bbox = engine.getSurroundingBBox(1000, 400);
    if (!bbox) {
      notify('表示範囲を特定できませんでした。ズームインしてください。');
      return;
    }

    roadsLoadingRef.current = true;
    setRoadsLoading(true);
    try {
      const res = await fetchRoads(bbox);
      if (res.degraded) {
        notify('地図データの取り寄せに時間がかかっています。少し待って、もう一度お試しください。');
        return;
      }
      const key = bbox.join(',');
      await engine.showRoadScene(res, bbox, key);
      roadPiecesRef.current = res.roads;
      roadSceneRef.current = { scene: res, bbox, key };
      // この範囲に無くても「表示する」状態にはしておく（追従を始めるため）
      setRoadsEnabled(true);
      if (res.roads.length === 0 && res.rails.length === 0) {
        notify('この範囲に道路データがありません（移動すると読み込みます）');
        return;
      }
      // 速度制限は OSM に入っている道だけ。何本に入っていたかを伝える
      const withSpeed = res.roads.filter((r) => r.speedLimit !== undefined).length;
      notify(
        `道路 ${res.roads.length} 本・線路 ${res.rails.length} 本・信号 ${res.points.filter((p) => p.kind === 'traffic_signal').length} 基を表示しました` +
          (withSpeed > 0 ? `（うち速度制限あり ${withSpeed} 本）` : ''),
      );
    } catch (error) {
      notify((error as Error).message ?? '道路データを取得できませんでした');
    } finally {
      roadsLoadingRef.current = false;
      setRoadsLoading(false);
    }
    // notify は再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roadsEnabled]);

  const toggleFurniture = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (furnitureEnabled) {
      engine.furniture.clear();
      setFurnitureEnabled(false);
      return;
    }
    await loadFurnitureForView();
  }, [furnitureEnabled, loadFurnitureForView]);

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
          onCameraInteraction={handleCameraMoved}
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
          speedLimit={speedLimit}
          arrival={arrival}
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
              via={via}
              mode={mode}
              route={route}
              routing={routing}
              viewCenter={viewCenter}
              onSelectOrigin={setOrigin}
              onSelectDestination={setDestination}
              onChangeVia={setVia}
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
              buildingModel={buildingModel}
              buildingModelBusy={buildingModelBusy}
              onBuildingModelChange={changeBuildingModel}
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
              roadsEnabled={roadsEnabled}
              roadsLoading={roadsLoading}
              onToggleRoads={toggleRoads}
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
          via={via}
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
          buildingModel={buildingModel}
          buildingModelBusy={buildingModelBusy}
          poiCategories={poiCategories}
          furnitureEnabled={furnitureEnabled}
          followRealTime={followRealTime}
          attributions={attributions}
          aiEnabled={aiOpen}
          viewCenter={viewCenter}
          onSelectOrigin={setOrigin}
          onSelectDestination={setDestination}
          onChangeVia={setVia}
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
          onBuildingModelChange={changeBuildingModel}
          onTogglePoi={togglePoi}
          onToggleFurniture={toggleFurniture}
          structuresEnabled={structuresEnabled}
          structuresLoading={structuresLoading}
          onToggleStructures={toggleStructures}
          roadsEnabled={roadsEnabled}
          roadsLoading={roadsLoading}
          onToggleRoads={toggleRoads}
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
