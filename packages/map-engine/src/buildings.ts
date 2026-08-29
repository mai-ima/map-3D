/**
 * PLATEAU 3D Tiles（建物）の管理。
 *
 * - 近景/中景（LOD2, テクスチャ付き）と遠景（LOD1, テクスチャ無し）の 2 系統を持つ
 * - 都市単位で attach / detach し、「日本全国を一度に読み込む」ことを構造的に防ぐ
 * - ナビゲーション時は、進路を隠している建物だけを半透明化する
 */

import * as Cesium from 'cesium';
import type { City } from '@ijm/shared';
import { cityTilesetUrls } from '@ijm/shared';
import type { QualitySettings } from './quality';

export interface LoadedCityTilesets {
  city: City;
  near: Cesium.Cesium3DTileset;
  far?: Cesium.Cesium3DTileset;
}

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

export class BuildingLayerManager {
  private loaded: LoadedCityTilesets | null = null;
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
    return this.loaded.far ? [this.loaded.near, this.loaded.far] : [this.loaded.near];
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
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4,
      skipLevelOfDetail: false,
      shadows: this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
    };
  }

  /**
   * 都市を読み込む。既に別の都市が読み込まれていれば破棄してメモリを解放する。
   */
  async loadCity(city: City): Promise<LoadedCityTilesets> {
    if (this.loaded?.city.id === city.id) return this.loaded;

    this.unload();

    const urls = cityTilesetUrls(city);
    const near = await Cesium.Cesium3DTileset.fromUrl(urls.near, this.tilesetOptions(false));
    near.shadows = this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    // 近景にはスタイルを当てない = PLATEAU の実写テクスチャの色をそのまま出す
    this.applyRealisticLighting(near);
    this.viewer.scene.primitives.add(near);

    let far: Cesium.Cesium3DTileset | undefined;
    if (urls.far && this.quality.useFarTileset) {
      try {
        far = await Cesium.Cesium3DTileset.fromUrl(urls.far, this.tilesetOptions(true));
        far.style = farTilesetStyle();
        far.shadows = Cesium.ShadowMode.DISABLED;
        this.applyRealisticLighting(far);
        this.viewer.scene.primitives.add(far);
      } catch {
        // 遠景が無くても近景だけで成立する
        far = undefined;
      }
    }

    this.loaded = { city, near, far };
    return this.loaded;
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
    if (!this.loaded) return;
    this.restoreAll();
    this.viewer.scene.primitives.remove(this.loaded.near);
    if (this.loaded.far) this.viewer.scene.primitives.remove(this.loaded.far);
    this.loaded = null;
  }

  updateQuality(quality: QualitySettings): void {
    this.quality = quality;
    if (!this.loaded) return;
    this.loaded.near.maximumScreenSpaceError = quality.screenSpaceError;
    this.loaded.near.cacheBytes = quality.cacheBytes;
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
