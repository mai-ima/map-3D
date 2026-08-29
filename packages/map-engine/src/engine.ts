/**
 * MapEngine — CesiumJS のラッパ。
 *
 * アプリの他の層（UI / navigation / ai）は Cesium を直接触らず、このクラス越しに操作する。
 * これにより将来レンダラを差し替えても影響範囲が閉じる。
 */

import * as Cesium from 'cesium';
import type { City, District, ElevatedStructure, LatLng, Poi, Route } from '@ijm/shared';
import { PLATEAU_TERRAIN_URL, bboxAround, bboxExpand, getDefaultCity } from '@ijm/shared';
import { DEFAULT_IMAGERY_ID, GSI_IMAGERY, categoryIcon, getImagery } from '@ijm/gis';
import {
  NavigationSession,
  type NavigationSessionOptions,
  type NavigationTickResult,
} from '@ijm/navigation';
import { BuildingLayerManager, type OptionalLayerId } from './buildings';
import { ElevatedStructureLayer } from './elevated-structures';
import { EnvironmentController, type WeatherKind } from './environment';
import { HealthMonitor, type HealthEvent } from './health-monitor';
import { RouteLayer } from './route-layer';
import { StreetFurnitureLayer, type FurniturePoint } from './street-furniture';
import {
  MemoryWatchdog,
  PerformanceWatchdog,
  adaptiveScreenSpaceError,
  computeResolutionScale,
  degradeTier,
  detectDevice,
  forceDegradeTier,
  getQualitySettings,
  resolveMemoryBudget,
  selectQualityTier,
  type DeviceInfo,
  type MemoryPressureReport,
  type QualitySettings,
  type QualityTier,
} from './quality';

export interface MapEngineOptions {
  container: HTMLElement;
  city?: City;
  imageryId?: string;
  terrainUrl?: string;
  /** 明示的に品質ティアを指定する（未指定なら自動判定） */
  qualityTier?: QualityTier;
  /** Cesium ion を使う場合のみ設定（未設定でも全機能が動く） */
  ionToken?: string;
  onNavigationTick?: (result: NavigationTickResult) => void;
  onQualityChange?: (settings: QualitySettings) => void;
  onCameraInteraction?: () => void;
  /** メモリ逼迫で自動的に品質を下げたときに通知する */
  onMemoryPressure?: (report: MemoryPressureReport) => void;
  /**
   * WebGL コンテキストが失われた / 復帰したときに通知する。
   * ブラウザが GPU リソースを回収した状態で、放置すると画面が固まったように見える。
   */
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export interface CameraTarget {
  position: LatLng;
  /** 対地高度 (m) */
  height?: number;
  heading?: number;
  pitch?: number;
  /** 移動にかける秒数。0 で即時 */
  duration?: number;
}

/**
 * 実機での挙動を確かめるための診断情報。
 * クラッシュの再現条件は端末とネットワークに強く依存するため、
 * 実際に動かしている環境で数値を見られるようにしておく。
 */
export interface EngineDiagnostics {
  tier: QualityTier;
  /** プリセット上の精細度 */
  baseScreenSpaceError: number;
  /** カメラ高度に応じて実際に適用されている精細度 */
  appliedScreenSpaceError: number;
  /** メモリ逼迫で上乗せされた係数 */
  detailPenalty: number;
  cameraHeightM: number;
  viewDistanceM: number;
  resolutionScale: number;
  /** 3D Tiles が使っているメモリ */
  tileMemoryMb: number;
  cacheLimitMb: number;
  /** JS ヒープ（Chromium 系のみ取得できる） */
  heapUsedMb: number | null;
  heapLimitMb: number | null;
  fps: number;
  /**
   * 静止中は描画自体をしていない（requestRenderMode）。
   * このとき FPS が 0 になるのは正常で、性能不足とは意味が違う。
   */
  idle: boolean;
  farTilesetLoaded: boolean;
  /** 読み込み待ちのタイル数（多いほど GPU アップロードが集中する） */
  loadQueue: number;
  shadows: boolean;
  hdr: boolean;
  msaaSamples: number;
  /** 実行中に起きた異常の要約（何も起きていなければ null） */
  healthSummary: string | null;
  recentIssues: HealthEvent[];
}

export interface BuildingPickResult {
  position: LatLng;
  attributes: Record<string, unknown>;
}

/** SceneTransforms のバージョン差を吸収する */
function worldToWindow(
  scene: Cesium.Scene,
  position: Cesium.Cartesian3,
): Cesium.Cartesian2 | undefined {
  const transforms = Cesium.SceneTransforms as unknown as Record<string, unknown>;
  const fn =
    (transforms.worldToWindowCoordinates as typeof Cesium.SceneTransforms.worldToWindowCoordinates) ??
    (transforms.wgs84ToWindowCoordinates as typeof Cesium.SceneTransforms.worldToWindowCoordinates);
  return fn ? fn(scene, position) : undefined;
}

/**
 * 精細度を変更してよい最短間隔。
 *
 * 精細度の変更はタイルツリーの再評価を伴うので、頻繁にやると
 * 読み込みと破棄を繰り返して一向に安定しない。
 */
const SSE_CHANGE_INTERVAL_MS = 1500;

export class MapEngine {
  readonly viewer: Cesium.Viewer;
  readonly buildings: BuildingLayerManager;
  readonly routeLayer: RouteLayer;
  readonly environment: EnvironmentController;
  readonly furniture: StreetFurnitureLayer;
  readonly structures: ElevatedStructureLayer;

  private quality: QualitySettings;
  private qualityTier: QualityTier;
  private device: DeviceInfo;
  private watchdog: PerformanceWatchdog;
  private memoryWatchdog: MemoryWatchdog;
  private memoryReliefStep = 0;
  private removeContextListeners: (() => void) | null = null;
  private removeMemoryMonitor: (() => void) | null = null;
  private removeErrorListeners: (() => void)[] = [];
  readonly health = new HealthMonitor();
  private lastMemoryCheck = 0;
  private lastAdaptiveSse = 0;
  private lastSseChangeAt = 0;
  private fps = 0;
  private fpsLastSample = 0;
  private fpsFrames = 0;
  /** メモリ逼迫で上乗せする精細度の係数（1 = そのまま） */
  private detailPenalty = 1;
  private session: NavigationSession | null = null;
  private navigating = false;
  private useRealPosition = false;
  private lastGeolocation: LatLng | null = null;
  private imageryLayer: Cesium.ImageryLayer | null = null;
  private removePreRender: (() => void) | null = null;
  private occlusionFrame = 0;
  private destroyed = false;

  constructor(private readonly options: MapEngineOptions) {
    this.device = detectDevice();
    this.qualityTier = options.qualityTier ?? selectQualityTier(this.device);
    // 端末の搭載メモリを見てキャッシュ上限を絞る（タブのクラッシュ対策）
    this.quality = resolveMemoryBudget(getQualitySettings(this.qualityTier), this.device);

    if (options.ionToken) {
      Cesium.Ion.defaultAccessToken = options.ionToken;
    } else {
      // ion を使わない構成。既定トークンによる不要なリクエストを避ける。
      Cesium.Ion.defaultAccessToken = '';
    }

    // 同時リクエストが多すぎると、復号待ちのタイルがメモリ上に積み上がる。
    // 回線が速いほど積み上がりやすいので、上限を絞って流量を平準化する。
    // iOS は 1 フレームの描画コマンド量に上限があり、超えると WebGL
    // コンテキストごと失われる。同時に読み込むタイルを減らして流量を平準化する。
    Cesium.RequestScheduler.maximumRequests = this.device.isIOS ? 6 : this.device.isMobile ? 12 : 18;
    Cesium.RequestScheduler.maximumRequestsPerServer = this.device.isIOS
      ? 4
      : this.device.isMobile
        ? 6
        : 8;
    Cesium.RequestScheduler.throttleRequests = true;

    const imagery = getImagery(options.imageryId ?? DEFAULT_IMAGERY_ID);

    this.viewer = new Cesium.Viewer(options.container, {
      baseLayer: new Cesium.ImageryLayer(
        new Cesium.UrlTemplateImageryProvider({
          url: imagery.urlTemplate,
          maximumLevel: imagery.maximumLevel,
          credit: new Cesium.Credit(imagery.attribution, false),
        }),
      ),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      msaaSamples: this.quality.msaaSamples,
      useBrowserRecommendedResolution: false,
      requestRenderMode: true,
      maximumRenderTimeChange: 0.5,
      contextOptions: {
        // WebGL2 が既定（requestWebgl1 を立てない限り WebGL2 が使われる）
        webgl: {
          alpha: false,
          antialias: false,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: false,
          failIfMajorPerformanceCaveat: false,
        },
      },
    });

    this.imageryLayer = this.viewer.imageryLayers.get(0) ?? null;

    // iPhone の Retina 解像度を活かす。ただし描画バッファの総ピクセル数には上限を設ける
    // （大画面 × 高 DPR で MSAA/HDR の中間バッファが膨らみ、メモリ超過でタブが落ちるため）
    this.applyResolutionScale();

    this.applyGlobeQuality();
    this.applyViewDistance();
    // 地形との衝突判定はカメラ操作のたびに交差計算が走る。低性能な端末では切る
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection =
      this.quality.terrainCollision;
    // 地表付近まで寄れるようにする（街を歩く体験のため）
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2;
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 5_000_000;
    this.viewer.scene.screenSpaceCameraController.inertiaSpin = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaTranslate = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaZoom = 0.8;

    this.buildings = new BuildingLayerManager(this.viewer, this.quality);
    this.buildings.onTileFailed = (detail) => this.health.record('tile-failed', detail);
    this.routeLayer = new RouteLayer(this.viewer);
    this.environment = new EnvironmentController(this.viewer, this.quality);
    this.furniture = new StreetFurnitureLayer(this.viewer, this.quality.maxFurniture);
    this.structures = new ElevatedStructureLayer(this.viewer);

    this.watchdog = new PerformanceWatchdog(
      () => this.degradeQuality(),
      28,
      180,
      this.qualityTier !== 'ios-high',
    );

    // メモリ監視は iOS でも必ず動かす。
    // 「品質を落とさない」という方針より、タブごと落ちないことを優先する。
    this.memoryWatchdog = new MemoryWatchdog(
      (report) => this.relieveMemoryPressure(report),
      this.quality.cacheBytes,
    );

    this.setupContextLossHandlers();
    this.setupErrorMonitor();
    this.setupMemoryMonitor();
    this.setupInteractionHandlers();
    void this.initialize(options);
  }

  private async initialize(options: MapEngineOptions): Promise<void> {
    const city = options.city ?? getDefaultCity();

    // 先にカメラを目的の街へ移動させる。
    // 地形や建物の取得を待ってから動かすと、回線が遅いときや取得に失敗したときに
    // 地球を遠くから見たままの画面で止まってしまう。
    // カメラ位置が決まっていれば、Cesium は必要な範囲のタイルだけを取りにいく。
    this.flyTo({
      position: city.center,
      height: city.initialHeight,
      pitch: -35,
      duration: 0,
    });

    await this.setTerrain(options.terrainUrl ?? PLATEAU_TERRAIN_URL);

    // 建物タイルセットが落ちていても、地形・ベースマップ・ルート表示は成立させる
    try {
      await this.loadCity(city);
    } catch (error) {
      console.warn('[map-engine] 3D 建物データの読み込みに失敗しました', error);
      this.health.record(
        'tile-failed',
        `建物データを取得できません: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  // ---- 基本設定 --------------------------------------------------------

  async setTerrain(url: string): Promise<void> {
    try {
      const provider = await Cesium.CesiumTerrainProvider.fromUrl(url, {
        requestVertexNormals: true,
      });
      if (this.destroyed) return;
      this.viewer.terrainProvider = provider;
    } catch (e) {
      // 地形が取れなくても、建物とルートは表示できる
      console.warn('[map-engine] 地形の読み込みに失敗しました。楕円体で表示します。', e);
      this.health.record('tile-failed', `地形を取得できません: ${(e as Error)?.message ?? e}`);
      this.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    this.watchProviderErrors();
    this.requestRender();
  }

  setImagery(id: string): void {
    const imagery = getImagery(id);
    const layers = this.viewer.imageryLayers;
    if (this.imageryLayer) layers.remove(this.imageryLayer, true);
    this.imageryLayer = layers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: imagery.urlTemplate,
        maximumLevel: imagery.maximumLevel,
        credit: new Cesium.Credit(imagery.attribution, false),
      }),
      0,
    );
    this.watchProviderErrors();
    this.requestRender();
  }

  get availableImagery(): typeof GSI_IMAGERY {
    return GSI_IMAGERY;
  }

  async loadCity(city: City): Promise<void> {
    await this.buildings.loadCity(city);
    this.furniture.clear();
    this.requestRender();
  }

  get currentCity(): City | null {
    return this.buildings.currentCity;
  }

  // ---- 品質 ------------------------------------------------------------

  get qualitySettings(): QualitySettings {
    return { ...this.quality };
  }

  setQualityTier(tier: QualityTier): void {
    this.qualityTier = tier;
    this.quality = resolveMemoryBudget(getQualitySettings(tier), this.device);
    this.memoryWatchdog.setBudget(this.quality.cacheBytes);
    this.viewer.scene.msaaSamples = this.quality.msaaSamples;
    this.applyResolutionScale();
    this.applyGlobeQuality();
    this.applyViewDistance();
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection =
      this.quality.terrainCollision;
    this.viewer.shadows = this.quality.shadows;
    this.viewer.scene.postProcessStages.fxaa.enabled = this.quality.fxaa;
    this.buildings.updateQuality(this.quality);
    this.furniture.setMaxItems(this.quality.maxFurniture);
    this.options.onQualityChange?.(this.quality);
    this.requestRender();
  }

  /**
   * 描画距離を制限する。
   *
   * Cesium の既定 far は事実上無制限で、地平線までのタイルがすべて読み込み対象になる。
   * 3D Tiles のキャッシュ上限は「視界に不要なタイル」しか切り詰めないため、
   * 視界そのものを絞らないとメモリ使用量は下がらない。
   * 遠方は霧で減衰しているので、切っても見た目の違和感は出ない。
   */
  private applyViewDistance(): void {
    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.far = this.quality.viewDistance;
    }
  }

  /**
   * 追加レイヤ（LOD3 詳細・橋梁・都市設備・植生）の表示を切り替える。
   * 整備されていない範囲では false を返す（異常ではなく、単に重ねられない）。
   */
  async setOptionalLayer(id: OptionalLayerId, enabled: boolean): Promise<boolean> {
    if (!enabled) {
      this.buildings.disableLayer(id);
      this.requestRender();
      return false;
    }
    const ok = await this.buildings.enableLayer(id);
    this.requestRender();
    return ok;
  }

  isOptionalLayerEnabled(id: OptionalLayerId): boolean {
    return this.buildings.isLayerEnabled(id);
  }

  /**
   * 高架・橋梁を立体で描く。
   *
   * PLATEAU の橋梁モデルが無い地域では、街の骨格である高架がまったく見えず
   * 道路が地面に張り付いたままになる。OSM の bridge / layer から補う。
   */
  async showElevatedStructures(structures: ElevatedStructure[], key: string): Promise<void> {
    await this.structures.render(structures, key);
    this.requestRender();
  }

  clearElevatedStructures(): void {
    this.structures.clear();
    this.requestRender();
  }

  /** 端末判定による既定のティア（手動指定から「自動」に戻すときに使う） */
  get autoQualityTier(): QualityTier {
    return selectQualityTier(this.device);
  }

  /** 実機での挙動を確認するための現在値 */
  getDiagnostics(): EngineDiagnostics {
    const heap = MemoryWatchdog.readHeap();
    const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
    return {
      tier: this.qualityTier,
      baseScreenSpaceError: this.quality.screenSpaceError,
      appliedScreenSpaceError: this.lastAdaptiveSse || this.quality.screenSpaceError,
      detailPenalty: Math.round(this.detailPenalty * 100) / 100,
      cameraHeightM: Math.round(this.viewer.camera.positionCartographic?.height ?? 0),
      viewDistanceM: this.quality.viewDistance,
      resolutionScale: Math.round(this.viewer.resolutionScale * 100) / 100,
      tileMemoryMb: toMb(this.buildings.totalMemoryUsageInBytes),
      cacheLimitMb: toMb(this.quality.cacheBytes),
      heapUsedMb: heap ? toMb(heap.used) : null,
      heapLimitMb: heap ? toMb(heap.limit) : null,
      fps: this.fps,
      idle: this.fps === 0 && this.viewer.scene.requestRenderMode && !this.navigating,
      farTilesetLoaded: this.buildings.tilesets.length > 1,
      loadQueue: this.buildings.loadQueueLength,
      shadows: this.quality.shadows,
      hdr: this.quality.hdr,
      msaaSamples: this.quality.msaaSamples,
      healthSummary: this.health.describe(),
      recentIssues: this.health.recent.slice(0, 5),
    };
  }

  /** 地形・ベースマップ側のメモリ設定を反映する */
  private applyGlobeQuality(): void {
    const globe = this.viewer.scene.globe;
    globe.maximumScreenSpaceError = this.quality.globeScreenSpaceError;
    globe.tileCacheSize = this.quality.globeTileCacheSize;
    // 画面外の地形タイルを保持しない
    globe.preloadSiblings = false;
    // 半透明の順序保証は中間バッファを増やす。建物は不透明が主なので無効化する
    // （Cesium のバージョンによっては読み取り専用なので、存在確認してから触る）
    const oit = (
      this.viewer.scene as unknown as { orderIndependentTranslucency?: boolean }
    );
    try {
      oit.orderIndependentTranslucency = false;
    } catch {
      /* 未対応バージョンでは既定のまま使う */
    }
  }

  /** 画面サイズと DPR から描画解像度を決める（総ピクセル数で頭打ちにする） */
  private applyResolutionScale(): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const canvas = this.viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    this.viewer.resolutionScale = computeResolutionScale(this.quality, width, height, dpr);
  }

  /**
   * メモリ逼迫時の段階的な退避。
   *
   * いきなり品質ティアを落とすと見た目が大きく変わるため、影響の小さい順に手を打つ。
   *   1) 画面外タイルの解放＋キャッシュ縮小
   *   2) 遠景タイルセットの破棄（近景の街並みは残る）
   *   3) 重いポストプロセス（HDR・環境光遮蔽・ブルーム）を切る
   *   4) 精細度（SSE）を上げる
   *   5) 最後に品質ティアを 1 段階下げる
   */
  private relieveMemoryPressure(report: MemoryPressureReport): void {
    this.health.record(
      'memory-pressure',
      `タイル ${(report.tileBytes / 1024 / 1024).toFixed(0)}MB / ${report.level}`,
    );
    this.options.onMemoryPressure?.(report);
    const step = report.level === 'critical' ? this.memoryReliefStep + 1 : this.memoryReliefStep;
    this.memoryReliefStep = Math.min(step + 1, 5);

    switch (this.memoryReliefStep) {
      case 1:
        this.buildings.relieveMemoryPressure(0.7);
        break;
      case 2:
        this.buildings.relieveMemoryPressure(0.6);
        if (!this.buildings.dropFarTileset()) this.memoryReliefStep = 3;
        break;
      case 3:
        // HDR・環境光遮蔽・ブルームは画面サイズの中間バッファを何枚も持つ。
        // 画面が大きいほど効くので、精細度より先にこちらを切る
        this.environment.setHeavyEffectsEnabled(false);
        this.buildings.relieveMemoryPressure(0.6);
        break;

      case 4:
        // 視界内に必要なタイルはキャッシュ上限では減らせないので、精細度そのものを落とす
        this.detailPenalty = Math.min(4, this.detailPenalty * 1.8);
        this.lastAdaptiveSse = 0;
        this.updateAdaptiveDetail();
        this.buildings.relieveMemoryPressure(0.6);
        break;
      default:
        this.detailPenalty = Math.min(6, this.detailPenalty * 1.5);
        this.lastAdaptiveSse = 0;
        this.buildings.relieveMemoryPressure(0.5);
        this.degradeQuality(true);
        break;
    }

    console.warn(
      `[map-engine] メモリ使用量が上限に近づいたため描画負荷を下げました (段階 ${this.memoryReliefStep}/5, タイル ${(report.tileBytes / 1024 / 1024).toFixed(0)}MB)`,
    );
    this.requestRender();
  }

  /**
   * Cesium が内部で処理する異常を拾って記録する。
   *
   * 描画エラーもタイルの取得失敗も、既定では握りつぶされて画面には出ない。
   * そのため「なんとなく動かない」という状態になりやすい。
   * 記録しておけば、実機で何が起きているか数字で確認できる。
   */
  private setupErrorMonitor(): void {
    const scene = this.viewer.scene;

    // 描画エラー。既定では例外を投げずに継続するので、ここで記録だけする
    const removeRender = scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
      this.health.record('render-error', (error as Error)?.message ?? String(error));
    });
    this.removeErrorListeners.push(removeRender);

    // 地形の取得失敗。地形が出ないと建物が宙に浮くので、無視できない
    this.watchProviderErrors();
  }

  /**
   * 地形とベースマップの取得失敗を記録する。
   *
   * これらが取れないと「建物だけが宙に浮く」「地面が真っ黒」といった
   * 分かりにくい壊れ方をする。プロバイダを差し替えるたびに登録し直す。
   */
  private watchProviderErrors(): void {
    const terrain = this.viewer.terrainProvider as unknown as {
      errorEvent?: { addEventListener: (cb: (e: unknown) => void) => () => void };
    };
    if (terrain?.errorEvent) {
      this.removeErrorListeners.push(
        terrain.errorEvent.addEventListener((e: unknown) => {
          this.health.record('tile-failed', `地形: ${(e as Error)?.message ?? String(e)}`);
        }),
      );
    }

    const imagery = this.imageryLayer?.imageryProvider as unknown as {
      errorEvent?: { addEventListener: (cb: (e: unknown) => void) => () => void };
    };
    if (imagery?.errorEvent) {
      this.removeErrorListeners.push(
        imagery.errorEvent.addEventListener((e: unknown) => {
          this.health.record('tile-failed', `地図: ${(e as Error)?.message ?? String(e)}`);
        }),
      );
    }
  }

  /**
   * ナビ中かどうかに関わらず、常にメモリ使用量を見張る。
   * 街を眺めているだけでも 3D Tiles は読み込まれ続けるため、監視は常時必要。
   */
  private setupMemoryMonitor(): void {
    const remove = this.viewer.scene.postRender.addEventListener(() => {
      const now = Date.now();
      this.health.frame(now);
      this.fpsFrames += 1;
      if (now - this.fpsLastSample >= 1000) {
        this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLastSample));
        this.fpsFrames = 0;
        this.fpsLastSample = now;
      }
      if (now - this.lastMemoryCheck < 500) return;
      this.lastMemoryCheck = now;
      this.updateAdaptiveDetail();
      this.followCameraForBuildings();
      this.memoryWatchdog.check(this.buildings.totalMemoryUsageInBytes, now);
      // ナビ中は連続描画しているはずなので、止まっていたら異常
      if (this.navigating) this.health.checkStall(now);
    });
    this.removeMemoryMonitor = remove;
  }

  /**
   * カメラ高度に応じて近景タイルセットの精細度を切り替える。
   *
   * 上空から街全体を見ているときは視界に入る建物が桁違いに多く、
   * 地上と同じ精細度で読み込むと視界内タイルだけでメモリを使い切ってしまう。
   * 高いところでは遠景タイルセット（LOD1）が街並みを担うので、
   * 近景（LOD2）は粗くしてよい。
   */
  private updateAdaptiveDetail(): void {
    const height = this.viewer.camera.positionCartographic?.height;
    if (!Number.isFinite(height)) return;

    const target = Math.min(
      96,
      Math.round(adaptiveScreenSpaceError(this.quality.screenSpaceError, height) * this.detailPenalty),
    );

    // 精細度を変えると Cesium はタイルツリーを再評価し、読み込みと破棄が走る。
    // 小さな差で書き換えると「読み込み待ちが増える → 粗くする → 破棄されて待ちが減る →
    // 細かくする」という振動に陥り、いつまでも読み込みが終わらなくなる。
    // そのため、はっきり差が出たときだけ、しかも一定時間を空けて反映する。
    const now = Date.now();
    const changed = Math.abs(target - this.lastAdaptiveSse) / Math.max(1, this.lastAdaptiveSse);
    if (changed < 0.2) return;
    if (now - this.lastSseChangeAt < SSE_CHANGE_INTERVAL_MS) return;

    this.lastSseChangeAt = now;
    this.lastAdaptiveSse = target;
    this.buildings.setNearScreenSpaceError(target);
  }

  /**
   * カメラの移動に合わせて、近景の建物データの読み込み範囲を追従させる。
   * 一度に読むのはカメラ周辺だけなので、移動したら読み直す必要がある。
   */
  private followCameraForBuildings(): void {
    // getViewCenter() は画面中心から地形へレイを飛ばすため、地形メッシュとの
    // 交差計算が入る。読み込み範囲の判定にはカメラ直下の座標で十分なので、
    // 交差計算を伴わない positionCartographic を使う。
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return;
    void this.buildings.refreshForCamera({
      lat: Cesium.Math.toDegrees(carto.latitude),
      lng: Cesium.Math.toDegrees(carto.longitude),
    });
  }

  /**
   * WebGL コンテキストの喪失に備える。
   *
   * メモリ超過やドライバのリセットでコンテキストが失われると、既定では
   * 画面が固まったまま何も起きない。preventDefault を呼んでおくと復帰イベントを
   * 受け取れるので、UI 側に通知して復旧できるようにする。
   */
  private setupContextLossHandlers(): void {
    const canvas = this.viewer.scene.canvas;
    const onLost = (event: Event): void => {
      // 既定動作を止めないと restored が発火しない
      event.preventDefault();
      console.warn('[map-engine] WebGL コンテキストが失われました');
      this.health.record('context-lost', 'GPU リソースが回収されました');
      this.options.onContextLost?.();
    };
    const onRestored = (): void => {
      console.info('[map-engine] WebGL コンテキストが復帰しました');
      this.health.record('context-restored', '描画を再開しました');
      this.options.onContextRestored?.();
      this.requestRender();
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    this.removeContextListeners = () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }

  private degradeQuality(force = false): void {
    // メモリ起因のときは iOS でも下げる（force）。それ以外は要件どおり iOS を維持する
    const next = force ? forceDegradeTier(this.qualityTier) : degradeTier(this.qualityTier);
    if (next === this.qualityTier) return;
    console.info(`[map-engine] 描画性能が不足しているため品質を ${next} に下げます`);
    this.health.record('quality-degraded', `${this.qualityTier} → ${next}`);
    this.setQualityTier(next);
  }

  // ---- カメラ ----------------------------------------------------------

  private setupInteractionHandlers(): void {
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    const onInteract = (): void => {
      this.options.onCameraInteraction?.();
      if (this.navigating) this.session?.camera.enterFreeLook();
    };
    handler.setInputAction(onInteract, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onInteract, Cesium.ScreenSpaceEventType.RIGHT_DOWN);
    handler.setInputAction(onInteract, Cesium.ScreenSpaceEventType.MIDDLE_DOWN);
    handler.setInputAction(onInteract, Cesium.ScreenSpaceEventType.WHEEL);
    handler.setInputAction(onInteract, Cesium.ScreenSpaceEventType.PINCH_START);
  }

  /** 地形の標高（読み込み済みタイルからの近似値） */
  groundHeightAt(position: LatLng): number {
    const carto = Cesium.Cartographic.fromDegrees(position.lng, position.lat);
    const height = this.viewer.scene.globe.getHeight(carto);
    return Number.isFinite(height) ? (height as number) : 0;
  }

  flyTo(target: CameraTarget): void {
    const ground = this.groundHeightAt(target.position);
    const destination = Cesium.Cartesian3.fromDegrees(
      target.position.lng,
      target.position.lat,
      ground + (target.height ?? 600),
    );
    const orientation = {
      heading: Cesium.Math.toRadians(target.heading ?? 0),
      pitch: Cesium.Math.toRadians(target.pitch ?? -45),
      roll: 0,
    };

    if ((target.duration ?? 1.6) <= 0) {
      this.viewer.camera.setView({ destination, orientation });
    } else {
      this.viewer.camera.flyTo({
        destination,
        orientation,
        duration: target.duration ?? 1.6,
      });
    }
    this.requestRender();
  }

  flyToDistrict(district: District): void {
    this.flyTo({
      position: district.center,
      height: district.height,
      heading: district.heading ?? 0,
      pitch: -40,
      duration: 2.0,
    });
  }

  /** 現在のカメラ状態（AI に渡す地図コンテキスト用） */
  getCameraState(): {
    center: LatLng;
    height: number;
    heading: number;
    pitch: number;
  } {
    const camera = this.viewer.camera;
    const carto = Cesium.Cartographic.fromCartesian(camera.positionWC);
    return {
      center: {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lng: Cesium.Math.toDegrees(carto.longitude),
      },
      height: carto.height,
      heading: Cesium.Math.toDegrees(camera.heading),
      pitch: Cesium.Math.toDegrees(camera.pitch),
    };
  }

  /** 画面中心の地表座標（周辺検索の基準に使う） */
  getViewCenter(): LatLng {
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = this.viewer.camera.getPickRay(center);
    const position = ray ? scene.globe.pick(ray, scene) : undefined;
    if (position) {
      const carto = Cesium.Cartographic.fromCartesian(position);
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lng: Cesium.Math.toDegrees(carto.longitude),
      };
    }
    return this.getCameraState().center;
  }

  /** 画面上の座標から地表の緯度経度を得る（クリックで地点指定） */
  pickPosition(windowPosition: Cesium.Cartesian2): LatLng | null {
    const scene = this.viewer.scene;
    // まず建物・地形の表面（深度バッファ）を試し、外れたら地球儀との交点で補う
    let cartesian: Cesium.Cartesian3 | undefined = scene.pickPosition(windowPosition);
    if (!Cesium.defined(cartesian)) {
      const ray = this.viewer.camera.getPickRay(windowPosition);
      cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
    }
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lng: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  /** 建物のクリック情報（PLATEAU feature 属性 + 座標） */
  pickBuilding(windowPosition: Cesium.Cartesian2): BuildingPickResult | null {
    const picked = this.viewer.scene.pick(windowPosition);
    const position = this.pickPosition(windowPosition);
    if (!position) return null;
    if (picked instanceof Cesium.Cesium3DTileFeature) {
      return { position, attributes: BuildingLayerManager.readFeature(picked) };
    }
    return { position, attributes: {} };
  }

  // ---- ルート表示 ------------------------------------------------------

  async showRoute(route: Route, fit = true): Promise<void> {
    await this.routeLayer.showRoute(route);
    if (fit) this.fitRoute(route);
    this.requestRender();
  }

  fitRoute(route: Route): void {
    const [minLng, minLat, maxLng, maxLat] = route.bbox;
    this.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(minLng, minLat, maxLng, maxLat),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 1.8,
    });
    this.requestRender();
  }

  clearRoute(): void {
    this.stopNavigation();
    this.routeLayer.clearRoute();
    this.requestRender();
  }

  showPois(pois: Poi[]): void {
    this.routeLayer.showPois(pois, (poi) => categoryIcon(poi.category));
    this.requestRender();
  }

  clearPois(): void {
    this.routeLayer.clearPois();
    this.requestRender();
  }

  // ---- 装飾（街路樹・街灯） -------------------------------------------

  async loadStreetFurniture(points: FurniturePoint[], bbox: [number, number, number, number]): Promise<void> {
    if (this.quality.maxFurniture <= 0) return;
    if (this.furniture.hasLoaded(bbox)) return;
    await this.furniture.build(points, bbox);
    this.requestRender();
  }

  // ---- ナビゲーション --------------------------------------------------

  get isNavigating(): boolean {
    return this.navigating;
  }

  /**
   * ナビゲーション開始。
   * @param useRealPosition true なら Geolocation の実測値を使う。false はデモ走行。
   */
  startNavigation(
    route: Route,
    options: NavigationSessionOptions & { useRealPosition?: boolean } = {},
  ): void {
    this.stopNavigation();
    this.session = new NavigationSession(route, options);
    this.navigating = true;
    this.useRealPosition = options.useRealPosition ?? false;

    // ナビ中は連続描画（requestRenderMode を解除）
    this.viewer.scene.requestRenderMode = false;

    if (this.useRealPosition && typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchGeolocation();
    }

    this.removePreRender = this.viewer.scene.preRender.addEventListener(() => {
      this.onNavigationFrame();
    });
  }

  private geolocationWatchId: number | null = null;

  private watchGeolocation(): void {
    this.geolocationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.lastGeolocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      },
      () => {
        // 位置情報が取れない場合はシミュレーションに切り替える
        this.useRealPosition = false;
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );
  }

  private onNavigationFrame(): void {
    if (!this.session || !this.navigating) return;
    const now = performance.now();
    this.watchdog.frame(now);

    const result = this.session.tick(
      now,
      this.useRealPosition && this.lastGeolocation ? this.lastGeolocation : undefined,
    );

    this.applyCameraPose(result);
    this.routeLayer.updatePosition(result.progress.position, result.progress.heading);

    // 交差点ハイライト
    if (result.camera.highlightIntersection && result.outlook.next) {
      this.routeLayer.highlightIntersection(result.outlook.next.location, 22);
    } else {
      this.routeLayer.highlightIntersection(null);
    }

    // 建物の透過は毎フレームだと重いので数フレームに 1 回
    this.occlusionFrame++;
    if (result.camera.buildingTransparency) {
      if (this.occlusionFrame % 6 === 0) this.updateBuildingTransparency(result);
    } else if (this.occlusionFrame % 30 === 0) {
      this.buildings.restoreAll();
    }

    this.options.onNavigationTick?.(result);

    if (result.progress.arrived) {
      this.navigating = false;
      // 到着後もカメラの余韻を残すため、少し遅らせて停止する
      setTimeout(() => this.stopNavigation(false), 2500);
    }
  }

  private applyCameraPose(result: NavigationTickResult): void {
    if (result.camera.state === 'FREE_LOOK') return;

    const pose = result.camera.pose;
    const groundHeight = this.groundHeightAt({ lat: pose.target.lat, lng: pose.target.lng });

    // 注視点の後方・上方にカメラを置く
    const back = (pose.heading + 180) % 360;
    const rad = Cesium.Math.toRadians(back);
    const dLat = (pose.range * Math.cos(rad)) / 110540;
    const dLng =
      (pose.range * Math.sin(rad)) /
      (111320 * Math.max(0.01, Math.cos(Cesium.Math.toRadians(pose.target.lat))));

    const cameraLat = pose.target.lat + dLat;
    const cameraLng = pose.target.lng + dLng;
    const cameraGround = this.groundHeightAt({ lat: cameraLat, lng: cameraLng });
    const cameraHeight = Math.max(cameraGround + 4, groundHeight + pose.height);

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(cameraLng, cameraLat, cameraHeight),
      orientation: {
        heading: Cesium.Math.toRadians(pose.heading),
        pitch: Cesium.Math.toRadians(pose.pitch),
        roll: 0,
      },
    });

    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      frustum.fov = Cesium.Math.toRadians(pose.fov);
    }
  }

  /**
   * 進路（現在地 → 次のマニューバ）を隠している建物のみ半透明にする。
   * 線分上の数点を画面座標に投影して drillPick する。
   */
  private updateBuildingTransparency(result: NavigationTickResult): void {
    const next = result.outlook.next;
    if (!next) {
      this.buildings.restoreAll();
      return;
    }

    const scene = this.viewer.scene;
    const from = result.progress.position;
    const to = next.location;
    const points: Cesium.Cartesian2[] = [];

    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      const lat = from.lat + (to.lat - from.lat) * t;
      const lng = from.lng + (to.lng - from.lng) * t;
      const ground = this.groundHeightAt({ lat, lng });
      const world = Cesium.Cartesian3.fromDegrees(lng, lat, ground + 2.5);
      const window = worldToWindow(scene, world);
      if (window) points.push(window);
    }

    this.buildings.applyOcclusionTransparency(points, 0.22);
  }

  /** ルート上の位置へジャンプ（スクラブ） */
  seekNavigation(distanceAlong: number): void {
    this.session?.seek(distanceAlong);
  }

  resumeFollow(): void {
    this.session?.camera.exitFreeLook();
  }

  stopNavigation(clearMarkers = true): void {
    if (this.removePreRender) {
      this.removePreRender();
      this.removePreRender = null;
    }
    if (this.geolocationWatchId !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(this.geolocationWatchId);
      this.geolocationWatchId = null;
    }
    this.navigating = false;
    this.session = null;
    this.buildings.restoreAll();
    this.routeLayer.highlightIntersection(null);
    if (clearMarkers) this.routeLayer.hidePosition();

    // 静止時は省電力のため再描画要求モードへ戻す
    this.viewer.scene.requestRenderMode = true;
    this.requestRender();
  }

  // ---- 環境 ------------------------------------------------------------

  setTimeOfDay(hour: number): void {
    this.environment.setTime(hour);
    this.requestRender();
  }

  setFollowRealTime(follow: boolean): void {
    this.environment.setFollowRealTime(follow);
    this.requestRender();
  }

  setWeather(weather: WeatherKind): void {
    this.environment.setWeather(weather);
    this.requestRender();
  }

  // ---- その他 ----------------------------------------------------------

  /** 現在のビューの bbox（POI や街路樹の取得範囲に使う） */
  getViewBBox(marginMeters = 0): [number, number, number, number] | null {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const bbox: [number, number, number, number] = [
      Cesium.Math.toDegrees(rect.west),
      Cesium.Math.toDegrees(rect.south),
      Cesium.Math.toDegrees(rect.east),
      Cesium.Math.toDegrees(rect.north),
    ];
    return marginMeters > 0 ? bboxExpand(bbox, marginMeters) : bbox;
  }

  /**
   * 周辺データ（高架・街路樹など）を要求するための範囲。
   *
   * 画面に映っている範囲そのもの（computeViewRectangle）は、斜め見下ろしだと
   * 描画距離いっぱいまで広がって数十 km 四方になることがあり、
   * OSM 系の API が受け付ける上限を超えてしまう。
   * カメラ直下から一定半径に切り、確実に取得できる大きさにする。
   */
  getSurroundingBBox(radiusMeters = 1500): [number, number, number, number] | null {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    return bboxAround(
      {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lng: Cesium.Math.toDegrees(carto.longitude),
      },
      radiusMeters,
    );
  }

  requestRender(): void {
    if (!this.destroyed) this.viewer.scene.requestRender();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopNavigation();
    this.removeContextListeners?.();
    this.removeContextListeners = null;
    this.removeMemoryMonitor?.();
    this.removeMemoryMonitor = null;
    for (const remove of this.removeErrorListeners) remove();
    this.removeErrorListeners = [];
    this.structures.clear();
    this.environment.destroy();
    this.furniture.clear();
    this.buildings.unload();
    this.routeLayer.clearAll();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
