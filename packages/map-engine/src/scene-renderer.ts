/**
 * 「形の記述」(SceneShape) を Cesium で描く。
 *
 * `packages/gis` は Cesium を知らないまま形だけを決め、ここが描く。
 * 将来 Swift（SceneKit / RealityKit）へ移すときは、
 * このファイルを置き換えれば、寸法を決める処理はそのまま使える。
 *
 * 描き分け:
 *
 *   GroundRibbon（地表の帯）
 *     幅 0.5m 以上 … CorridorGeometry を地表にクランプして面で描く。
 *                    舗装や横断歩道は実寸の面で見えないと嘘になる。
 *     幅 0.5m 未満 … GroundPolylineGeometry で線として描く。
 *                    区画線（幅 0.15m）を面で描くと、少し離れただけで
 *                    1 画素を割って消えてしまう。実際の地図や
 *                    カーナビも区画線は太さを保って描いている。
 *
 *   ExtrudedShape  … PolylineVolumeGeometry（線路の道床やレール）
 *   BoxShape       … BoxGeometry（信号の柱と灯器）
 *
 * 描画呼び出しを増やさないため、同じ描き方のものは
 * GeometryInstance にまとめて 1 つの Primitive にする。
 */

import * as Cesium from 'cesium';
import type {
  BoxShape,
  ExtrudedShape,
  GroundRibbon,
  LatLng,
  RevolvedShape,
  SceneShape,
  SpheroidShape,
} from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import { liveScene, waitForPrimitives } from './primitive-swap';

type AnyPrimitive =
  | Cesium.Primitive
  | Cesium.GroundPrimitive
  | Cesium.GroundPolylinePrimitive;

/** これより細い帯は面ではなく線として描く (m) */
const LINE_THRESHOLD_M = 0.5;

/**
 * 線として描くときの太さ (画素)。
 *
 * 実寸は 0.15m だが、画面上の太さで指定する。距離が変わっても
 * 区画線が消えたり潰れたりしない。
 */
const LINE_PIXEL_WIDTH = 2.2;

/**
 * 破線の見た目。
 *
 * 実際の車線境界線は 8m 引いて 12m 空ける（線 40%）。
 * Cesium の PolylineDash は周期を画素で指定するので、実寸では再現できない。
 * 比率だけを合わせる: 16 ビット中 6 ビットを立てて 37.5%。
 *
 * 位置と本数は OSM の実データどおりで、ここで近似しているのは
 * 「破線の刻みの細かさ」だけ。
 */
const DASH_PATTERN = 0b0000000000111111;
const DASH_LENGTH_PX = 28;

/** 横断歩道の縞を切り出す上限（1 本あたり） */
const MAX_ZEBRA_STRIPES = 40;

const colorCache = new Map<string, Cesium.Color>();
function colorOf(css: string): Cesium.Color {
  let c = colorCache.get(css);
  if (!c) {
    c = Cesium.Color.fromCssColorString(css);
    colorCache.set(css, c);
  }
  return c;
}

/** 同じ位置が続くと CorridorGeometry が例外を投げるので取り除く */
function dedupe(path: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

function positionsOf(path: LatLng[]): Cesium.Cartesian3[] {
  return path.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat));
}

/** 2 点間を比率 t で内挿する */
function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * 経路を「線 on メートル・空き off メートル」の繰り返しで切り分ける。
 *
 * 横断歩道の縞（45cm ごと）を実寸の面として描くために使う。
 * 縞は歩く向きに直交して並ぶので、経路に沿って刻めばよい。
 */
export function dashPath(
  path: LatLng[],
  on: number,
  off: number,
  maxPieces = MAX_ZEBRA_STRIPES,
): LatLng[][] {
  const pieces: LatLng[][] = [];
  const period = on + off;
  if (period <= 0 || path.length < 2) return pieces;

  // 経路上の距離を進めながら、線の区間だけを拾う。
  // 区間ごとに刻み直すのではなく通算の距離で位相を決める。
  // そうしないと、折れ線の頂点のたびに縞がずれる
  let travelled = 0;
  let current: LatLng[] | null = null;

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const segment = distanceMeters(a, b);
    if (!(segment > 0)) continue;

    let cursor = 0;
    while (cursor < segment) {
      const phase = (travelled + cursor) % period;
      const inLine = phase < on;
      // いまの状態が続く長さ。
      // 位相がちょうど境目に乗ると 0 になり、進まないまま回り続けるので、
      // 必ず前へ進む最小の刻みを入れておく
      const remaining = Math.max(1e-6, inLine ? on - phase : period - phase);
      const step = Math.min(remaining, segment - cursor);

      if (inLine) {
        const start = lerp(a, b, cursor / segment);
        const end = lerp(a, b, Math.min(1, (cursor + step) / segment));
        if (!current) {
          if (pieces.length >= maxPieces) return pieces;
          current = [start];
          pieces.push(current);
        }
        current.push(end);
      } else {
        current = null;
      }
      cursor += step;
    }
    travelled += segment;
  }
  return pieces;
}

/** 面として描く帯 */
function corridorInstance(ribbon: GroundRibbon, path: LatLng[]): Cesium.GeometryInstance | null {
  const clean = dedupe(path);
  if (clean.length < 2) return null;
  return new Cesium.GeometryInstance({
    id: ribbon.id,
    geometry: new Cesium.CorridorGeometry({
      positions: positionsOf(clean),
      width: ribbon.width,
      // 交差点で角が尖ると不自然なので丸める
      cornerType: Cesium.CornerType.ROUNDED,
      vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(ribbon.color)),
    },
  });
}

/** 線として描く帯（区画線） */
function polylineInstance(ribbon: GroundRibbon): Cesium.GeometryInstance | null {
  const clean = dedupe(ribbon.path);
  if (clean.length < 2) return null;
  return new Cesium.GeometryInstance({
    id: ribbon.id,
    geometry: new Cesium.GroundPolylineGeometry({
      positions: positionsOf(clean),
      width: LINE_PIXEL_WIDTH,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(ribbon.color)),
    },
  });
}

function extrusionInstance(shape: ExtrudedShape): Cesium.GeometryInstance | null {
  const clean: typeof shape.path = [];
  for (const p of shape.path) {
    const last = clean[clean.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lng - p.lng) < 1e-9) continue;
    clean.push(p);
  }
  if (clean.length < 2 || shape.section.length < 3) return null;

  return new Cesium.GeometryInstance({
    id: shape.id,
    geometry: new Cesium.PolylineVolumeGeometry({
      polylinePositions: clean.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lng, p.lat, p.alt ?? 0),
      ),
      // 断面は y = 0 を下端として書く決まり。
      // PolylineVolumeGeometry は外接矩形で正規化するので、
      // y の絶対値は無視され、中心線から必ず上へ押し出される
      shapePositions: shape.section.map((s) => new Cesium.Cartesian2(s.x, s.y)),
      cornerType: Cesium.CornerType.MITERED,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(shape.color)),
    },
  });
}

function boxInstance(shape: BoxShape): Cesium.GeometryInstance {
  const { x, y, z } = shape.size;
  const centre = Cesium.Cartesian3.fromDegrees(
    shape.centre.lng,
    shape.centre.lat,
    shape.centre.alt ?? 0,
  );
  const frame = Cesium.Transforms.headingPitchRollToFixedFrame(
    centre,
    new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(shape.headingDeg), 0, 0),
  );

  return new Cesium.GeometryInstance({
    id: shape.id,
    modelMatrix: frame,
    geometry: Cesium.BoxGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(x, y, z),
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(shape.color)),
    },
  });
}

/**
 * 縦に立てた回転体。
 *
 * Cesium の CylinderGeometry は中心が原点なので、
 * 底面を指定の高さに合わせるには半分だけ持ち上げる。
 */
function revolvedInstance(shape: RevolvedShape): Cesium.GeometryInstance {
  const centre = Cesium.Cartesian3.fromDegrees(
    shape.base.lng,
    shape.base.lat,
    (shape.base.alt ?? 0) + shape.height / 2,
  );
  return new Cesium.GeometryInstance({
    id: shape.id,
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(centre),
    geometry: new Cesium.CylinderGeometry({
      length: Math.max(0.01, shape.height),
      topRadius: Math.max(0, shape.topRadius),
      bottomRadius: Math.max(0.001, shape.bottomRadius),
      // 木の幹や柱は細い。分割を上げても画面上はほとんど変わらないので、
      // 頂点数を抑えるほうを取る
      slices: 12,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(shape.color)),
    },
  });
}

/** 回転楕円体（樹冠のかたまり） */
function spheroidInstance(shape: SpheroidShape): Cesium.GeometryInstance {
  const centre = Cesium.Cartesian3.fromDegrees(
    shape.centre.lng,
    shape.centre.lat,
    shape.centre.alt ?? 0,
  );
  const r = Math.max(0.05, shape.radius);
  return new Cesium.GeometryInstance({
    id: shape.id,
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(centre),
    geometry: new Cesium.EllipsoidGeometry({
      radii: new Cesium.Cartesian3(r, r, Math.max(0.05, shape.heightRadius)),
      stackPartitions: 7,
      slicePartitions: 9,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorOf(shape.color)),
    },
  });
}

/** 描き方ごとに振り分けた GeometryInstance */
interface Batches {
  /** 地表に貼る面。order ごとに分ける（小さいほど奥） */
  corridors: Map<number, Cesium.GeometryInstance[]>;
  /** 地表に貼る実線 */
  lines: Cesium.GeometryInstance[];
  /** 地表に貼る破線 */
  dashed: Cesium.GeometryInstance[];
  /** 立体（影を落とす / 落とさない） */
  solids: Cesium.GeometryInstance[];
  flatSolids: Cesium.GeometryInstance[];
}

/**
 * 形の記述を、描き方ごとの GeometryInstance に振り分ける。
 *
 * 描画そのものは行わないので、この関数だけを取り出して検証できる。
 */
export function batchShapes(shapes: SceneShape[]): Batches {
  const batches: Batches = {
    corridors: new Map(),
    lines: [],
    dashed: [],
    solids: [],
    flatSolids: [],
  };

  const pushCorridor = (order: number, instance: Cesium.GeometryInstance | null) => {
    if (!instance) return;
    const list = batches.corridors.get(order);
    if (list) list.push(instance);
    else batches.corridors.set(order, [instance]);
  };

  for (const shape of shapes) {
    switch (shape.kind) {
      case 'ribbon': {
        const order = shape.order ?? 0;
        if (shape.width >= LINE_THRESHOLD_M) {
          if (shape.dash) {
            // 横断歩道のような太い破線は、実寸の縞に切り分けて面で描く
            for (const piece of dashPath(shape.path, shape.dash[0], shape.dash[1])) {
              pushCorridor(order, corridorInstance(shape, piece));
            }
          } else {
            pushCorridor(order, corridorInstance(shape, shape.path));
          }
        } else {
          const instance = polylineInstance(shape);
          if (instance) (shape.dash ? batches.dashed : batches.lines).push(instance);
        }
        break;
      }
      case 'extrusion': {
        const instance = extrusionInstance(shape);
        if (instance) {
          (shape.castsShadow === false ? batches.flatSolids : batches.solids).push(instance);
        }
        break;
      }
      case 'box': {
        const instance = boxInstance(shape);
        (shape.castsShadow === false ? batches.flatSolids : batches.solids).push(instance);
        break;
      }
      case 'revolved': {
        const instance = revolvedInstance(shape);
        (shape.castsShadow === false ? batches.flatSolids : batches.solids).push(instance);
        break;
      }
      case 'spheroid': {
        const instance = spheroidInstance(shape);
        (shape.castsShadow === false ? batches.flatSolids : batches.solids).push(instance);
        break;
      }
    }
  }

  return batches;
}

/**
 * 振り分けた GeometryInstance を Primitive にして scene に足す。
 *
 * 高架のレイヤからも使う。追加した順が重なり順になるので、
 * 地表の面を order の小さいものから先に足す。
 */
export function buildPrimitives(
  scene: Cesium.Scene,
  batches: Batches,
  shadows: Cesium.ShadowMode,
): AnyPrimitive[] {
  const out: AnyPrimitive[] = [];

  // 地表に貼る面。order の小さいものから追加して重なり順を作る
  // （舗装 → 外側線 → 車線境界線 → 中央線 → 横断歩道）
  // 対応の可否は描くものがあるときだけ調べる。isSupported は
  // WebGL の文脈を覗きに行くので、立体しか無いときに呼ぶ理由がない
  if (batches.corridors.size > 0 && Cesium.GroundPrimitive.isSupported(scene)) {
    for (const order of [...batches.corridors.keys()].sort((a, b) => a - b)) {
      const instances = batches.corridors.get(order) ?? [];
      if (instances.length === 0) continue;
      out.push(
        scene.primitives.add(
          new Cesium.GroundPrimitive({
            geometryInstances: instances,
            // 建物には貼らない。道路の舗装が建物の壁を這い上がって見える
            classificationType: Cesium.ClassificationType.TERRAIN,
            asynchronous: true,
          }),
        ),
      );
    }
  }

  const hasLines = batches.lines.length > 0 || batches.dashed.length > 0;
  if (hasLines && Cesium.GroundPolylinePrimitive.isSupported(scene)) {
    if (batches.lines.length > 0) {
      out.push(
        scene.primitives.add(
          new Cesium.GroundPolylinePrimitive({
            geometryInstances: batches.lines,
            appearance: new Cesium.PolylineColorAppearance(),
            classificationType: Cesium.ClassificationType.TERRAIN,
            asynchronous: true,
          }),
        ),
      );
    }
    if (batches.dashed.length > 0) {
      out.push(
        scene.primitives.add(
          new Cesium.GroundPolylinePrimitive({
            geometryInstances: batches.dashed,
            appearance: new Cesium.PolylineMaterialAppearance({
              material: Cesium.Material.fromType('PolylineDash', {
                color: colorOf('#dcd9d0'),
                gapColor: Cesium.Color.TRANSPARENT,
                dashLength: DASH_LENGTH_PX,
                dashPattern: DASH_PATTERN,
              }),
            }),
            classificationType: Cesium.ClassificationType.TERRAIN,
            asynchronous: true,
          }),
        ),
      );
    }
  }

  for (const [instances, mode] of [
    [batches.solids, shadows],
    [batches.flatSolids, Cesium.ShadowMode.DISABLED],
  ] as const) {
    if (instances.length === 0) continue;
    out.push(
      scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: false,
            translucent: false,
            closed: true,
          }),
          shadows: mode,
          asynchronous: true,
        }),
      ),
    );
  }

  return out;
}

/**
 * 形の記述をひとまとまりとして出し入れするレイヤ。
 *
 * 高架や街路の設備と同じく、新しいものが描けるようになってから
 * 古いものを消す。先に消すと、組み立ての間そこが空白になり
 * ちらついて見える。
 */
export class SceneShapeLayer {
  /** いま表に出ているもの */
  private primitives: AnyPrimitive[] = [];
  /** 組み立て中で、まだ入れ替えていないもの */
  private pending: AnyPrimitive[] = [];
  private loadedKey: string | null = null;
  private shadows: Cesium.ShadowMode = Cesium.ShadowMode.ENABLED;
  /** 組み立ての世代。追い越されたものを捨てるために使う */
  private generation = 0;

  constructor(private readonly viewer: Cesium.Viewer) {}

  get count(): number {
    return this.primitives.length;
  }

  /** すでにこの内容が出ているか */
  hasLoaded(key: string): boolean {
    return this.loadedKey === key;
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    for (const p of [...this.primitives, ...this.pending]) {
      if (p instanceof Cesium.Primitive) p.shadows = this.shadows;
    }
  }

  async render(shapes: SceneShape[], key: string): Promise<void> {
    if (this.loadedKey === key) return;
    const gen = ++this.generation;
    this.loadedKey = key;

    if (shapes.length === 0) {
      this.clear();
      this.loadedKey = key;
      return;
    }

    const scene = liveScene(this.viewer);
    if (!scene) return;
    const next = buildPrimitives(scene, batchShapes(shapes), this.shadows);

    this.pending = next;
    await waitForPrimitives(scene, next);

    // 待っている間に画面を離れていたら、もう触れない
    if (!liveScene(this.viewer)) {
      this.primitives = [];
      this.pending = [];
      return;
    }

    // 待っている間に次の要求（または clear）が来ていたら、表に出さずに捨てる
    if (gen !== this.generation) {
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

  clear(): void {
    // 世代を進めて、組み立て中のものが後から現れないようにする
    this.generation += 1;
    const scene = liveScene(this.viewer);
    if (scene) {
      for (const p of [...this.primitives, ...this.pending]) scene.primitives.remove(p);
    }
    this.primitives = [];
    this.pending = [];
    this.loadedKey = null;
  }
}
