/**
 * MapEngine — CesiumJS のラッパ。
 *
 * アプリの他の層（UI / navigation / ai）は Cesium を直接触らず、このクラス越しに操作する。
 * これにより将来レンダラを差し替えても影響範囲が閉じる。
 */

import * as Cesium from 'cesium';
import type { City, District, LatLng, Poi, Route } from '@ijm/shared';
import { PLATEAU_TERRAIN_URL, bboxExpand, getDefaultCity } from '@ijm/shared';
import { DEFAULT_IMAGERY_ID, GSI_IMAGERY, categoryIcon, getImagery } from '@ijm/gis';
import {
  NavigationSession,
  type NavigationSessionOptions,
  type NavigationTickResult,
} from '@ijm/navigation';
import { BuildingLayerManager } from './buildings';
import { EnvironmentController, type WeatherKind } from './environment';
import { RouteLayer } from './route-layer';
import { StreetFurnitureLayer, type FurniturePoint } from './street-furniture';
import {
  PerformanceWatchdog,
  degradeTier,
  detectDevice,
  getQualitySettings,
  selectQualityTier,
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

export class MapEngine {
  readonly viewer: Cesium.Viewer;
  readonly buildings: BuildingLayerManager;
  readonly routeLayer: RouteLayer;
  readonly environment: EnvironmentController;
  readonly furniture: StreetFurnitureLayer;

  private quality: QualitySettings;
  private qualityTier: QualityTier;
  private watchdog: PerformanceWatchdog;
  private session: NavigationSession | null = null;
  private navigating = false;
  private useRealPosition = false;
  private lastGeolocation: LatLng | null = null;
  private imageryLayer: Cesium.ImageryLayer | null = null;
  private removePreRender: (() => void) | null = null;
  private occlusionFrame = 0;
  private destroyed = false;

  constructor(private readonly options: MapEngineOptions) {
    this.qualityTier = options.qualityTier ?? selectQualityTier(detectDevice());
    this.quality = getQualitySettings(this.qualityTier);

    if (options.ionToken) {
      Cesium.Ion.defaultAccessToken = options.ionToken;
    } else {
      // ion を使わない構成。既定トークンによる不要なリクエストを避ける。
      Cesium.Ion.defaultAccessToken = '';
    }

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

    // iPhone の Retina 解像度を活かす（要件: iOS は品質を落とさない）
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.viewer.resolutionScale = Math.min(dpr, this.quality.resolutionScale);

    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    // 地表付近まで寄れるようにする（街を歩く体験のため）
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2;
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 5_000_000;
    this.viewer.scene.screenSpaceCameraController.inertiaSpin = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaTranslate = 0.85;
    this.viewer.scene.screenSpaceCameraController.inertiaZoom = 0.8;

    this.buildings = new BuildingLayerManager(this.viewer, this.quality);
    this.routeLayer = new RouteLayer(this.viewer);
    this.environment = new EnvironmentController(this.viewer, this.quality);
    this.furniture = new StreetFurnitureLayer(this.viewer, this.quality.maxFurniture);

    this.watchdog = new PerformanceWatchdog(
      () => this.degradeQuality(),
      28,
      180,
      this.qualityTier !== 'ios-high',
    );

    this.setupInteractionHandlers();
    void this.initialize(options);
  }

  private async initialize(options: MapEngineOptions): Promise<void> {
    await this.setTerrain(options.terrainUrl ?? PLATEAU_TERRAIN_URL);
    const city = options.city ?? getDefaultCity();

    // 建物タイルセットが落ちていても、地形・ベースマップ・ルート表示は成立させる
    try {
      await this.loadCity(city);
    } catch (error) {
      console.warn('[map-engine] 3D 建物データの読み込みに失敗しました', error);
    }

    this.flyTo({
      position: city.center,
      height: city.initialHeight,
      pitch: -35,
      duration: 0,
    });
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
      this.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
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
    this.quality = getQualitySettings(tier);
    this.viewer.scene.msaaSamples = this.quality.msaaSamples;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.viewer.resolutionScale = Math.min(dpr, this.quality.resolutionScale);
    this.viewer.shadows = this.quality.shadows;
    this.viewer.scene.postProcessStages.fxaa.enabled = this.quality.fxaa;
    this.buildings.updateQuality(this.quality);
    this.furniture.setMaxItems(this.quality.maxFurniture);
    this.options.onQualityChange?.(this.quality);
    this.requestRender();
  }

  private degradeQuality(): void {
    const next = degradeTier(this.qualityTier);
    if (next === this.qualityTier) return;
    console.info(`[map-engine] 描画性能が不足しているため品質を ${next} に下げます`);
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

  requestRender(): void {
    if (!this.destroyed) this.viewer.scene.requestRender();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopNavigation();
    this.environment.destroy();
    this.furniture.clear();
    this.buildings.unload();
    this.routeLayer.clearAll();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
