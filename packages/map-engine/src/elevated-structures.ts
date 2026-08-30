/**
 * 高架・橋梁を立体として描く。
 *
 * PLATEAU の橋梁モデルが無い地域（浜松市など）では、街の骨格である
 * 高架がまったく見えず、線路や道路が地面に張り付いたままになってしまう。
 * OpenStreetMap の bridge / layer から構造を組み立てて補う。
 *
 * 実データと補完の切り分け:
 *   - 位置・形状・幅（車線数/線路数）・上下関係（layer）… OSM の実データ
 *   - 床版の厚み・梁の高さ・柱の間隔と断面 … 種別ごとの標準的な設計値
 * 形状そのものを創作しているわけではなく、断面の寸法を標準値で補っている。
 *
 * 形式ごとに造りが違うので、それぞれ別の組み立てをする:
 *
 *   rigid-frame（ラーメン高架橋 / 都市部の鉄道高架）
 *     床版 + 縦梁 2 本 + 横梁 + 柱 2 本を 1 径間として繰り返す。
 *     径間が 8.9m と短く、柱が細かく連続するのがこの形式の見た目そのもの。
 *
 *   girder（桁橋 / 道路橋・鉄道橋）
 *     床版 + 箱桁 1 本 + 柱頭部 + 柱。支間 30m 前後で柱はまばら。
 *
 *   slab（歩道橋）
 *     薄い床版 + 細い柱。
 */

import * as Cesium from 'cesium';
import type { ElevatedStructure, LatLng, StructureKind } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';

/**
 * 材質。
 *
 * 実際の構造物に塗られている色は OSM には入っていないため、
 * 「コンクリート」「鋼」といった一般的な材質の色に留めている。
 * 特定の構造物の色を創作しないという方針による。
 */
const MATERIAL: Record<StructureKind, { deck: Cesium.Color; pier: Cesium.Color }> = {
  'rail-elevated': {
    deck: Cesium.Color.fromCssColorString('#b8b4ad'),
    pier: Cesium.Color.fromCssColorString('#aca8a1'),
  },
  'rail-bridge': {
    deck: Cesium.Color.fromCssColorString('#9d9a95'),
    pier: Cesium.Color.fromCssColorString('#aca8a1'),
  },
  'road-elevated': {
    deck: Cesium.Color.fromCssColorString('#bcb8b1'),
    pier: Cesium.Color.fromCssColorString('#b0aca5'),
  },
  'road-bridge': {
    deck: Cesium.Color.fromCssColorString('#b5b1aa'),
    pier: Cesium.Color.fromCssColorString('#aaa6a0'),
  },
  footbridge: {
    deck: Cesium.Color.fromCssColorString('#c2beb7'),
    pier: Cesium.Color.fromCssColorString('#b4b0a9'),
  },
};

/**
 * 柱・梁の総数の上限。
 *
 * 径間 8.9m のラーメン高架橋は 100m で 11 径間ぶんの柱が並ぶ。
 * 浜松駅周辺 1.7km 四方の実測では、東海道本線・新幹線の高架だけで
 * 7,000 個を超える。
 *
 * まとめる処理の実測コスト（Cesium の GeometryPipeline）:
 *   1,000 個 34ms / 0.6MB、6,000 個 74ms / 3.8MB、9,000 個 77ms / 5.8MB
 * 個数にはほぼ比例しないが、頂点バッファはそのまま増える。
 * iPhone のメモリ予算（3D タイルで 160MB）を考えて 6,000 個で止める。
 * 足りない場合はカメラから遠い構造物の柱から省く。
 */
const MAX_FRAME_INSTANCES = 6000;

/** 1 構造物あたりの地形サンプル数。全頂点を取ると数が多すぎる */
const TERRAIN_SAMPLES_PER_PATH = 12;

/** 桁下高を確保するために地表を均す距離 (m) */
const GRADE_WINDOW_M = 60;

/**
 * 断面を Cesium の座標に直す。
 *
 * PolylineVolumeGeometry は断面の外接矩形を基準に位置を決める。
 * 中心線には矩形の「左右中央」と「下端」が合わせられ、そこから上へ立ち上がる
 * （Workers/chunk の convertShapeTo3D が x も y も外接矩形ぶん引いている）。
 * つまり断面に書いた y の絶対値は無視され、形だけが使われる。
 *
 * そのため断面は必ず y = 0 を下端として書き、
 * 中心線の高さにはその部材の「下面」を渡す。
 * これを取り違えると、防音壁が床版の裏にぶら下がる。
 */
function section(points: [number, number][]): Cesium.Cartesian2[] {
  return points.map(([x, y]) => new Cesium.Cartesian2(x, y));
}

/**
 * 床版の断面。下端が床版の下面、上端が路面。
 * 張り出し部の先端を薄くして、拡大したときに板が浮いて見えないようにする。
 */
function slabShape(width: number, thickness: number): Cesium.Cartesian2[] {
  const hw = width / 2;
  const tipT = thickness * 0.55;
  const haunch = Math.min(hw * 0.35, 1.2);
  return section([
    [-hw, thickness],
    [hw, thickness],
    [hw, thickness - tipT],
    [hw - haunch, 0],
    [-hw + haunch, 0],
    [-hw, thickness - tipT],
  ]);
}

/** 縦梁・箱桁の断面。下端が梁の下面。下側をわずかに絞る */
function girderShape(width: number, depth: number): Cesium.Cartesian2[] {
  const hw = width / 2;
  const bw = hw * 0.86;
  const chamfer = Math.min(0.3, depth * 0.2);
  return section([
    [-hw, depth],
    [hw, depth],
    [hw, chamfer],
    [bw, 0],
    [-bw, 0],
    [-hw, chamfer],
  ]);
}

/**
 * 高欄・防音壁の断面。下端が床版の上面。
 *
 * 壁を床版の縁にそのまま立てると、遠目には床版と一体の厚い板に見えてしまう。
 * 実物と同じく、縁の地覆（低い立ち上がり）の上に一段細い壁を載せる。
 * この段差が側面に影の線を作り、拡大したときに造りが読み取れるようになる。
 */
function parapetShape(height: number, thickness: number, curbWidth: number): Cesium.Cartesian2[] {
  const t = thickness / 2;
  const cw = Math.max(curbWidth, thickness * 1.8) / 2;
  const curbH = Math.min(0.4, height * 0.3);
  const cap = height - 0.12; // 笠木
  return section([
    [-cw, 0],
    [cw, 0],
    [cw, curbH],
    [t, curbH],
    [t, cap],
    [t * 1.6, cap],
    [t * 1.6, height],
    [-t * 1.6, height],
    [-t * 1.6, cap],
    [-t, cap],
    [-t, curbH],
    [-cw, curbH],
  ]);
}

interface PathMetrics {
  /** 始点からの累積距離 (m)。頂点数と同じ長さ */
  cumulative: number[];
  total: number;
}

function measurePath(path: LatLng[]): PathMetrics {
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += distanceMeters(path[i - 1], path[i]);
    cumulative.push(total);
  }
  return { cumulative, total };
}

/** 累積距離 d の位置における値を線形補間する */
function valueAt(values: number[], cumulative: number[], d: number): number {
  if (values.length === 0) return 0;
  if (d <= cumulative[0]) return values[0];
  const last = cumulative.length - 1;
  if (d >= cumulative[last]) return values[last];
  for (let i = 1; i <= last; i += 1) {
    if (d <= cumulative[i]) {
      const span = cumulative[i] - cumulative[i - 1];
      if (span <= 0) return values[i];
      const r = (d - cumulative[i - 1]) / span;
      return values[i - 1] + (values[i] - values[i - 1]) * r;
    }
  }
  return values[last];
}

/** 累積距離 d の位置の座標を線形補間する */
function pointAt(lats: number[], lngs: number[], cumulative: number[], d: number): LatLng {
  return {
    lat: valueAt(lats, cumulative, d),
    lng: valueAt(lngs, cumulative, d),
  };
}

/**
 * 真北を 0 とし東回りを正とする方位角 (rad)。
 *
 * 経度差はそのままでは距離にならないので cos(緯度) を掛ける。
 * これを忘れると柱が線路に対して斜めを向く。
 */
function headingAt(path: LatLng[], index: number): number {
  const prev = path[Math.max(0, index - 1)];
  const next = path[Math.min(path.length - 1, index + 1)];
  const cos = Math.cos((path[index].lat * Math.PI) / 180) || 1;
  const east = (next.lng - prev.lng) * cos;
  const north = next.lat - prev.lat;
  if (east === 0 && north === 0) return 0;
  return Math.atan2(east, north);
}

/** 累積距離 d における方位角 */
function headingAtDistance(path: LatLng[], cumulative: number[], d: number): number {
  for (let i = 1; i < cumulative.length; i += 1) {
    if (d <= cumulative[i]) return headingAt(path, i - 1);
  }
  return headingAt(path, path.length - 1);
}

/**
 * 地形を均した「路盤の高さ」を作る。
 *
 * 高架は地表の細かい起伏には追従せず、緩やかな縦断勾配で通る。
 * 窓内の最大標高を取ることで、どの地点でも桁下高を割らないようにする。
 */
function gradeProfile(ground: number[], cumulative: number[]): number[] {
  const raised = ground.map((_, i) => {
    let max = ground[i];
    for (let j = 0; j < ground.length; j += 1) {
      if (Math.abs(cumulative[j] - cumulative[i]) <= GRADE_WINDOW_M) {
        max = Math.max(max, ground[j]);
      }
    }
    return max;
  });
  // 段差が残るので一度ならす
  return raised.map((v, i) => {
    const prev = raised[Math.max(0, i - 1)];
    const next = raised[Math.min(raised.length - 1, i + 1)];
    return (prev + v * 2 + next) / 4;
  });
}

/** 等間隔で並ぶ柱の位置（累積距離）。両端には必ず柱を置く */
function bayPositions(total: number, spacing: number): number[] {
  if (spacing <= 0 || total <= 0) return [];
  // 端から端まで割り切れるように径間を微調整する（余りの半端な径間を作らない）
  const bays = Math.max(1, Math.round(total / spacing));
  const actual = total / bays;
  const out: number[] = [];
  for (let i = 0; i <= bays; i += 1) out.push(i * actual);
  return out;
}

/** 等間隔に選んだ添字（地形サンプルの間引き） */
function pickIndices(length: number, max: number): number[] {
  if (length <= max) return Array.from({ length }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(Math.round((i * (length - 1)) / (max - 1)));
  }
  return out;
}

export class ElevatedStructureLayer {
  private primitives: Cesium.Primitive[] = [];
  private loadedKey: string | null = null;

  constructor(private readonly viewer: Cesium.Viewer) {}

  get count(): number {
    return this.primitives.length;
  }

  /**
   * 構造物を描画する。
   *
   * 地形の標高は非同期でしか取れないので、経路上の代表点をまとめて取得し、
   * 頂点間は補間する。柱の足元は実際の地表、床版は均した路盤に合わせる。
   */
  async render(structures: ElevatedStructure[], key: string): Promise<void> {
    if (this.loadedKey === key) return;
    this.clear();
    this.loadedKey = key;
    if (structures.length === 0) return;

    // 柱の予算は限られているので、カメラに近いものから使う。
    // 床版と壁は全部に付けるので、遠くの高架が消えることはない
    const ordered = this.sortByDistance(structures);
    const ground = await this.sampleGround(ordered);

    const deckInstances: Cesium.GeometryInstance[] = [];
    const frameInstances: Cesium.GeometryInstance[] = [];
    const railInstances: Cesium.GeometryInstance[] = [];
    let frameBudget = MAX_FRAME_INSTANCES;

    ordered.forEach((s, index) => {
      if (s.path.length < 2) return;
      const metrics = measurePath(s.path);
      if (metrics.total < 1) return;

      const grade = gradeProfile(ground[index], metrics.cumulative);
      const material = MATERIAL[s.kind];

      // 高さの基準（下から順に）:
      //   beamBottom = grade + clearance   … 梁下（桁下高）。柱の頭でもある
      //   slabBottom = + girderDepth       … 床版の下面 = 梁の上面
      //   deckTop    = + deckThickness     … 路面
      const beamBottom = grade.map((g) => g + s.clearance);
      const slabBottom = beamBottom.map((h) => h + s.girderDepth);
      const deckTop = slabBottom.map((h) => h + s.deckThickness);

      this.addDeck(deckInstances, s, beamBottom, slabBottom, material.deck);
      this.addParapets(railInstances, s, deckTop, material.deck);

      const used = this.addFrame(
        frameInstances,
        s,
        metrics,
        beamBottom,
        ground[index],
        slabBottom,
        material,
        frameBudget,
      );
      frameBudget -= used;
    });

    for (const instances of [deckInstances, frameInstances, railInstances]) {
      if (instances.length === 0) continue;
      const primitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: false,
          translucent: false,
          closed: true,
        }),
        // 影を落とすと立体感が出る（品質設定で影を切っている場合は無視される）
        shadows: Cesium.ShadowMode.ENABLED,
        asynchronous: true,
      });
      this.viewer.scene.primitives.add(primitive);
      this.primitives.push(primitive);
    }
  }

  /**
   * カメラに近い順に並べ替える。
   *
   * 柱の予算が足りないときに、目の前の高架から柱が抜けると目立つ。
   * カメラの位置が取れない場合は元の順序のままにする。
   */
  private sortByDistance(structures: ElevatedStructure[]): ElevatedStructure[] {
    const carto = this.viewer.camera?.positionCartographic;
    if (!carto) return structures;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lng = Cesium.Math.toDegrees(carto.longitude);
    const eye = { lat, lng };

    return [...structures].sort((a, b) => this.nearestOf(a, eye) - this.nearestOf(b, eye));
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
      for (const vi of pickIndices(s.path.length, TERRAIN_SAMPLES_PER_PATH)) {
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

  /** 床版と縦梁。中心線には各部材の下面の高さを渡す */
  private addDeck(
    out: Cesium.GeometryInstance[],
    s: ElevatedStructure,
    beamBottom: number[],
    slabBottom: number[],
    color: Cesium.Color,
  ): void {
    const positions = s.path.map((p, i) =>
      Cesium.Cartesian3.fromDegrees(p.lng, p.lat, slabBottom[i]),
    );
    out.push(
      new Cesium.GeometryInstance({
        id: s.id,
        geometry: new Cesium.PolylineVolumeGeometry({
          polylinePositions: positions,
          shapePositions: slabShape(s.width, s.deckThickness),
          cornerType: Cesium.CornerType.MITERED,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
      }),
    );

    if (s.girderDepth <= 0) return;

    // 縦梁。ラーメン高架橋は柱の真上に 2 本、桁橋は中央に箱桁 1 本
    const under = color.darken(0.18, new Cesium.Color());

    if (s.form === 'rigid-frame') {
      const offset = this.girderOffset(s);
      const girderWidth = Math.max(0.7, s.pierSize * 1.1);
      for (const side of [-1, 1]) {
        const line = this.offsetPath(s.path, offset * side, beamBottom);
        if (line.length < 2) continue;
        out.push(this.volume(line, girderShape(girderWidth, s.girderDepth), under));
      }
      return;
    }

    const boxWidth = Math.max(2, s.width * 0.5);
    const line = s.path.map((p, i) =>
      Cesium.Cartesian3.fromDegrees(p.lng, p.lat, beamBottom[i]),
    );
    out.push(this.volume(line, girderShape(boxWidth, s.girderDepth), under));
  }

  /** 縦梁・柱の中心線が中心からどれだけ外側にあるか (m) */
  private girderOffset(s: ElevatedStructure): number {
    // 床版は柱の外側に張り出す。張り出し量は幅の 16% 程度
    return Math.max(1, s.width / 2 - Math.max(1, s.width * 0.16));
  }

  /** 高欄・防音壁 */
  private addParapets(
    out: Cesium.GeometryInstance[],
    s: ElevatedStructure,
    deckTop: number[],
    color: Cesium.Color,
  ): void {
    if (s.parapetHeight <= 0) return;
    // 鉄道の防音壁はコンクリート板で厚い。道路の高欄は細い
    const isRail = s.kind.startsWith('rail');
    const thickness = isRail ? 0.22 : 0.14;
    const curbWidth = isRail ? 0.5 : 0.4;
    const shape = parapetShape(s.parapetHeight, thickness, curbWidth);
    // 床版より明るくして、遠目でも壁と路面の境目が分かるようにする
    const tint = color.brighten(0.18, new Cesium.Color());
    // 地覆の外面を床版の縁に合わせる
    const offset = Math.max(0, s.width / 2 - curbWidth / 2 - 0.05);

    for (const side of [-1, 1]) {
      const line = this.offsetPath(s.path, offset * side, deckTop);
      if (line.length < 2) continue;
      out.push(this.volume(line, shape, tint));
    }
  }

  /**
   * 柱まわり（形式ごとに造りが変わる部分）。
   * 追加したインスタンス数を返す。
   */
  private addFrame(
    out: Cesium.GeometryInstance[],
    s: ElevatedStructure,
    metrics: PathMetrics,
    beamBottom: number[],
    ground: number[],
    slabBottom: number[],
    material: { deck: Cesium.Color; pier: Cesium.Color },
    budget: number,
  ): number {
    if (s.pierSpacing <= 0 || budget <= 0) return 0;

    const bays = bayPositions(metrics.total, s.pierSpacing);
    const lats = s.path.map((p) => p.lat);
    const lngs = s.path.map((p) => p.lng);
    let added = 0;

    for (const d of bays) {
      if (added >= budget) break;
      const point = pointAt(lats, lngs, metrics.cumulative, d);
      const heading = headingAtDistance(s.path, metrics.cumulative, d);
      // 梁の下端 = 桁下高。柱はそこから実際の地表まで伸びる
      const columnTop = valueAt(beamBottom, metrics.cumulative, d);
      const soil = valueAt(ground, metrics.cumulative, d);
      const columnHeight = columnTop - soil;
      if (columnHeight < 1.2) continue;

      if (s.form === 'rigid-frame') {
        // 横梁（柱の頭をつなぐ）。この梁が縦梁を受ける
        const beamTop = valueAt(slabBottom, metrics.cumulative, d);
        out.push(
          this.box(point, heading, {
            halfX: s.width * 0.42,
            halfY: Math.max(0.45, s.pierSize * 0.65),
            halfZ: Math.max(0.3, (beamTop - columnTop) / 2),
            z: (beamTop + columnTop) / 2,
            color: material.deck.darken(0.18, new Cesium.Color()),
          }),
        );
        added += 1;

        // 2 本の柱
        const offset = this.girderOffset(s);
        for (const side of [-1, 1]) {
          if (added >= budget) break;
          out.push(
            this.box(this.shift(point, offset * side, heading), heading, {
              halfX: s.pierSize * 0.5,
              halfY: s.pierSize * 0.6,
              halfZ: columnHeight / 2,
              z: soil + columnHeight / 2,
              color: material.pier,
            }),
          );
          added += 1;
        }
        continue;
      }

      if (s.form === 'slab') {
        // 歩道橋。細い柱 1 本
        out.push(
          this.box(point, heading, {
            halfX: s.pierSize * 0.5,
            halfY: s.pierSize * 0.5,
            halfZ: columnHeight / 2,
            z: soil + columnHeight / 2,
            color: material.pier,
          }),
        );
        added += 1;
        continue;
      }

      // 桁橋。柱頭部（張り出し）の上に桁が載る
      const capHeight = Math.min(1.4, Math.max(0.6, s.girderDepth * 0.7));
      if (columnHeight <= capHeight + 0.8) continue;
      out.push(
        this.box(point, heading, {
          halfX: Math.max(s.pierSize, s.width * 0.34),
          halfY: s.pierSize * 0.6,
          halfZ: capHeight / 2,
          z: columnTop - capHeight / 2,
          color: material.pier.darken(0.08, new Cesium.Color()),
        }),
      );
      added += 1;
      if (added >= budget) break;

      const shaft = columnHeight - capHeight;
      out.push(
        this.box(point, heading, {
          halfX: s.pierSize * 0.55,
          halfY: s.pierSize * 0.7,
          halfZ: shaft / 2,
          z: soil + shaft / 2,
          color: material.pier,
        }),
      );
      added += 1;
    }

    return added;
  }

  /** 押し出し体をひとつ作る */
  private volume(
    positions: Cesium.Cartesian3[],
    shape: Cesium.Cartesian2[],
    color: Cesium.Color,
  ): Cesium.GeometryInstance {
    return new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineVolumeGeometry({
        polylinePositions: positions,
        shapePositions: shape,
        cornerType: Cesium.CornerType.MITERED,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  /**
   * 進行方向に合わせて向きを変えた直方体。
   *
   * 局所座標は x = 進行方向に対して右、y = 進行方向、z = 上。
   * 東西南北の枠を方位角ぶん回して作る。
   */
  private box(
    point: LatLng,
    heading: number,
    o: { halfX: number; halfY: number; halfZ: number; z: number; color: Cesium.Color },
  ): Cesium.GeometryInstance {
    const center = Cesium.Cartesian3.fromDegrees(point.lng, point.lat, o.z);
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    // ENU では +Y が北。方位角 h の向きに +Y を合わせるには Z 軸まわりに -h
    const modelMatrix = Cesium.Matrix4.multiplyByMatrix3(
      frame,
      Cesium.Matrix3.fromRotationZ(-heading),
      new Cesium.Matrix4(),
    );
    return new Cesium.GeometryInstance({
      geometry: Cesium.BoxGeometry.fromDimensions({
        dimensions: new Cesium.Cartesian3(o.halfX * 2, o.halfY * 2, o.halfZ * 2),
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      modelMatrix,
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(o.color) },
    });
  }

  /** 進行方向に対して右へ offsetM ずらした地点 */
  private shift(point: LatLng, offsetM: number, heading: number): LatLng {
    // 右方向の方位角は heading + 90°
    const east = Math.sin(heading + Math.PI / 2) * offsetM;
    const north = Math.cos(heading + Math.PI / 2) * offsetM;
    const cos = Math.cos((point.lat * Math.PI) / 180) || 1;
    return {
      lat: point.lat + north / 111_320,
      lng: point.lng + east / (111_320 * cos),
    };
  }

  /** 中心線を法線方向にずらした経路（縦梁・高欄の位置決め） */
  private offsetPath(path: LatLng[], offsetM: number, heights: number[]): Cesium.Cartesian3[] {
    const out: Cesium.Cartesian3[] = [];
    for (let i = 0; i < path.length; i += 1) {
      const moved = this.shift(path[i], offsetM, headingAt(path, i));
      out.push(Cesium.Cartesian3.fromDegrees(moved.lng, moved.lat, heights[i]));
    }
    return out;
  }

  clear(): void {
    for (const p of this.primitives) {
      this.viewer.scene.primitives.remove(p);
    }
    this.primitives = [];
    this.loadedKey = null;
  }
}
