/**
 * 高架・橋梁を描く。
 *
 * 寸法を決めるところは `@ijm/gis` の structure-geometry にあり、
 * ここは「地形の標高を取ってきて渡す」ことと「描く」ことだけを行う。
 * この分け方にしてあるのは、将来 Swift（SceneKit / RealityKit）へ移すとき、
 * 寸法の決め方をそのまま持っていけるようにするため。
 *
 * PLATEAU の橋梁モデルが無い地域（浜松市など）では、街の骨格である
 * 高架がまったく見えず、線路や道路が地面に張り付いたままになってしまう。
 * OpenStreetMap の bridge / layer から構造を組み立てて補う。
 */

import * as Cesium from 'cesium';
import type { ElevatedStructure, LatLng } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import {
  MAX_FRAME_SHAPES,
  buildStructureShapes,
  measurePath,
  pickIndices,
  valueAt,
} from '@ijm/gis';
import { batchShapes, buildPrimitives } from './scene-renderer';

/**
 * 高架の上に軌道を敷く上限のカメラ高度 (m)。
 *
 * 軌道スラブの幅は 2.34m。視野角 60 度・幅 400 画素の画面では、
 * 1,500m 上空からおよそ 0.5 画素になる。そこから先は描いても見えない。
 */
const ELEVATED_TRACK_MAX_HEIGHT_M = 1500;
import { liveScene, waitForPrimitives } from './primitive-swap';

/**
 * 地形の標高を取る間隔 (m)。
 *
 * 高架は長いものだと 1km を超える。頂点ごとに取ると数千件になるが、
 * 標高そのものは数十メートル単位でしか変わらない。
 * 代表点だけ取って間を補間する。
 */
const TERRAIN_SAMPLE_INTERVAL_M = 60;
/** 1 本の経路から取る標高の上限 */
const MAX_TERRAIN_SAMPLES_PER_PATH = 48;

type AnyPrimitive = Cesium.Primitive | Cesium.GroundPrimitive | Cesium.GroundPolylinePrimitive;

export class ElevatedStructureLayer {
  /** いま表に出ているもの */
  private primitives: AnyPrimitive[] = [];
  /** 組み立て中で、まだ入れ替えていないもの */
  private pending: AnyPrimitive[] = [];
  private loadedKey: string | null = null;
  private shadows: Cesium.ShadowMode = Cesium.ShadowMode.ENABLED;

  constructor(private readonly viewer: Cesium.Viewer) {}

  /** 影を落とすかどうかを品質設定に合わせる */
  setShadows(enabled: boolean): void {
    this.shadows = enabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    // 組み立て中のものは生成時の設定のままなので、そちらにも反映する
    for (const p of [...this.primitives, ...this.pending]) {
      if (p instanceof Cesium.Primitive) p.shadows = this.shadows;
    }
  }

  get count(): number {
    return this.primitives.length;
  }

  /**
   * 構造物を描画する。
   *
   * 地形の標高は非同期でしか取れないので、経路上の代表点をまとめて取得し、
   * 頂点間は補間する。柱の足元は実際の地表、床版は均した路盤に合わせる。
   *
   * 組み立てが終わるまで、いま出ているものは消さない。
   * 先に消してしまうと、標高の取得とジオメトリの組み立てが終わるまでの
   * 数秒間、高架が丸ごと画面から消える。カメラが動くたびにこれが起きると
   * 高架が点滅しているように見える。
   */
  async render(structures: ElevatedStructure[], key: string): Promise<void> {
    if (this.loadedKey === key) return;
    this.loadedKey = key;

    // 空になるときだけは、待つものが無いのですぐ消す
    // （clear() は loadedKey を消すので、消してから入れ直す）
    if (structures.length === 0) {
      this.clear();
      this.loadedKey = key;
      return;
    }

    // 柱の予算は限られているので、カメラに近いものから使う。
    // 床版と壁は全部に付けるので、遠くの高架が消えることはない
    const ordered = this.sortByDistance(structures);
    const distances = this.distancesFrom(ordered);
    const ground = await this.sampleGround(ordered);

    /**
     * 高架の上の軌道は、上空から見るときだけ落とす。
     *
     * スラブ 1 本 + レール 2 本で、線路 1 本につき 3 形。
     * 軌道スラブの幅 2.34m は上空 1,500m から見ると 1 画素を割る。
     */
    // camera が無い経路もある（破棄後・テストの疑似 Viewer）。
    // 読めなければ地上にいるものとして軌道を敷く
    const cameraHeight = this.viewer.camera?.positionCartographic?.height ?? 0;
    const shapes = buildStructureShapes(ordered, {
      ground,
      distances,
      frameBudget: MAX_FRAME_SHAPES,
      tracks: cameraHeight < ELEVATED_TRACK_MAX_HEIGHT_M,
    });

    // 標高の取得を待っている間に画面を離れているかもしれない
    const scene = liveScene(this.viewer);
    if (!scene) return;

    // 床版・柱・防音壁を別のまとまりにする。
    // 防音壁は影を落とさない設定にできるよう分けてある
    const next: AnyPrimitive[] = [];
    for (const group of [shapes.deck, shapes.frame, shapes.parapet]) {
      if (group.length === 0) continue;
      next.push(...buildPrimitives(scene, batchShapes(group), this.shadows));
    }
    this.pending = next;

    await waitForPrimitives(scene, next);

    if (!liveScene(this.viewer)) {
      this.primitives = [];
      this.pending = [];
      return;
    }

    // 待っている間に次の要求（または clear）が来ていたら、いま作ったほうが古い。
    // 表に出さずに捨てる（新しいほうが自分で入れ替える）
    if (this.loadedKey !== key) {
      for (const p of next) scene.primitives.remove(p);
      if (this.pending === next) this.pending = [];
      return;
    }

    const previous = this.primitives;
    this.primitives = next;
    this.pending = [];
    for (const p of previous) scene.primitives.remove(p);
    scene.requestRender();
  }

  /**
   * カメラに近い順に並べ替える。
   *
   * 柱の予算が足りないときに、目の前の高架から柱が抜けると目立つ。
   * カメラの位置が取れない場合は元の順序のままにする。
   */
  private sortByDistance(structures: ElevatedStructure[]): ElevatedStructure[] {
    const eye = this.eyePosition();
    if (!eye) return structures;
    return [...structures].sort((a, b) => this.nearestOf(a, eye) - this.nearestOf(b, eye));
  }

  /** 各構造物までの距離 (m)。視点が取れなければ 0（＝最高精細） */
  private distancesFrom(structures: ElevatedStructure[]): number[] {
    const eye = this.eyePosition();
    if (!eye) return structures.map(() => 0);
    return structures.map((s) => this.nearestOf(s, eye));
  }

  private eyePosition(): LatLng | null {
    const carto = this.viewer.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lng: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  /** 経路の頂点のうち、視点にもっとも近いものまでの距離 (m) */
  private nearestOf(s: ElevatedStructure, eye: LatLng): number {
    let min = Infinity;
    // 長い経路の全頂点を見る必要はない。等間隔に拾えば十分
    for (const i of pickIndices(s.path.length, 8)) {
      min = Math.min(min, distanceMeters(eye, s.path[i]));
    }
    return min;
  }

  /** 経路上の代表点の標高を取得する。取れなければ 0（平地では実害が小さい） */
  private async sampleGround(structures: ElevatedStructure[]): Promise<number[][]> {
    const fallback = structures.map((s) => s.path.map(() => 0));

    const terrain = this.viewer.terrainProvider;
    if (!terrain || terrain instanceof Cesium.EllipsoidTerrainProvider) return fallback;

    // どの構造物のどの頂点を取ったかを覚えておく
    const requests: Cesium.Cartographic[] = [];
    const slots: { structure: number; vertex: number }[] = [];
    structures.forEach((s, si) => {
      // 長い高架ほど多く取る。粗いと路面が折れ線状にでこぼこする
      const wanted = Math.min(
        MAX_TERRAIN_SAMPLES_PER_PATH,
        Math.max(4, Math.ceil(measurePath(s.path).total / TERRAIN_SAMPLE_INTERVAL_M) + 1),
      );
      for (const vi of pickIndices(s.path.length, wanted)) {
        requests.push(Cesium.Cartographic.fromDegrees(s.path[vi].lng, s.path[vi].lat));
        slots.push({ structure: si, vertex: vi });
      }
    });
    if (requests.length === 0) return fallback;

    try {
      const sampled = await Cesium.sampleTerrainMostDetailed(terrain, requests);
      // 取れた頂点だけ埋め、間は前後から補間する
      const known: Map<number, { vertex: number; height: number }[]> = new Map();
      sampled.forEach((c, i) => {
        const slot = slots[i];
        const list = known.get(slot.structure) ?? [];
        list.push({ vertex: slot.vertex, height: c.height ?? 0 });
        known.set(slot.structure, list);
      });

      return structures.map((s, si) => {
        const list = known.get(si);
        if (!list || list.length === 0) return s.path.map(() => 0);
        list.sort((a, b) => a.vertex - b.vertex);
        const idx = list.map((p) => p.vertex);
        const val = list.map((p) => p.height);
        return s.path.map((_, vi) => valueAt(val, idx, vi));
      });
    } catch {
      return fallback;
    }
  }

  clear(): void {
    // 組み立て中のものも消す。表示を切ったのに、数秒後に
    // 出来上がったものが現れる、ということが起きないように
    const scene = liveScene(this.viewer);
    if (scene) {
      for (const p of [...this.primitives, ...this.pending]) scene.primitives.remove(p);
    }
    this.primitives = [];
    this.pending = [];
    this.loadedKey = null;
  }
}
