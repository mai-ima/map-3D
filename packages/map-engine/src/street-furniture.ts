/**
 * 街路樹・街灯・ベンチなどの装飾。
 *
 * 重要な方針:
 *   位置は必ず OpenStreetMap の実データ（natural=tree, highway=street_lamp, amenity=bench）を使い、
 *   AI や乱数で「それらしい位置」を作らない。見た目（ジオメトリ）だけを手続き的に生成する。
 *
 * 描画は GeometryInstance をまとめた単一 Primitive にバッチ化し、
 * 数千本規模でもドローコールが増えないようにしている。
 */

import * as Cesium from 'cesium';
import type { BBox } from '@ijm/shared';
import { waitForPrimitives } from './primitive-swap';

export interface FurniturePoint {
  lat: number;
  lng: number;
  kind: 'tree' | 'street_lamp' | 'bench';
  /** OSM に高さがあれば使う */
  height?: number;
}

const TRUNK_COLOR = Cesium.Color.fromCssColorString('#6b5844');
const CANOPY_COLORS = [
  Cesium.Color.fromCssColorString('#4b7f3f'),
  Cesium.Color.fromCssColorString('#568c46'),
  Cesium.Color.fromCssColorString('#3f6f36'),
];
const LAMP_COLOR = Cesium.Color.fromCssColorString('#8d949c');
const LAMP_HEAD_COLOR = Cesium.Color.fromCssColorString('#ffe9b0');
const BENCH_COLOR = Cesium.Color.fromCssColorString('#8a6f4e');

/** 位置に対して決定的な擬似乱数（同じ木は常に同じ大きさになる） */
function hash01(lat: number, lng: number, salt = 0): number {
  const x = Math.sin(lat * 12.9898 + lng * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
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

  constructor(
    private readonly viewer: Cesium.Viewer,
    private maxItems: number,
  ) {}

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

    const instances: Cesium.GeometryInstance[] = [];

    limited.forEach((point, i) => {
      const groundHeight = cartographics[i]?.height ?? 0;
      const r1 = hash01(point.lat, point.lng, 1);
      const r2 = hash01(point.lat, point.lng, 2);

      if (point.kind === 'tree') {
        const trunkHeight = 2.2 + r1 * 1.6;
        const canopyRadius = 2.0 + r2 * 1.4;
        const canopyHeight = 3.0 + r1 * 2.0;

        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({
              length: trunkHeight,
              topRadius: 0.18,
              bottomRadius: 0.26,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
              Cesium.Cartesian3.fromDegrees(point.lng, point.lat, groundHeight + trunkHeight / 2),
            ),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(TRUNK_COLOR),
            },
          }),
        );

        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.EllipsoidGeometry({
              radii: new Cesium.Cartesian3(canopyRadius, canopyRadius, canopyHeight / 2),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
              stackPartitions: 8,
              slicePartitions: 10,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
              Cesium.Cartesian3.fromDegrees(
                point.lng,
                point.lat,
                groundHeight + trunkHeight + canopyHeight / 2.4,
              ),
            ),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                CANOPY_COLORS[i % CANOPY_COLORS.length],
              ),
            },
          }),
        );
      } else if (point.kind === 'street_lamp') {
        const poleHeight = point.height ?? 4.5 + r1 * 1.5;
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({
              length: poleHeight,
              topRadius: 0.08,
              bottomRadius: 0.14,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
              Cesium.Cartesian3.fromDegrees(point.lng, point.lat, groundHeight + poleHeight / 2),
            ),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(LAMP_COLOR) },
          }),
        );
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.BoxGeometry({
              minimum: new Cesium.Cartesian3(-0.45, -0.18, -0.12),
              maximum: new Cesium.Cartesian3(0.45, 0.18, 0.12),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
              Cesium.Cartesian3.fromDegrees(point.lng, point.lat, groundHeight + poleHeight),
            ),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(LAMP_HEAD_COLOR) },
          }),
        );
      } else {
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.BoxGeometry({
              minimum: new Cesium.Cartesian3(-0.9, -0.25, -0.22),
              maximum: new Cesium.Cartesian3(0.9, 0.25, 0.22),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
              Cesium.Cartesian3.fromDegrees(point.lng, point.lat, groundHeight + 0.45),
            ),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(BENCH_COLOR) },
          }),
        );
      }
    });

    if (instances.length === 0) return;
    // 標高を取っている間に次の要求（または clear）が来ていたら、作らない
    if (gen !== this.generation) return;

    const next: Cesium.Primitive = this.viewer.scene.primitives.add(
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
    await waitForPrimitives(this.viewer.scene, [next]);

    if (gen !== this.generation) {
      this.viewer.scene.primitives.remove(next);
      if (this.pending === next) this.pending = null;
      return;
    }

    const previous = this.primitive;
    this.primitive = next;
    this.pending = null;
    if (previous) this.viewer.scene.primitives.remove(previous);
    this.currentBBoxKey = StreetFurnitureLayer.bboxKey(bbox);
    this.viewer.scene.requestRender();
  }

  clear(): void {
    // 世代を進めて、組み立て中のものが後から現れないようにする
    this.generation += 1;
    if (this.pending) {
      this.viewer.scene.primitives.remove(this.pending);
      this.pending = null;
    }
    if (this.primitive) {
      this.viewer.scene.primitives.remove(this.primitive);
      this.primitive = null;
    }
    this.currentBBoxKey = '';
  }
}
