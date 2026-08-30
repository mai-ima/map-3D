/**
 * PLATEAU 3D Tiles（建物）の管理。
 *
 * - 近景/中景（LOD2, テクスチャ付き）と遠景（LOD1, テクスチャ無し）の 2 系統を持つ
 * - 都市単位で attach / detach し、「日本全国を一度に読み込む」ことを構造的に防ぐ
 * - ナビゲーション時は、進路を隠している建物だけを半透明化する
 */

import * as Cesium from 'cesium';
import type { BBox, City, LatLng } from '@ijm/shared';
import { bboxAround, bboxIntersects, isDirectTileset } from '@ijm/shared';
import { untexturedBuildingStyle } from './building-style';
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
export function farTilesetStyle(): Cesium.Cesium3DTileStyle {
  // 属性名にコロンが入っているので ${feature['...']} の形でしか参照できない。
  // アンダースコアで書くと常に未定義になり、全棟が同じ色になってしまう。
  // また defined() はスタイル式に存在しない（あるのは isNaN / isFinite）。
  // 以前は両方を踏んでいて、遠景タイルセットは一度も表示されていなかった
  const height = "${feature['bldg:measuredHeight']}";
  return new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        [`isNaN(${height})`, 'color("#cfcbc4")'],
        [`${height} >= 150`, 'color("#c4c0ba")'],
        [`${height} >= 80`, 'color("#c9c5bf")'],
        [`${height} >= 40`, 'color("#cecac4")'],
        ['true', 'color("#d3cfc9")'],
      ],
    },
  });
}

/**
 * 遠景 LOD1 を重ねる意味があるか。
 *
 * 遠景は「近景が読み込んでいない遠くの街並み」を薄く描くためのもの。
 * ところが浜松・姫路のように tileset.json を直接指定している都市では、
 * 近景 (LOD2) と遠景 (LOD1) がまったく同じ範囲・同じ四分木を返す。
 * 実測（2026-08, 浜松市旧中区）:
 *
 *   near lod2  範囲 [137.6808, 34.6804, 137.7611, 34.7831] 子 4 件
 *   far  lod1  範囲 [137.6808, 34.6804, 137.7611, 34.7831] 子 4 件（同一）
 *
 * この状態で両方を出すと、すべての建物が LOD2 の屋根形状と LOD1 の箱で
 * 二重に描かれる。同じ場所に 2 つの面があるので深度が競合してちらつき、
 * 屋根の形も箱に埋もれて見えなくなる。
 *
 * 近景が市域全体をカバーしているなら、遠景は足すものが何も無い。
 * 読まないことで二重描画が消え、タイルの読み込みも半分になる。
 */
export function needsFarTileset(city: City): boolean {
  return !(city.near && isDirectTileset(city.near));
}

/**
 * 近景がカバーしている範囲を遠景から切り抜くための面を作る。
 *
 * 近景 (LOD2) と遠景 (LOD1) は同じ建物を含む。重ねて描くと、
 * 屋根形状のある LOD2 と箱の LOD1 が同じ場所で深度を奪い合い、
 * 建物が二重に見えたりちらついたりする。
 *
 * ClippingPlaneCollection は、unionClippingRegions を false にすると
 * 「すべての面で切り取る側と判定された領域」だけを切り取る（＝論理積）。
 * 矩形の 4 辺それぞれで内側が負になるように面を置けば、
 * 矩形の内側だけがくり抜かれる。
 */
function createHoleClipping(bbox: BBox | null): Cesium.ClippingPlaneCollection | undefined {
  if (!bbox) return undefined;
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const centre = Cesium.Cartesian3.fromDegrees((minLng + maxLng) / 2, (minLat + maxLat) / 2);
  const cos = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  // 中心からの半径 (m)。局所的な東西南北の平面として扱う
  const halfEast = ((maxLng - minLng) / 2) * 111_320 * cos;
  const halfNorth = ((maxLat - minLat) / 2) * 111_320;

  return new Cesium.ClippingPlaneCollection({
    // 局所座標系は x = 東, y = 北。各辺の外向き法線と、中心からの距離
    planes: [
      new Cesium.ClippingPlane(new Cesium.Cartesian3(1, 0, 0), -halfEast),
      new Cesium.ClippingPlane(new Cesium.Cartesian3(-1, 0, 0), -halfEast),
      new Cesium.ClippingPlane(new Cesium.Cartesian3(0, 1, 0), -halfNorth),
      new Cesium.ClippingPlane(new Cesium.Cartesian3(0, -1, 0), -halfNorth),
    ],
    // すべての面の内側にあるものだけを切り取る（論理積）
    unionClippingRegions: false,
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(centre),
    edgeWidth: 0,
  });
}

/**
 * 遠景 LOD1 の範囲。テクスチャを持たないぶん広く取れる。
 * 近景の半径は品質設定 (nearRadiusM) 側で端末に応じて決める。
 */
const FAR_RADIUS_M = 7000;
/** 読み込み済み範囲の縁からこれだけ内側に入ったら、範囲を取り直す */
const REFRESH_MARGIN_M = 1000;

/**
 * 範囲を取り直すとき、新しい建物が出そろうのを待つ上限 (ms)。
 *
 * これを超えたら、読めているぶんだけで切り替える。
 * 待ち続けると古い範囲と新しい範囲の両方をメモリに抱えることになる。
 */
const TILE_SWAP_TIMEOUT_MS = 8000;

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
    /** 配色を当てられなかったことを記録する（表示は続く） */
    private readonly onStyleError?: (message: string) => void,
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
      // 移動中もタイルを要求し続ける。強く間引くと、動かしている間は
      // 建物が現れず、止めた瞬間に一斉に出る（＝ちらつきの原因になる）。
      // Cesium の既定値と同じ 60 で、要求のむだ撃ちだけを抑える
      cullRequestsWhileMoving: true,
      cullRequestsWhileMovingMultiplier: 60,
      preloadWhenHidden: false,
      preloadFlightDestinations: true,

      /**
       * 中間 LOD を飛ばさず、親から順に精細化する。
       *
       * preferLeaves（葉タイルを先に要求する）は skipLevelOfDetail と
       * 組み合わせて使うもので、中間 LOD を全部読む設定と併せると
       * 「粗い親が出る前に葉を待つ」形になり、建物が出たり消えたりする。
       * 親から順に読めば、粗い状態から段階的に精細になるだけで済む。
       */
      skipLevelOfDetail: false,
      preferLeaves: false,

      /**
       * 低解像度で先に埋める機能は使わない。
       *
       * progressiveResolutionHeightFraction は、画面の一部を粗いタイルで
       * 先に埋めてから精細化する。Cesium の説明どおり、その切り替わりが
       * ポッピング（急な入れ替わり）として見える。
       * 粗いタイルを別途読むぶん通信も増えるので、切ると軽くもなる。
       */
      progressiveResolutionHeightFraction: 0,

      // 視線方向の奥ほど SSE を緩める。街を見渡す視点で読み込むタイル数を大きく減らせる
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4,

      /**
       * 視野の中心から離れたタイルの精細度を落とす。
       *
       * 読み込む量を減らす効果は大きいので残すが、遅延は入れない。
       * 遅延を入れると、カメラを動かしている間は周辺が読まれず、
       * 止めた瞬間に現れるため、周辺だけがちらついて見える。
       */
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.35,
      foveatedTimeDelay: 0,
      shadows: this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
    };
  }

  /**
   * スタイルを当てる。失敗しても建物そのものは表示する。
   *
   * スタイル式は文字列なので、型検査では誤りを見つけられない。
   * 属性名の書き方を間違えると Cesium3DTileStyle の生成時に例外が飛び、
   * そのまま外へ投げると「3D 都市データを読み込めませんでした」となって
   * 建物が 1 棟も出なくなる（浜松で実際に起きた）。
   * 色が付かないことより、街が出ないことのほうが重い。
   */
  private applyStyle(
    tileset: Cesium.Cesium3DTileset,
    build: () => Cesium.Cesium3DTileStyle,
  ): void {
    try {
      tileset.style = build();
    } catch (error) {
      console.warn('[map-engine] 建物の配色を適用できませんでした', error);
      this.onStyleError?.(`建物の配色を適用できません: ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * 都市を読み込む。既に別の都市が読み込まれていれば破棄してメモリを解放する。
   */
  async loadCity(city: City): Promise<LoadedCityTilesets> {
    if (this.loaded?.city.id === city.id) return this.loaded;

    this.unload();

    // 起動直後はカメラ周辺だけを読む。カメラが離れたら refreshForCamera が読み直す
    this.activeBBox = this.clampToCity(city, bboxAround(city.center, this.quality.nearRadiusM));
    const near = await Cesium.Cesium3DTileset.fromUrl(
      tilesetUrl(city, 'near', this.activeBBox),
      this.tilesetOptions(false),
    );
    near.shadows = this.quality.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    // 実写テクスチャがある都市には一切スタイルを当てない（それが事実の色そのもの）。
    // テクスチャが無い都市だけ、用途属性と実測高さで塗り分ける。
    if (city.texturedBuildings === false) {
      this.applyStyle(near, untexturedBuildingStyle);
    }
    this.watchLoadProgress(near);
    // 近景にはスタイルを当てない = PLATEAU の実写テクスチャの色をそのまま出す
    this.applyRealisticLighting(near);
    this.viewer.scene.primitives.add(near);

    this.loaded = { city, near };

    // 遠景は近景の表示が始まってから読む。
    // 同時に読むと開いた直後のリクエストとメモリ確保が集中し、
    // 端末によってはタブごと落ちる。近くから順に見えてくる方が体感も良い。
    if (city.far && this.quality.useFarTileset && needsFarTileset(city)) {
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
      this.applyStyle(far, farTilesetStyle);
      far.shadows = Cesium.ShadowMode.DISABLED;
      // 近景が描いている範囲は遠景から切り抜く。
      // 重ねると同じ建物が LOD2 の屋根形状と LOD1 の箱で二重に描かれる
      const hole = createHoleClipping(this.activeBBox);
      if (hole) far.clippingPlanes = hole;
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

    // タイル 1 枚の失敗は珍しくない（回線・配信側の都合）。
    // ただし多発するときは表示が欠けているので、件数を数えて後から見られるようにする
    const removeFailed = tileset.tileFailed.addEventListener(
      (error: { message?: string; url?: string }) => {
        this.onTileFailed?.(error?.message ?? error?.url ?? 'タイルを取得できませんでした');
      },
    );
    this.removeProgressListeners.push(removeFailed);
  }

  /** タイル取得に失敗したときの通知先（エンジンが設定する） */
  onTileFailed: ((detail: string) => void) | null = null;

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
    const next = this.clampToCity(city, bboxAround(center, this.quality.nearRadiusM));
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
      if (city.texturedBuildings === false) {
        this.applyStyle(tileset, untexturedBuildingStyle);
      }
      this.applyRealisticLighting(tileset);
      this.viewer.scene.primitives.add(tileset);

      const previous = this.loaded.near;
      this.loaded = { ...this.loaded, near: tileset };
      this.activeBBox = next;
      this.restoreAll();
      this.watchLoadProgress(tileset);

      // 新しい範囲の建物が出そろうまで、古いものを残しておく。
      //
      // fromUrl が返した時点のタイルセットは tileset.json を読んだだけで
      // 中身が空。ここで古いほうをすぐ消すと、読み込みが終わるまでの
      // 数秒間、街から建物が丸ごと消えてしまう。
      // カメラが 2km ほど動くたびにこれが起きていた。
      await this.waitForFirstTiles(tileset);
      // 待っている間にさらに読み直されていたら、この入れ替えは古い
      if (this.loaded?.near !== tileset) {
        this.viewer.scene.primitives.remove(tileset);
        return false;
      }
      this.viewer.scene.primitives.remove(previous);
      // 近景が動いたぶん、遠景のくり抜きも動かす
      this.updateFarClipping();
      return true;
    } catch {
      // 取り直しに失敗しても、今表示しているものはそのまま使える
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  /** 遠景のくり抜きを、いまの近景の範囲に合わせ直す */
  private updateFarClipping(): void {
    const far = this.loaded?.far;
    if (!far || !this.activeBBox) return;
    const next = createHoleClipping(this.activeBBox);
    if (next) far.clippingPlanes = next;
  }

  /**
   * 視界ぶんのタイルが読み終わるのを待つ。
   *
   * 読み込みが進まない場合に古いタイルセットを抱え続けるとメモリを圧迫するので、
   * 上限時間で打ち切る。打ち切っても新しいほうへ切り替えるだけで、
   * その時点で読めているぶんは表示される。
   */
  private waitForFirstTiles(tileset: Cesium.Cesium3DTileset): Promise<void> {
    if (tileset.tilesLoaded) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        remove();
        resolve();
      };
      const remove = tileset.initialTilesLoaded.addEventListener(finish);
      const timer = window.setTimeout(finish, TILE_SWAP_TIMEOUT_MS);
    });
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

  /**
   * メモリ削減で落とした遠景タイルセットを読み直す。
   *
   * 余裕が戻ったのに遠景が欠けたままだと、遠くの街並みが
   * 消えたように見え続けてしまう。
   */
  async restoreFarTileset(): Promise<void> {
    if (!this.loaded || this.loaded.far || !this.quality.useFarTileset) return;
    const city = this.loaded.city;
    if (!city.far) return;
    await this.loadFarTileset(city);
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
