/**
 * PLATEAU 3D Tiles（建物）の管理。
 *
 * - 近景/中景（LOD2, テクスチャ付き）と遠景（LOD1, テクスチャ無し）の 2 系統を持つ
 * - 都市単位で attach / detach し、「日本全国を一度に読み込む」ことを構造的に防ぐ
 * - ナビゲーション時は、進路を隠している建物だけを半透明化する
 */

import * as Cesium from 'cesium';
import type { BBox, City, LatLng } from '@ijm/shared';
import { bboxAround, bboxIntersects } from '@ijm/shared';
import type { QualitySettings } from './quality';

/**
 * tileset.json の取得先。
 *
 * PLATEAU の配信 URL を直接読むと、都道府県まるごとの tileset が返り、
 * 視界に入る全市区町村の LOD2 を一斉に展開してしまう（東京都なら 23 区分）。
 * 開いた直後に数千リクエストと大量のメモリ確保が起きるため、
 * BFF (/api/tileset) で必要な範囲の子だけに絞ってから読み込む。
 */
function tilesetUrl(city: City, layer: string, bbox: BBox): string {
  const params = new URLSearchParams({
    city: city.id,
    layer,
    bbox: bbox.map((n) => n.toFixed(4)).join(','),
  });
  return `/api/tileset?${params.toString()}`;
}

export interface LoadedCityTilesets {
  city: City;
  near: Cesium.Cesium3DTileset;
  far?: Cesium.Cesium3DTileset;
}

/**
 * 建物のベース（LOD2）に重ねられる追加レイヤ。
 *
 *   detail    … LOD3（開口部）・LOD4（室内）。整備範囲が狭いので重ねる形で扱う
 *   bridge    … 橋梁
 *   furniture … 都市設備
 *   vegetation… 植生
 *
 * いずれも整備されていない範囲では BFF が 404 を返すので、
 * 呼び出し側は「重ねられなかった」ことを普通の結果として扱える。
 */
export type OptionalLayerId = 'detail' | 'bridge' | 'furniture' | 'vegetation';

/**
 * 遠景 LOD1 用の中立色。
 *
 * 近景・中景の LOD2 には **一切スタイルを当てない**。PLATEAU の実写テクスチャが
 * そのまま出るのが「事実どおりの色」だからである。
 * 一方 LOD1 はテクスチャを持たない（＝色の情報が存在しない）ため、
 * 「実在しない色を創作しない」という方針に従い、彩度をほぼ持たない
 * コンクリート系の中立色のみを使い、高さでわずかな明度差を付けるにとどめる。
 */
function farTilesetStyle(): Cesium.Cesium3DTileStyle {
  return new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        ['!defined(${bldg_measuredHeight})', 'color("#cfcbc4")'],
        ['${bldg_measuredHeight} >= 150', 'color("#c4c0ba")'],
        ['${bldg_measuredHeight} >= 80', 'color("#c9c5bf")'],
        ['${bldg_measuredHeight} >= 40', 'color("#cecac4")'],
        ['true', 'color("#d3cfc9")'],
      ],
    },
  });
}

/**
 * 近景 LOD2 を読み込む範囲（カメラ中心からの半径 m）。
 *
 * PLATEAU の最小配信単位は市区町村なので、半径を小さくしても
 * 読み込む tileset の数は一定以下にならない。東京都心の実測では
 * 2km で 7 区、3km で 8 区、4km で 10 区（絞らない場合は 62 市区町村）。
 * 移動追従があるため、3km で十分カバーできる。
 */
const NEAR_RADIUS_M = 3000;
/** 遠景 LOD1 の範囲。テクスチャを持たないぶん広く取れる（実測 7km で約 18 区） */
const FAR_RADIUS_M = 7000;
/** 読み込み済み範囲の縁からこれだけ内側に入ったら、範囲を取り直す */
const REFRESH_MARGIN_M = 1000;

export class BuildingLayerManager {
  private loaded: LoadedCityTilesets | null = null;
  /** 近景タイルセットが現在カバーしている範囲 */
  private activeBBox: BBox | null = null;
  private refreshing = false;
  /** 読み込み待ちのタイル数（loadProgress で更新される） */
  private pendingRequests = 0;
  private tilesProcessing = 0;
  private removeProgressListeners: (() => void)[] = [];
  /** 追加レイヤ（LOD3 詳細・橋梁・都市設備・植生） */
  private optionalLayers = new Map<OptionalLayerId, Cesium.Cesium3DTileset>();
  /** 透過中の feature と元の色 */
  private dimmed = new Map<Cesium.Cesium3DTileFeature, Cesium.Color>();

  constructor(
    private readonly viewer: Cesium.Viewer,
    private quality: QualitySettings,
  ) {}

  get currentCity(): City | null {
    return this.loaded?.city ?? null;
  }

  get tilesets(): Cesium.Cesium3DTileset[] {
    if (!this.loaded) return [];
    const list = [this.loaded.near];
    if (this.loaded.far) list.push(this.loaded.far);
    list.push(...this.optionalLayers.values());
    return list;
  }

  private tilesetOptions(isFar: boolean): Cesium.Cesium3DTileset.ConstructorOptions {
    const q = this.quality;
    return {
      maximumScreenSpaceError: isFar ? q.farScreenSpaceError : q.screenSpaceError,
      cacheBytes: isFar ? Math.floor(q.cacheBytes * 0.35) : q.cacheBytes,
      maximumCacheOverflowBytes: q.maximumCacheOverflowBytes,
      cullWithChildrenBounds: true,
      cullRequestsWhileMoving: true,
      cullRequestsWhileMovingMultiplier: 10,
      preloadWhenHidden: false,
      preloadFlightDestinations: true,
      preferLeaves: !isFar,
      progressiveResolutionHeightFraction: 0.4,
      // 視線方向の奥ほど SSE を緩める。街を見渡す視点で読み込むタイル数を大きく減らせる
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4,
      // 中間 LOD を飛ばさない。飛ばすと一時的に高精細タイルを大量に抱えてメモリが跳ねる
      skipLevelOfDetail: false,
      // 画面外に出たタイルを積極的に解放する（メモリ超過によるタブのクラッシュ対策）
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.2,
      foveatedTimeDelay: 0.2,
      shadows: this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
    };
  }

  /**
   * 都市を読み込む。既に別の都市が読み込まれていれば破棄してメモリを解放する。
   */
  async loadCity(city: City): Promise<LoadedCityTilesets> {
    if (this.loaded?.city.id === city.id) return this.loaded;

    this.unload();

    // 起動直後はカメラ周辺だけを読む。カメラが離れたら refreshForCamera が読み直す
    this.activeBBox = this.clampToCity(city, bboxAround(city.center, NEAR_RADIUS_M));
    const near = await Cesium.Cesium3DTileset.fromUrl(
      tilesetUrl(city, 'near', this.activeBBox),
      this.tilesetOptions(false),
    );
    near.shadows = this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    this.watchLoadProgress(near);
    // 近景にはスタイルを当てない = PLATEAU の実写テクスチャの色をそのまま出す
    this.applyRealisticLighting(near);
    this.viewer.scene.primitives.add(near);

    this.loaded = { city, near };

    // 遠景は近景の表示が始まってから読む。
    // 同時に読むと開いた直後のリクエストとメモリ確保が集中し、
    // 端末によってはタブごと落ちる。近くから順に見えてくる方が体感も良い。
    if (city.far && this.quality.useFarTileset) {
      void this.loadFarTileset(city);
    }

    return this.loaded;
  }

  /** 遠景 LOD1 を後追いで読み込む（失敗しても近景だけで成立する） */
  private async loadFarTileset(city: City): Promise<void> {
    try {
      // 近景のタイル取得が一段落してから始める。
      // 同時に走らせると開いた直後に通信とメモリ確保が集中する
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!this.loaded || this.loaded.city.id !== city.id) return;

      const bbox = this.clampToCity(city, bboxAround(city.center, FAR_RADIUS_M));
      const far = await Cesium.Cesium3DTileset.fromUrl(
        tilesetUrl(city, 'far', bbox),
        this.tilesetOptions(true),
      );
      // 読み込み中に都市が切り替わっていたら捨てる
      if (!this.loaded || this.loaded.city.id !== city.id || this.loaded.far) {
        far.destroy();
        return;
      }
      far.style = farTilesetStyle();
      far.shadows = Cesium.ShadowMode.DISABLED;
      this.watchLoadProgress(far);
      this.applyRealisticLighting(far);
      this.viewer.scene.primitives.add(far);
      this.loaded = { ...this.loaded, far };
    } catch {
      // 遠景が無くても近景だけで成立する
    }
  }

  /**
   * PBR を実在の見た目に寄せるための設定。
   *
   * lightColor は既定（＝白）のままにして、テクスチャの色を着色しない。
   * 環境光は Cesium が大気の色から計算する既定の拡散照度をそのまま使い
   * （sphericalHarmonicCoefficients を与えない＝時刻に応じた自然な環境光になる）、
   * 寄与の強さだけを最大にして日陰が黒く潰れないようにする。
   */
  private applyRealisticLighting(tileset: Cesium.Cesium3DTileset): void {
    try {
      tileset.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(1.0, 1.0);
    } catch {
      /* 未対応バージョンでは既定のまま使う */
    }
    tileset.backFaceCulling = true;
    tileset.enableCollision = false;
  }

  unload(): void {
    this.activeBBox = null;
    for (const tileset of this.optionalLayers.values()) {
      this.viewer.scene.primitives.remove(tileset);
    }
    this.optionalLayers.clear();
    for (const remove of this.removeProgressListeners) remove();
    this.removeProgressListeners = [];
    this.pendingRequests = 0;
    this.tilesProcessing = 0;
    if (!this.loaded) return;
    this.restoreAll();
    this.viewer.scene.primitives.remove(this.loaded.near);
    if (this.loaded.far) this.viewer.scene.primitives.remove(this.loaded.far);
    this.loaded = null;
  }

  /**
   * タイルの読み込み状況を監視する。
   *
   * デコードが済んだタイルは GPU にアップロードされるが、これが 1 フレームに
   * 集中すると描画コマンドが一気に膨らむ。iOS ではこれが上限を超えると
   * WebGL コンテキストごと失われるため、待ち行列の長さを見て要求を絞る。
   */
  private watchLoadProgress(tileset: Cesium.Cesium3DTileset): void {
    const remove = tileset.loadProgress.addEventListener(
      (pendingRequests: number, tilesProcessing: number) => {
        this.pendingRequests = pendingRequests;
        this.tilesProcessing = tilesProcessing;
      },
    );
    this.removeProgressListeners.push(remove);
  }

  /** 読み込み待ちの総数（流量制御の判断に使う） */
  get loadQueueLength(): number {
    return this.pendingRequests + this.tilesProcessing;
  }

  /** 範囲が都市の bbox をはみ出さないように収める */
  private clampToCity(city: City, bbox: BBox): BBox {
    const [cMinLng, cMinLat, cMaxLng, cMaxLat] = city.bbox;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return [
      Math.max(minLng, cMinLng),
      Math.max(minLat, cMinLat),
      Math.min(maxLng, cMaxLng),
      Math.min(maxLat, cMaxLat),
    ];
  }

  /**
   * カメラが読み込み済み範囲から出そうなら、近景タイルセットを取り直す。
   *
   * 一度に読むのはカメラ周辺だけなので、移動に追従して読み直す必要がある。
   * 新しいタイルセットの準備ができてから差し替えるので、建物が消える瞬間はない。
   */
  async refreshForCamera(center: LatLng): Promise<boolean> {
    if (!this.loaded || !this.activeBBox || this.refreshing) return false;

    const inner = bboxAround(center, REFRESH_MARGIN_M);
    const [aMinLng, aMinLat, aMaxLng, aMaxLat] = this.activeBBox;
    const stillInside =
      inner[0] >= aMinLng && inner[1] >= aMinLat && inner[2] <= aMaxLng && inner[3] <= aMaxLat;
    if (stillInside) return false;

    const city = this.loaded.city;
    const next = this.clampToCity(city, bboxAround(center, NEAR_RADIUS_M));
    // 都市の外に出た場合は読み直さない（都市の切り替えは loadCity が担当する）
    if (!bboxIntersects(next, city.bbox)) return false;

    this.refreshing = true;
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        tilesetUrl(city, 'near', next),
        this.tilesetOptions(false),
      );
      if (!this.loaded || this.loaded.city.id !== city.id) {
        // 読み込み中に都市が切り替わっていたら破棄する
        tileset.destroy();
        return false;
      }
      tileset.shadows = this.quality.shadows
        ? Cesium.ShadowMode.ENABLED
        : Cesium.ShadowMode.DISABLED;
      this.applyRealisticLighting(tileset);
      this.viewer.scene.primitives.add(tileset);

      const previous = this.loaded.near;
      this.loaded = { ...this.loaded, near: tileset };
      this.activeBBox = next;
      this.restoreAll();
      this.viewer.scene.primitives.remove(previous);
      return true;
    } catch {
      // 取り直しに失敗しても、今表示しているものはそのまま使える
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * 追加レイヤを重ねる。整備されていない範囲では false を返す（異常ではない）。
   *
   * ベースの建物（LOD2）はそのまま残す。LOD3・LOD4 は整備済みの区が限られており、
   * 広域を置き換えられないため、重ねる形にしている。
   */
  async enableLayer(id: OptionalLayerId): Promise<boolean> {
    if (!this.loaded || this.optionalLayers.has(id)) return false;
    const city = this.loaded.city;
    const bbox = this.activeBBox ?? city.bbox;

    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        tilesetUrl(city, id, bbox),
        this.tilesetOptions(false),
      );
      if (!this.loaded || this.loaded.city.id !== city.id) {
        tileset.destroy();
        return false;
      }
      tileset.shadows = Cesium.ShadowMode.DISABLED;
      this.applyRealisticLighting(tileset);
      this.watchLoadProgress(tileset);
      this.viewer.scene.primitives.add(tileset);
      this.optionalLayers.set(id, tileset);
      return true;
    } catch {
      // 未整備の範囲では BFF が 404 を返す。重ねられないだけで異常ではない
      return false;
    }
  }

  disableLayer(id: OptionalLayerId): void {
    const tileset = this.optionalLayers.get(id);
    if (!tileset) return;
    this.viewer.scene.primitives.remove(tileset);
    this.optionalLayers.delete(id);
  }

  isLayerEnabled(id: OptionalLayerId): boolean {
    return this.optionalLayers.has(id);
  }

  /** 近景タイルセットの精細度だけを差し替える（カメラ高度に応じた制御用） */
  setNearScreenSpaceError(sse: number): void {
    if (!this.loaded) return;
    this.loaded.near.maximumScreenSpaceError = sse;
  }

  /** 読み込み済みタイルセットが実際に使っているメモリ量 (byte) */
  get totalMemoryUsageInBytes(): number {
    return this.tilesets.reduce((sum, t) => {
      const used = (t as Cesium.Cesium3DTileset & { totalMemoryUsageInBytes?: number })
        .totalMemoryUsageInBytes;
      return sum + (Number.isFinite(used) ? (used as number) : 0);
    }, 0);
  }

  /**
   * メモリ逼迫時の緊急退避。
   * 画面に出ていないタイルを解放し、キャッシュ上限を縮める。
   * 表示中のタイルは残るので、見た目は保たれたまま使用量だけ下がる。
   */
  relieveMemoryPressure(factor = 0.6): void {
    for (const tileset of this.tilesets) {
      tileset.trimLoadedTiles();
      const next = Math.max(48 * 1024 * 1024, Math.floor(tileset.cacheBytes * factor));
      tileset.cacheBytes = next;
      tileset.maximumCacheOverflowBytes = Math.floor(next * 0.25);
    }
  }

  /** 遠景タイルセットだけを破棄する（メモリ削減の最終手段の一歩手前） */
  dropFarTileset(): boolean {
    if (!this.loaded?.far) return false;
    this.viewer.scene.primitives.remove(this.loaded.far);
    this.loaded = { city: this.loaded.city, near: this.loaded.near };
    return true;
  }

  updateQuality(quality: QualitySettings): void {
    this.quality = quality;
    if (!this.loaded) return;
    this.loaded.near.maximumScreenSpaceError = quality.screenSpaceError;
    this.loaded.near.cacheBytes = quality.cacheBytes;
    this.loaded.near.maximumCacheOverflowBytes = quality.maximumCacheOverflowBytes;
    this.loaded.near.shadows = quality.shadows
      ? Cesium.ShadowMode.ENABLED
      : Cesium.ShadowMode.DISABLED;
    if (this.loaded.far) {
      this.loaded.far.maximumScreenSpaceError = quality.farScreenSpaceError;
    }
  }

  /**
   * ナビ中に「次の進路を隠している建物」だけを半透明にする。
   * 画面上の複数点で drillPick し、当たった feature のみ対象にする。
   * 全建物を常時透明にはしない（要件）。
   */
  applyOcclusionTransparency(screenPoints: Cesium.Cartesian2[], alpha = 0.25): void {
    if (!this.loaded) return;

    const hitNow = new Set<Cesium.Cesium3DTileFeature>();

    for (const point of screenPoints) {
      let picked: unknown[] = [];
      try {
        picked = this.viewer.scene.drillPick(point, 4) as unknown[];
      } catch {
        continue;
      }
      for (const p of picked) {
        if (p instanceof Cesium.Cesium3DTileFeature) {
          hitNow.add(p);
        }
      }
    }

    // 新たに遮蔽している建物を薄くする
    for (const feature of hitNow) {
      if (this.dimmed.has(feature)) continue;
      try {
        this.dimmed.set(feature, Cesium.Color.clone(feature.color));
        feature.color = Cesium.Color.clone(feature.color).withAlpha(alpha);
      } catch {
        this.dimmed.delete(feature);
      }
    }

    // 遮蔽しなくなった建物を元に戻す
    for (const [feature, original] of this.dimmed) {
      if (hitNow.has(feature)) continue;
      this.restore(feature, original);
    }
  }

  private restore(feature: Cesium.Cesium3DTileFeature, original: Cesium.Color): void {
    try {
      feature.color = original;
    } catch {
      /* タイルが破棄済みの場合は無視 */
    }
    this.dimmed.delete(feature);
  }

  restoreAll(): void {
    for (const [feature, original] of this.dimmed) {
      this.restore(feature, original);
    }
    this.dimmed.clear();
  }

  /** 建物 feature の属性を取り出す（建物情報パネル用） */
  static readFeature(feature: Cesium.Cesium3DTileFeature): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    try {
      for (const id of feature.getPropertyIds()) {
        out[id] = feature.getProperty(id);
      }
    } catch {
      /* 属性が読めない場合は空で返す */
    }
    return out;
  }
}
