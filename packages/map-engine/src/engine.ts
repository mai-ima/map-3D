/**
 * MapEngine — CesiumJS のラッパ。
 *
 * アプリの他の層（UI / navigation / ai）は Cesium を直接触らず、このクラス越しに操作する。
 * これにより将来レンダラを差し替えても影響範囲が閉じる。
 */

import * as Cesium from 'cesium';
import type {
  BBox,
  BuildingModelMode,
  City,
  District,
  ElevatedStructure,
  LatLng,
  Poi,
  Route,
  SceneShape,
} from '@ijm/shared';
import {
  PLATEAU_TERRAIN_URL,
  bboxAround,
  bboxExpand,
  distanceMeters,
  getDefaultCity,
} from '@ijm/shared';
import {
  DEFAULT_IMAGERY_ID,
  GSI_IMAGERY,
  categoryIcon,
  buildIntersections,
  crossingShapes,
  detailForHeight,
  getImagery,
  type ImageryDefinition,
  railShapes,
  roadShapes,
  signalShapes,
  type RoadScene,
} from '@ijm/gis';
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
import { SceneShapeLayer } from './scene-renderer';
import { StreetFurnitureLayer, type FurniturePoint } from './street-furniture';
import { TerrainHeights } from './terrain-grid';
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
  /** メモリ逼迫で上乗せされた係数（1 なら制限なし） */
  detailPenalty: number;
  /** メモリ削減の段階（0 なら制限なし、5 が最大） */
  reliefStep: number;
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
 * 地理院タイルの画像プロバイダを作る。
 *
 * minimumLevel を渡すのが要点。地理院タイルにはズーム 0 と 1 が無く、
 * 指定しないと Cesium がズーム 0 から読もうとして 404 になる。
 * その結果、引いた状態で地球に何も貼られず「日本地図が表示されない」
 * ように見えていた（実測 2026-09: 0/1 は 404、2 以上は世界中で 200）。
 *
 * ズーム 2 なら全球を 16 枚で覆えるので、起動時の負担にはならない。
 */
function buildImageryProvider(
  imagery: ImageryDefinition,
): Cesium.UrlTemplateImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: imagery.urlTemplate,
    minimumLevel: imagery.minimumLevel,
    maximumLevel: imagery.maximumLevel,
    // 絵の無いところを要求しない（白地図は日本国内にしか無い）
    rectangle: imagery.coverage
      ? Cesium.Rectangle.fromDegrees(...imagery.coverage)
      : undefined,
    credit: new Cesium.Credit(imagery.attribution, false),
  });
}

/**
 * 精細度を変更してよい最短間隔。
 *
 * 精細度の変更はタイルツリーの再評価を伴うので、頻繁にやると
 * 読み込みと破棄を繰り返して一向に安定しない。
 */
const SSE_CHANGE_INTERVAL_MS = 1500;
/** メモリに余裕がある状態がこの回数続いたら品質を 1 段戻す（監視は 0.5 秒間隔） */
const RECOVERY_STREAK = 10;
/**
 * カメラの最大高度 (m)。
 *
 * 地球の直径はおよそ 12,700km。その 2 倍ほど離れれば全球が視界に収まる。
 * それ以上引けてしまうと地球が点になり、操作でも戻れなくなる。
 */
const MAX_CAMERA_HEIGHT_M = 25_000_000;

/**
 * 地表大気を描き始める高度 (m)。
 *
 * 地球の縁が青くにじむ表現なので、地平線が丸く見え始める高さより
 * 下では画面に現れない。街を見ている間は計算するだけ無駄になる。
 */
const GROUND_ATMOSPHERE_MIN_HEIGHT_M = 30_000;

export class MapEngine {
  readonly viewer: Cesium.Viewer;
  readonly buildings: BuildingLayerManager;
  readonly routeLayer: RouteLayer;
  readonly environment: EnvironmentController;
  readonly furniture: StreetFurnitureLayer;
  readonly structures: ElevatedStructureLayer;
  /** 車道・車線・横断歩道・信号・線路 */
  readonly roads: SceneShapeLayer;

  private quality: QualitySettings;
  private qualityTier: QualityTier;
  private device: DeviceInfo;
  private watchdog: PerformanceWatchdog;
  private memoryWatchdog: MemoryWatchdog;
  private memoryReliefStep = 0;
  /** 余裕が戻った状態が続いた回数。すぐには戻さないための待ち */
  private recoveryStreak = 0;
  private removeContextListeners: (() => void) | null = null;
  private removeMemoryMonitor: (() => void) | null = null;
  private removeErrorListeners: (() => void)[] = [];
  readonly health = new HealthMonitor();
  private lastMemoryCheck = 0;
  private lastAdaptiveSse = 0;
  /** 高架を読み込んだときのカメラ位置。ここから離れたら取り直す */
  private structuresCentre: LatLng | null = null;
  /** 道路を読み込んだときのカメラ位置。ここから離れたら取り直す */
  private roadsCentre: LatLng | null = null;
  /** 周辺施設・街路樹を最後に取ったときのカメラ直下の座標 */
  private poisCentre: LatLng | null = null;
  private furnitureCentre: LatLng | null = null;
  /** いま区画線まで描いているか（上空では描かない） */
  private roadsDetailFull = true;
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
        buildImageryProvider(imagery),
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
      // 星空は夜になってから作る（テクスチャ 6 面で 864KB あり、
      // 昼は空の大気に隠れて 1 ピクセルも見えない）。
      // EnvironmentController が時間帯に応じて用意する
      skyBox: false,
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
    // 地球全体が視界に収まる程度まで。これ以上引くと地球が点になり、
    // 「縮小したら何も映らない」状態になる
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = MAX_CAMERA_HEIGHT_M;
    this.viewer.scene.screenSpaceCameraController.inertiaSpin = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaTranslate = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaZoom = 0.8;

    this.buildings = new BuildingLayerManager(this.viewer, this.quality, (message) =>
      this.health.record('tile-failed', message),
    );
    this.buildings.onTileFailed = (detail) => this.health.record('tile-failed', detail);
    this.routeLayer = new RouteLayer(this.viewer);
    this.environment = new EnvironmentController(this.viewer, this.quality);
    this.furniture = new StreetFurnitureLayer(this.viewer, this.quality.maxFurniture);
    this.structures = new ElevatedStructureLayer(this.viewer);
    this.structures.setShadows(this.quality.shadows);
    this.roads = new SceneShapeLayer(this.viewer);
    this.roads.setShadows(this.quality.shadows);

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
    if (this.destroyed) return;
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
      buildImageryProvider(imagery),
      0,
    );
    this.watchProviderErrors();
    this.requestRender();
  }

  get availableImagery(): typeof GSI_IMAGERY {
    return GSI_IMAGERY;
  }

  async loadCity(city: City): Promise<void> {
    if (this.destroyed) return;
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
    this.structures.setShadows(this.quality.shadows);
    this.roads.setShadows(this.quality.shadows);
    this.viewer.scene.postProcessStages.fxaa.enabled = this.quality.fxaa;
    this.buildings.updateQuality(this.quality);
    this.furniture.setMaxItems(this.quality.maxFurniture);
    this.options.onQualityChange?.(this.quality);
    this.requestRender();
  }

  /**
   * 描画距離をカメラ高度に応じて決める。
   *
   * 街を見ている高さでは、Cesium の既定 far（事実上無制限）だと
   * 地平線までのタイルがすべて読み込み対象になり、メモリを使い切ってしまう。
   * 一方で固定値に切ると、ズームアウトしたときに地球ごとクリップされて
   * 何も映らなくなる。
   *
   * そこで「低いところでは短く、高いところでは高度に比例して伸ばす」。
   * 高度の 8 倍あれば、真下を見ても斜めに見渡しても地表が視界に収まる。
   */
  private applyViewDistance(): void {
    const frustum = this.viewer.camera.frustum;
    if (!(frustum instanceof Cesium.PerspectiveFrustum)) return;

    const height = this.viewer.camera.positionCartographic?.height ?? 1000;
    // 高度の 8 倍まで見えれば、引いたときに地球が視界から切れることはない。
    // 高度 25,000km でも 5e7（50,000km）あれば地球の裏側まで入る
    const far = Math.max(this.quality.viewDistance, height * 8);
    // 地球全体が入る距離が上限（これ以上伸ばしても見えるものは増えない）
    frustum.far = Math.min(far, 5e7);

    this.applyAtmosphereForHeight(height);
  }

  /**
   * 上限を超えて飛んでいったカメラを引き戻す。
   *
   * 慣性ズームは指を離したあとも動き続けるので、上限を超えることがある。
   * 毎フレームやると setView がカメラ操作と競合するので、
   * 監視と同じ 0.5 秒間隔で見る。
   */
  private clampCameraHeight(): void {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto || carto.height <= MAX_CAMERA_HEIGHT_M) return;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        MAX_CAMERA_HEIGHT_M,
      ),
      orientation: {
        heading: this.viewer.camera.heading,
        pitch: this.viewer.camera.pitch,
        roll: 0,
      },
    });
  }

  /**
   * 高度に応じて大気の描画を切り替える。
   *
   * 地表大気（showGroundAtmosphere）は、地球を宇宙から見たときに
   * 縁が青くにじむ表現。街を見ている高さでは画面に一切現れないのに、
   * 地形のフラグメントシェーダには散乱の計算が常に入っている。
   * 見えない高さでは切り、引いたら戻すことで、街を見ている間の
   * 地形描画を軽くする。見た目は変わらない。
   */
  private applyAtmosphereForHeight(height: number): void {
    const globe = this.viewer.scene.globe;
    const wanted = height > GROUND_ATMOSPHERE_MIN_HEIGHT_M;
    if (globe.showGroundAtmosphere === wanted) return;
    globe.showGroundAtmosphere = wanted;
    this.requestRender();
  }

  /**
   * 追加レイヤ（LOD3 詳細・橋梁・都市設備・植生）の表示を切り替える。
   * 整備されていない範囲では false を返す（異常ではなく、単に重ねられない）。
   */
  async setOptionalLayer(id: OptionalLayerId, enabled: boolean): Promise<boolean> {
    if (this.destroyed) return false;
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

  /** いま出ている建物モデルの見え方 */
  get buildingModel(): BuildingModelMode {
    return this.buildings.buildingModel;
  }

  /**
   * 建物モデルの見え方を切り替える（実写テクスチャ / 用途で塗り分け / 箱型）。
   *
   * 配信されているデータセットそのものが変わるので、近景を読み直す。
   * @returns 実際に切り替わったか
   */
  async setBuildingModel(mode: BuildingModelMode): Promise<boolean> {
    if (this.destroyed) return false;
    const changed = await this.buildings.setBuildingModel(mode);
    this.requestRender();
    return changed;
  }

  /**
   * 高架・橋梁を立体で描く。
   *
   * PLATEAU の橋梁モデルが無い地域では、街の骨格である高架がまったく見えず
   * 道路が地面に張り付いたままになる。OSM の bridge / layer から補う。
   */
  async showElevatedStructures(structures: ElevatedStructure[], key: string): Promise<void> {
    if (this.destroyed) return;
    // 中心は組み立てを始めた時点のカメラ位置で控える。
    // 組み立ての完了後に取ると、その間に動いたぶんだけ中心がずれ、
    // 「もう範囲の外に出ているのに取り直さない」ということが起きる
    const centre = this.cameraGroundPosition();
    await this.structures.render(structures, key);
    this.structuresCentre = centre;
    this.requestRender();
  }

  clearElevatedStructures(): void {
    if (this.destroyed) return;
    this.structures.clear();
    this.structuresCentre = null;
    this.requestRender();
  }

  /**
   * 車道・車線・横断歩道・信号・線路を地表に描く。
   *
   * 形を決めるのは `@ijm/gis` の road-geometry（Cesium を知らない純粋な関数）で、
   * ここは出てきた形の記述を Cesium に渡すだけ。
   *
   * 線路の道床と信号の柱は地表に接している必要があるので、
   * 範囲の標高を格子でまとめて取り、補間して渡す。
   * 点ごとに問い合わせると要求が数千件になる。
   */
  async showRoadScene(scene: RoadScene, bbox: BBox, key: string): Promise<void> {
    if (this.destroyed) return;
    // 上空から見ているときは区画線を組み立てない（見えないものは描かない）。
    // 詳細度を鍵に含めるので、高度が変われば組み直しが走る
    const detail = detailForHeight(this.viewer.camera.positionCartographic?.height ?? 0);
    const fullKey = `${key}@${detail.laneMarkings ? 'full' : 'plain'}`;
    if (this.roads.hasLoaded(fullKey)) return;

    // 交差点を先に割り出す。区画線を交差点の手前で切るのに要る。
    // 切らないと、交差する道の白線どうしが中央で重なって格子状に見える
    const intersections = buildIntersections(scene.roads, scene.points);

    const shapes: SceneShape[] = [];
    for (const road of scene.roads) {
      shapes.push(
        ...(road.cls === 'crossing'
          ? crossingShapes(road, detail)
          : roadShapes(road, detail, intersections)),
      );
    }

    // 地表の線路と信号だけが標高を要る。どちらも無いなら取りに行かない
    const needsGround =
      scene.rails.some((r) => !r.elevated && !r.underground) ||
      scene.points.some((p) => p.kind === 'traffic_signal');

    if (needsGround) {
      const ground = await TerrainHeights.sample(this.viewer.terrainProvider, bbox);
      for (const rail of scene.rails) shapes.push(...railShapes(rail, ground.lookup));
      for (const point of scene.points) shapes.push(...signalShapes(point, ground.lookup));
    }

    const centre = this.cameraGroundPosition();
    await this.roads.render(shapes, fullKey);
    this.roadsCentre = centre;
    this.roadsDetailFull = detail.laneMarkings;
    this.requestRender();
  }

  /**
   * 道路の詳細度を切り替えるべきか。
   *
   * 上空から降りてきたら区画線を出し、上がったら消す。
   * 範囲そのものは変わっていないので、通信は要らない
   * （呼び出し側が持っている道路データをそのまま渡し直せばよい）。
   */
  needsRoadDetailChange(): boolean {
    if (this.destroyed) return false;
    if (this.roadsCentre === null) return false;
    const height = this.viewer.camera.positionCartographic?.height ?? 0;
    return detailForHeight(height).laneMarkings !== this.roadsDetailFull;
  }

  clearRoadScene(): void {
    if (this.destroyed) return;
    this.roads.clear();
    this.roadsCentre = null;
    this.roadsDetailFull = true;
    this.requestRender();
  }

  /**
   * 道路を読み直すべきか。
   *
   * 高架と同じで、カメラ周辺ぶんしか読んでいない。
   * 街を移動するとその範囲から出てしまう。
   */
  needsRoadRefresh(marginMeters = 500): boolean {
    if (this.destroyed) return false;
    if (!this.roadsCentre) return false;
    const now = this.cameraGroundPosition();
    if (!now) return false;
    return distanceMeters(this.roadsCentre, now) > marginMeters;
  }

  /**
   * 高架を読み直すべきか。
   *
   * 高架は起動時に「カメラ周辺 1.5km」ぶんだけ取っている。
   * 街を移動するとその範囲から出てしまい、高架だけが付いてこない。
   * 中心から離れたら取り直す。
   */
  needsStructureRefresh(marginMeters = 700): boolean {
    return this.movedFrom(this.structuresCentre, marginMeters);
  }

  /**
   * 周辺施設（POI）を取り直すべきか。
   *
   * POI は「画面中心から半径 800m」で取っている。街を移動すると
   * その範囲から出て、施設だけが元の場所に残ったままになる。
   * 以前はカメラの移動を見ていなかったため、選び直すまで
   * まったく追従しなかった。
   */
  needsPoiRefresh(marginMeters = 400): boolean {
    return this.movedFrom(this.poisCentre, marginMeters);
  }

  /** 街路樹・街灯を取り直すべきか */
  needsFurnitureRefresh(marginMeters = 500): boolean {
    return this.movedFrom(this.furnitureCentre, marginMeters);
  }

  /** 最後に取った場所から離れたか。まだ一度も取っていなければ false */
  private movedFrom(centre: LatLng | null, marginMeters: number): boolean {
    if (this.destroyed || !centre) return false;
    const now = this.cameraGroundPosition();
    if (!now) return false;
    return distanceMeters(centre, now) > marginMeters;
  }

  /** 周辺施設を取った位置を控える（次に取り直すかの判定に使う） */
  markPoisLoaded(): void {
    this.poisCentre = this.cameraGroundPosition();
  }

  markFurnitureLoaded(): void {
    this.furnitureCentre = this.cameraGroundPosition();
  }

  /** カメラ直下の地表座標（地形との交差計算を伴わない） */
  private cameraGroundPosition(): LatLng | null {
    if (this.destroyed) return null;
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lng: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  /** 端末判定による既定のティア（手動指定から「自動」に戻すときに使う） */
  get autoQualityTier(): QualityTier {
    return selectQualityTier(this.device);
  }

  /** 実際に適用されている描画距離 */
  private get currentFarDistance(): number {
    const frustum = this.viewer.camera.frustum;
    return frustum instanceof Cesium.PerspectiveFrustum
      ? Math.round(frustum.far)
      : this.quality.viewDistance;
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
      reliefStep: this.memoryReliefStep,
      cameraHeightM: Math.round(this.viewer.camera.positionCartographic?.height ?? 0),
      viewDistanceM: this.currentFarDistance,
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

    /**
     * 見た目に寄与しない描画をやめる。
     *
     * Cesium は水面の反射を地形タイルの water mask で描く。国土地理院・
     * PLATEAU の地形タイルは water mask を持たないので、この計算は
     * 常に「水ではない」を返すだけの空回りになる。それでも地形の
     * フラグメントシェーダには法線の読み出しと合成が組み込まれる。
     * 切っても見た目は 1 ピクセルも変わらず、地形の描画だけが軽くなる。
     */
    globe.showWaterEffect = false;
    // 地形の裏面は見えない
    globe.backFaceCulling = true;
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
      // 描画距離だけは毎フレーム合わせる。
      // 0.5 秒に 1 回では、慣性の効いたズームで高度が一気に変わったときに
      // far が追いつかず、地球がクリップ面の外に出て一瞬消える。
      // 計算は数回の乗除算なので毎フレームでも負担にならない
      this.applyViewDistance();

      if (now - this.lastMemoryCheck < 500) return;
      this.lastMemoryCheck = now;
      this.clampCameraHeight();
      this.updateAdaptiveDetail();
      this.followCameraForBuildings();
      const tileBytes = this.buildings.totalMemoryUsageInBytes;
      this.memoryWatchdog.check(tileBytes, now);
      this.recoverFromMemoryPressure(tileBytes);
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
    const at = {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lng: Cesium.Math.toDegrees(carto.longitude),
    };
    // 太陽高度は緯度経度で変わる。日本の南北で日の入りは 1 時間近く違うので、
    // 都市をまたいで移動したら空の状態を計算し直す（中では 0.5 度動くまで何もしない）
    this.environment.setViewpoint(at);
    void this.buildings.refreshForCamera(at);
  }

  /**
   * メモリに余裕が戻ったら、落とした品質を段階的に戻す。
   *
   * これが無いと、一度でも逼迫した時点で精細度が落ちたまま二度と戻らず、
   * 「3D の建物が読み込まれない」ように見えてしまう。
   * 都市を移動して読み込み量が減ったあとなどに効く。
   *
   * すぐ戻すと上げ下げを繰り返すので、余裕がある状態が続いたときだけ 1 段戻す。
   */
  private recoverFromMemoryPressure(tileBytes: number): void {
    if (this.memoryReliefStep === 0 && this.detailPenalty === 1) {
      this.recoveryStreak = 0;
      return;
    }

    if (!this.memoryWatchdog.hasRecovered(tileBytes)) {
      this.recoveryStreak = 0;
      return;
    }

    this.recoveryStreak += 1;
    // 監視は 0.5 秒間隔。10 回 = 約 5 秒、余裕がある状態が続いたら戻す
    if (this.recoveryStreak < RECOVERY_STREAK) return;
    this.recoveryStreak = 0;

    if (this.detailPenalty > 1) {
      this.detailPenalty = Math.max(1, this.detailPenalty / 1.8);
      this.lastAdaptiveSse = 0;
      this.updateAdaptiveDetail();
    }
    if (this.memoryReliefStep > 0) {
      this.memoryReliefStep -= 1;
      // 段階 2 で遠景を落としていた場合、戻ってきたら読み直す
      if (this.memoryReliefStep < 2) void this.buildings.restoreFarTileset();
    }
    this.requestRender();
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
    // 経路の取得は通信を伴う。その間に画面を離れているかもしれない
    if (this.destroyed) return;
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
    if (this.destroyed) return;
    if (this.quality.maxFurniture <= 0) return;
    if (this.furniture.hasLoaded(bbox)) return;
    // 近いときだけ枝ぶりを細かく組む。上空からは輪郭しか見えない
    this.furniture.setDistance(this.viewer.camera.positionCartographic?.height ?? 0);
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
    if (this.destroyed) return null;
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
  getSurroundingBBox(
    radiusMeters = 1500,
    /**
     * 中心をこの間隔の格子に丸める (m)。
     *
     * カメラが少し動くたびに違う範囲を要求すると、毎回まったく別の
     * キャッシュキーになり、エッジにも手元にも当たらない。
     * 格子に載せておけば、近い場所では同じ範囲を要求することになり、
     * 通信も、受け取った構造物の組み立て直しも起きなくなる。
     */
    snapMeters = 0,
  ): [number, number, number, number] | null {
    // 起動直後の遅延読み込みなど、数秒待ってから呼ばれる経路がある。
    // その間に画面を離れていると camera はもう無い
    if (this.destroyed) return null;
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    let lat = Cesium.Math.toDegrees(carto.latitude);
    let lng = Cesium.Math.toDegrees(carto.longitude);

    if (snapMeters > 0) {
      const latStep = snapMeters / 111_320;
      const lngStep = latStep / (Math.cos((lat * Math.PI) / 180) || 1);
      lat = Math.round(lat / latStep) * latStep;
      lng = Math.round(lng / lngStep) * lngStep;
    }
    return bboxAround({ lat, lng }, radiusMeters);
  }

  requestRender(): void {
    if (!this.destroyed) this.viewer.scene.requestRender();
  }

  /** 破棄済みか。非同期の待ち合わせをまたいだら確認する */
  get isDestroyed(): boolean {
    return this.destroyed;
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
    this.roads.clear();
    this.environment.destroy();
    this.furniture.clear();
    this.buildings.unload();
    this.routeLayer.clearAll();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
