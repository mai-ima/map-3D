/**
 * 街路樹・街灯・ベンチなどの装飾を描く。
 *
 * 重要な方針:
 *   位置は必ず OpenStreetMap の実データ（natural=tree, highway=street_lamp,
 *   amenity=bench）を使い、AI や乱数で「それらしい位置」を作らない。
 *
 * **寸法と形を決めるのはここではない。**
 * `packages/gis/src/street-furniture-geometry.ts` が形の記述（SceneShape）
 * を組み立て、ここはそれを Cesium で描くだけにしてある。
 * 以前はこのファイルの中で樹高や樹冠の大きさを決めていたため、
 * Swift へ移すときに寸法の決め方まで書き直しになるうえ、
 * 生成した形を測るテストも書けなかった。
 *
 * 描画は GeometryInstance をまとめた単一 Primitive にバッチ化し、
 * 数千本規模でもドローコールが増えないようにしている。
 */

import * as Cesium from 'cesium';
import type { BBox, SceneShape } from '@ijm/shared';
import { benchShapes, lampShapes, treeShapes } from '@ijm/gis';
import { liveScene, waitForPrimitives } from './primitive-swap';
import { batchShapes } from './scene-renderer';

export interface FurniturePoint {
  lat: number;
  lng: number;
  kind: 'tree' | 'street_lamp' | 'bench';
  /** OSM に高さがあれば使う */
  height?: number;
  /** OSM のタグ。樹種・樹高・樹冠幅を読む */
  tags?: Record<string, string>;
}

/**
 * 樹冠のかたまりを何個作るか。
 *
 * 1 個だと棒付きキャンディにしか見えない。一方、木 1 本あたりの形が増えると
 * 数千本では効いてくるので、近いときだけ細かくする。
 * 幹 0.3m の枝ぶりは 400m 離れると輪郭にしか出ないため、そこから先は 1 個。
 */
function blobsForDistance(distanceM: number): number {
  if (distanceM < 150) return 5;
  if (distanceM < 400) return 3;
  return 1;
}

export class StreetFurnitureLayer {
  /** いま表に出ているもの */
  private primitive: Cesium.Primitive | null = null;
  /** 組み立て中で、まだ入れ替えていないもの */
  private pending: Cesium.Primitive | null = null;
  private currentBBoxKey = '';
  /**
   * 組み立ての世代。
   *
   * build() は地形の標高取得を挟むので、終わるまでに次の要求や clear() が
   * 来ることがある。始めた時点の世代を控えておき、変わっていたら
   * 自分が作ったものを表に出さずに捨てる。
   */
  private generation = 0;

  /** カメラからの距離 (m)。近いときだけ枝ぶりを細かくする */
  private distanceM = 0;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private maxItems: number,
  ) {}

  /** 次に組み立てるときの詳細度を決める（カメラからの距離） */
  setDistance(distanceM: number): void {
    this.distanceM = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  }

  setMaxItems(max: number): void {
    this.maxItems = max;
    if (max === 0) this.clear();
  }

  /** 同じ範囲を二重に読み込まないためのキー */
  static bboxKey(bbox: BBox): string {
    return bbox.map((v) => v.toFixed(3)).join(',');
  }

  hasLoaded(bbox: BBox): boolean {
    return this.currentBBoxKey === StreetFurnitureLayer.bboxKey(bbox);
  }

  /**
   * 街路の設備を組み立てる。
   *
   * 組み上がるまで、いま出ているものは消さない。
   * 先に消してしまうと、地形の標高を取って数千本ぶんの頂点を組む間、
   * 街路樹や街灯が丸ごと消える。範囲を取り直すたびにこれが起きると
   * ちらついて見える。
   */
  async build(points: FurniturePoint[], bbox: BBox): Promise<void> {
    const gen = ++this.generation;
    // 出すものが無いときは、待つ相手もいないのですぐ消す
    if (this.maxItems <= 0 || points.length === 0) {
      this.clear();
      return;
    }

    const limited = points.slice(0, this.maxItems);

    // 地形高さを取得して正しく接地させる
    const cartographics = limited.map((p) => Cesium.Cartographic.fromDegrees(p.lng, p.lat));
    try {
      await Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, cartographics);
    } catch {
      // 地形が取れない場合は高さ 0 のまま（海抜 0m の平地扱い）
    }

    // 形と寸法は GIS 側で決める（Cesium に依存しない純粋な変換）
    const shapes: SceneShape[] = [];
    const blobs = blobsForDistance(this.distanceM);
    limited.forEach((point, i) => {
      const ground = cartographics[i]?.height ?? 0;
      const tags = point.tags ?? (point.height ? { height: String(point.height) } : {});
      if (point.kind === 'tree') {
        shapes.push(...treeShapes(point, { tags, ground, blobs }));
      } else if (point.kind === 'street_lamp') {
        shapes.push(...lampShapes(point, { tags, ground }));
      } else {
        shapes.push(...benchShapes(point, { ground }));
      }
    });

    const batches = batchShapes(shapes);
    const instances = [...batches.solids, ...batches.flatSolids];

    if (instances.length === 0) return;
    // 標高を取っている間に次の要求（または clear）が来ていたら、作らない
    if (gen !== this.generation) return;
    // 画面を離れていたら、もう触れない
    const scene = liveScene(this.viewer);
    if (!scene) return;

    const next: Cesium.Primitive = scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: false,
          closed: true,
        }),
        shadows: Cesium.ShadowMode.CAST_ONLY,
        // 頂点データは保持しない（GPU メモリを節約）
        releaseGeometryInstances: true,
        interleave: true,
      }),
    );
    this.pending = next;

    // 実際に描けるようになってから入れ替える
    await waitForPrimitives(scene, [next]);

    if (!liveScene(this.viewer)) {
      this.primitive = null;
      this.pending = null;
      return;
    }

    if (gen !== this.generation) {
      scene.primitives.remove(next);
      if (this.pending === next) this.pending = null;
      return;
    }

    const previous = this.primitive;
    this.primitive = next;
    this.pending = null;
    if (previous) scene.primitives.remove(previous);
    this.currentBBoxKey = StreetFurnitureLayer.bboxKey(bbox);
    scene.requestRender();
  }

  clear(): void {
    // 世代を進めて、組み立て中のものが後から現れないようにする
    this.generation += 1;
    const scene = liveScene(this.viewer);
    if (this.pending) {
      scene?.primitives.remove(this.pending);
      this.pending = null;
    }
    if (this.primitive) {
      scene?.primitives.remove(this.primitive);
      this.primitive = null;
    }
    this.currentBBoxKey = '';
  }
}
