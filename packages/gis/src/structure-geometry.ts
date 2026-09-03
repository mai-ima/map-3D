/**
 * 高架・橋梁を「形の記述」(SceneShape) として組み立てる。
 *
 * ここは描画エンジンに触れない純粋な変換で、Cesium を import しない。
 * 将来 Swift（SceneKit / RealityKit）へ移すときも、この寸法の決め方は
 * そのまま持っていける。描くのは packages/map-engine の仕事。
 *
 * 実データと補完の切り分け:
 *   位置・形状・幅（車線数/線路数）・上下関係 … OSM の実データ
 *   床版の厚み・梁の高さ・柱の間隔と断面     … 種別ごとの標準的な設計値
 * 形そのものを創作しているのではなく、断面の寸法を標準値で補っている。
 *
 * 形式ごとに造りが違うので、それぞれ別の組み立てをする:
 *
 *   rigid-frame（ラーメン高架橋 / 都市部の鉄道高架）
 *     床版 + 縦梁 + 横梁 + 柱を 1 径間として繰り返す。
 *     径間が 8.9m と短く、柱が細かく連続するのがこの形式の見た目そのもの。
 *
 *   girder（桁橋 / 道路橋・鉄道橋）
 *     床版 + 箱桁 1 本 + 柱頭部 + 柱。支間 30m 前後で柱はまばら。
 *
 *   slab（歩道橋）
 *     薄い床版 + 細い柱。
 */

import type {
  BoxShape,
  ElevatedStructure,
  ExtrudedShape,
  LatLng,
  LatLngAlt,
  SceneShape,
  SectionPoint,
  StructureKind,
} from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';

/**
 * 材質の色。
 *
 * 実際の構造物に塗られている色は OSM には入っていないため、
 * 「コンクリート」「鋼」といった一般的な材質の色に留めている。
 * 特定の構造物の色を創作しないという方針による。
 */
const MATERIAL: Record<StructureKind, { deck: string; pier: string }> = {
  'rail-elevated': { deck: '#b8b4ad', pier: '#aca8a1' },
  'rail-bridge': { deck: '#9d9a95', pier: '#aca8a1' },
  'road-elevated': { deck: '#bcb8b1', pier: '#b0aca5' },
  'road-bridge': { deck: '#b5b1aa', pier: '#aaa6a0' },
  footbridge: { deck: '#c2beb7', pier: '#b4b0a9' },
  stair: { deck: '#c2beb7', pier: '#b4b0a9' },
  // 盛土・擁壁。路面はコンクリート、受けている壁は打ち放しのコンクリート
  embankment: { deck: '#bcb8b1', pier: '#a8a49d' },
};

/**
 * 盛土・擁壁を受ける壁を何区間に分けるか。
 *
 * 上がっていく区間では壁の高さが場所ごとに違う。押し出しの断面は
 * 1 本につき 1 つしか持てないので、区間に分けて 1 区間 1 つの高さで作る。
 * 区間の上端は床版（厚み 0.3m）で覆われるため、多少の段は表に出ない。
 */
const RAMP_WALL_SEGMENT_M = 12;
const RAMP_WALL_MAX_SEGMENTS = 24;

/**
 * 段の寸法。
 *
 * 蹴上げの上限は「立体横断施設技術基準・同解説」（日本道路協会）と
 * 「移動等円滑化のために必要な道路の構造に関する基準」（国土交通省令）の
 * 0.15m を使う。段の数はここから決まる。
 *
 * 踏面は基準値ではなく、OSM の平面形の長さを段の数で割って求める。
 * 踏面を先に決めて長さを逆算すると、実在しない位置まで階段が伸びてしまう。
 *
 * 割り付けた踏面が 0.21m を下回ったときは段を作らない。
 * 0.21m は建築基準法施行令 第 23 条が定める一般的な階段の踏面の下限で、
 * これを割るなら、その平面形は 1 直線の階段としては短すぎる
 * （実物には踊り場や折り返しがあり、OSM がそこまで描いていない）。
 * 無い折り返しを作るのは創作なので、斜めの構造だけを出す。
 */
const STEP_RISE_MAX_M = 0.15;
const STEP_TREAD_MIN_M = 0.21;

/**
 * 段を 1 つずつ作る距離の上限 (m)。
 *
 * 踏面 0.30m は 300m 離れると画面上でおよそ 1 画素になり、
 * 段が並んでいることは見て取れない。斜めの段裏と手すりだけで
 * 「上がっていく構造物」としては十分に読み取れる。
 */
const STEP_DETAIL_DISTANCE_M = 300;

/**
 * 明度を変えた色を作る。
 *
 * 部材どうしの境目が見えるように、桁は床版より暗く、
 * 防音壁は明るくする。Cesium の Color.darken / brighten と同じ考え方だが、
 * 描画エンジンに依存しないよう自前で持つ。
 * `amount` は 0〜1 で、1 なら黒（darken）／白（brighten）になる。
 */
export function shade(hex: string, amount: number, towardsWhite = false): string {
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const mix = (v: number) =>
    Math.round(towardsWhite ? v + (255 - v) * amount : v * (1 - amount));
  const to2 = (v: number) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0');
  return `#${to2(mix(channel(1)))}${to2(mix(channel(3)))}${to2(mix(channel(5)))}`;
}

/**
 * 繰り返し部材（柱と段）として作ってよい形の上限。
 *
 * ラーメン高架橋の柱は径間 8.9m ごとに並ぶので、
 * 長い路線ではこれだけで数千個になる。階段の段も同じ性質で、
 * 高さ 5.6m の階段 1 本が 38 個になる。まとめて 1 つの予算で抑える。
 *
 * 実測（2026-09）: 東京駅 2km 四方で、階段 11 本が近距離で 444 個、
 * 400m 離れると 49 個（段は 300m で作らなくなる）。
 */
export const MAX_FRAME_SHAPES = 6000;

/** 地形を均すときの窓幅 (m)。近傍の最大を取る幅と、平均する幅 */
const GRADE_RISE_WINDOW_M = 50;
const GRADE_SMOOTH_WINDOW_M = 220;

// ---- 断面 --------------------------------------------------------------

/**
 * 断面は必ず y = 0 を下端として書き、中心線にはその部材の「下面」を渡す。
 *
 * 描画側（Cesium の PolylineVolumeGeometry）が断面を外接矩形で正規化し、
 * y の絶対値を無視して中心線から必ず上へ押し出すため。
 * 詳しくは docs/pitfalls.md。この規約は描画エンジンを差し替えても守る。
 */
function section(points: [number, number][]): SectionPoint[] {
  return points.map(([x, y]) => ({ x, y }));
}

/**
 * 床版の断面。下端が床版の下面、上端が路面。
 * 張り出し部の先端を薄くして、拡大したときに板が浮いて見えないようにする。
 */
export function slabSection(width: number, thickness: number): SectionPoint[] {
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
export function girderSection(width: number, depth: number): SectionPoint[] {
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
export function parapetSection(
  height: number,
  thickness: number,
  curbWidth: number,
): SectionPoint[] {
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

// ---- 経路の幾何 --------------------------------------------------------

export interface PathMetrics {
  /** 始点からの累積距離 (m)。頂点数と同じ長さ */
  cumulative: number[];
  total: number;
}

export function measurePath(path: LatLng[]): PathMetrics {
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += distanceMeters(path[i - 1], path[i]);
    cumulative.push(total);
  }
  return { cumulative, total };
}

/** 累積距離 d の位置における値を線形補間する */
export function valueAt(values: number[], cumulative: number[], d: number): number {
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
export function pointAt(
  lats: number[],
  lngs: number[],
  cumulative: number[],
  d: number,
): LatLng {
  return { lat: valueAt(lats, cumulative, d), lng: valueAt(lngs, cumulative, d) };
}

/**
 * 真北を 0 とし東回りを正とする方位角 (rad)。
 *
 * 経度差はそのままでは距離にならないので cos(緯度) を掛ける。
 * これを忘れると柱が線路に対して斜めを向く。
 */
export function headingAt(path: LatLng[], index: number): number {
  const prev = path[Math.max(0, index - 1)];
  const next = path[Math.min(path.length - 1, index + 1)];
  const cos = Math.cos((path[index].lat * Math.PI) / 180) || 1;
  const east = (next.lng - prev.lng) * cos;
  const north = next.lat - prev.lat;
  if (east === 0 && north === 0) return 0;
  return Math.atan2(east, north);
}

/** 累積距離 d における方位角 */
export function headingAtDistance(
  path: LatLng[],
  cumulative: number[],
  d: number,
): number {
  for (let i = 1; i < cumulative.length; i += 1) {
    if (d <= cumulative[i]) return headingAt(path, i - 1);
  }
  return headingAt(path, path.length - 1);
}

/** 進行方向に対して右へ offsetM ずらした地点 */
export function shift(point: LatLng, offsetM: number, heading: number): LatLng {
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
function offsetPath(path: LatLng[], offsetM: number, heights: number[]): LatLngAlt[] {
  return path.map((p, i) => ({
    ...shift(p, offsetM, headingAt(path, i)),
    alt: heights[i],
  }));
}

/** 窓内の値を集計する（等間隔でない頂点に対応するため距離で窓を取る） */
function windowed(
  values: number[],
  cumulative: number[],
  halfWidth: number,
  reduce: (acc: number, v: number, count: number) => number,
  init: (v: number) => number,
): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < values.length; i += 1) {
    while (lo < i && cumulative[i] - cumulative[lo] > halfWidth) lo += 1;
    while (hi < values.length - 1 && cumulative[hi + 1] - cumulative[i] <= halfWidth) hi += 1;
    let acc = init(values[lo]);
    let count = 0;
    for (let j = lo; j <= hi; j += 1) {
      count += 1;
      acc = reduce(acc, values[j], count);
    }
    out.push(acc);
  }
  return out;
}

/**
 * 地形を均した「路盤の高さ」を作る。
 *
 * 高架は地表の細かい起伏には追従せず、長い距離を緩やかな勾配で通る。
 * 地表をそのままなぞると路面が波打ち、実物と似ても似つかなくなる。
 *
 *   1. 近傍の最大標高まで持ち上げる … どの地点でも桁下高を割らないように
 *   2. 長い窓で平均する             … 滑らかな縦断勾配にする
 *   3. 地表を下回らないよう戻す     … 平均で沈んだ箇所を救う
 */
export function gradeProfile(ground: number[], cumulative: number[]): number[] {
  const raised = windowed(
    ground,
    cumulative,
    GRADE_RISE_WINDOW_M,
    (acc, v) => Math.max(acc, v),
    (v) => v,
  );
  const smoothed = windowed(
    raised,
    cumulative,
    GRADE_SMOOTH_WINDOW_M,
    (acc, v, count) => acc + (v - acc) / count,
    (v) => v,
  );
  return smoothed.map((v, i) => Math.max(v, ground[i]));
}

/**
 * 経路の各頂点における「地盤からの路面高さ」(m)。
 *
 * ふつうの高架は全長にわたって同じ高さだが、階段や取付部は
 * 起点で地表、終点で高架の路面と、距離に応じて上がっていく。
 * ここを 1 か所で決めておけば、床版・手すり・柱の高さがすべて追従する。
 */
export function heightProfile(
  deckHeight: number,
  startHeight: number | undefined,
  cumulative: number[],
): number[] {
  const level = cumulative.map(() => deckHeight);
  if (startHeight === undefined || !Number.isFinite(startHeight)) return level;
  const total = cumulative[cumulative.length - 1] ?? 0;
  // 長さが 0 だと勾配を割り当てられない（0 除算で NaN になる）
  if (!(total > 0)) return level;
  return cumulative.map((d) => startHeight + ((deckHeight - startHeight) * d) / total);
}

/** 等間隔で並ぶ柱の位置（累積距離）。両端には必ず柱を置く */
export function bayPositions(total: number, spacing: number): number[] {
  if (spacing <= 0 || total <= 0) return [];
  // 端から端まで割り切れるように径間を微調整する（余りの半端な径間を作らない）
  const bays = Math.max(1, Math.round(total / spacing));
  const actual = total / bays;
  const out: number[] = [];
  for (let i = 0; i <= bays; i += 1) out.push(i * actual);
  return out;
}

/**
 * 距離に応じて柱を何本に 1 本描くか。
 *
 * ラーメン高架橋の径間は 8.9m。浜松の実測では、この柱だけで
 * 描画するかたまりの 84%（4,111 個）を占めていた。
 * 一方、径間 8.9m の柱が 1 本おきに見えるかどうかは、
 * 数百メートル離れると人の目には分からない。
 *
 * 2 の冪で間引くのは、近づいて精細に戻したときに
 * 残っていた柱の位置がそのまま使われ、柱が横滑りしないようにするため。
 */
export function pierStride(distanceM: number): number {
  if (distanceM < 250) return 1;
  if (distanceM < 600) return 2;
  return 4;
}

/** 等間隔に選んだ添字（地形サンプルの間引きに使う） */
export function pickIndices(length: number, max: number): number[] {
  if (max <= 0 || length <= 0) return [];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  // max が 1 のときは (max - 1) が 0 になり、0 除算で NaN が並ぶ。
  // 1 点しか選べないなら先頭を返す
  if (max === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(Math.round((i * (length - 1)) / (max - 1)));
  }
  return out;
}

/**
 * 縦梁と柱を並べる位置（中心からの左右のずれ, m）。
 *
 * ラーメン高架橋は 2 線 2 柱式が基本だが、駅の前後など線路が増える区間では
 * 床版が広くなり、柱の列も増える。2 本のまま広い床版を載せると、
 * 見るからに支えきれない形になってしまう。
 * 実物にならって、およそ 8m ごとに 1 列を目安にする。
 */
export function girderOffsets(s: ElevatedStructure): number[] {
  // 床版は柱の外側に張り出す。張り出し量は幅の 16% 程度
  const outer = Math.max(1, s.width / 2 - Math.max(1, s.width * 0.16));
  const rows = Math.max(2, Math.round((outer * 2) / 8) + 1);
  return Array.from({ length: rows }, (_, i) => -outer + (2 * outer * i) / (rows - 1));
}

// ---- 組み立て ----------------------------------------------------------

/** 向きを持つ直方体を作る（局所座標は x=右, y=進行方向, z=上） */
/**
 * 寸法として使える最小値 (m)。
 *
 * 幅 0 や負の値が来ると、大きさの無い（あるいは裏返った）直方体になる。
 * OSM の幅や柱の太さに 0 が入っていることがあるので、
 * 見えるか見えないかの薄さに丸めて、形としては成立させる。
 */
const MIN_SIZE_M = 0.05;

function boxAt(
  point: LatLng,
  headingRad: number,
  o: { halfX: number; halfY: number; halfZ: number; z: number; color: string; id?: string },
): BoxShape {
  const size = (half: number) => Math.max(MIN_SIZE_M, Math.abs(half) * 2);
  return {
    kind: 'box',
    id: o.id,
    centre: { ...point, alt: o.z },
    headingDeg: Number.isFinite(headingRad) ? (headingRad * 180) / Math.PI : 0,
    size: { x: size(o.halfX), y: size(o.halfY), z: size(o.halfZ) },
    color: o.color,
  };
}

function extrusion(
  path: LatLngAlt[],
  sectionPoints: SectionPoint[],
  color: string,
  id?: string,
): ExtrudedShape {
  return { kind: 'extrusion', id, path, section: sectionPoints, color };
}

/** 床版と桁 */
function deckShapes(
  s: ElevatedStructure,
  beamBottom: number[],
  slabBottom: number[],
  deckColor: string,
): SceneShape[] {
  const out: SceneShape[] = [
    extrusion(
      s.path.map((p, i) => ({ ...p, alt: slabBottom[i] })),
      slabSection(s.width, s.deckThickness),
      deckColor,
      s.id,
    ),
  ];
  if (s.girderDepth <= 0) return out;

  // 縦梁。ラーメン高架橋は柱の真上に、桁橋は中央に箱桁 1 本
  const under = shade(deckColor, 0.18);

  if (s.form === 'rigid-frame') {
    const girderWidth = Math.max(0.7, s.pierSize * 1.1);
    for (const offset of girderOffsets(s)) {
      const line = offsetPath(s.path, offset, beamBottom);
      if (line.length < 2) continue;
      out.push(extrusion(line, girderSection(girderWidth, s.girderDepth), under));
    }
    return out;
  }

  const boxWidth = Math.max(2, s.width * 0.5);
  out.push(
    extrusion(
      s.path.map((p, i) => ({ ...p, alt: beamBottom[i] })),
      girderSection(boxWidth, s.girderDepth),
      under,
    ),
  );
  return out;
}

/** 高欄・防音壁 */
function parapetShapes(
  s: ElevatedStructure,
  deckTop: number[],
  deckColor: string,
): SceneShape[] {
  if (s.parapetHeight <= 0) return [];
  // 鉄道の防音壁はコンクリート板で厚い。道路の高欄は細い
  const isRail = s.kind.startsWith('rail');
  const thickness = isRail ? 0.22 : 0.14;
  const curbWidth = isRail ? 0.5 : 0.4;
  const shapePoints = parapetSection(s.parapetHeight, thickness, curbWidth);
  // 床版より明るくして、遠目でも壁と路面の境目が分かるようにする
  const tint = shade(deckColor, 0.18, true);
  // 地覆の外面を床版の縁に合わせる
  const offset = Math.max(0, s.width / 2 - curbWidth / 2 - 0.05);

  const out: SceneShape[] = [];
  for (const side of [-1, 1]) {
    const line = offsetPath(s.path, offset * side, deckTop);
    if (line.length < 2) continue;
    out.push(extrusion(line, shapePoints, tint));
  }
  return out;
}

/**
 * 橋台。橋の両端で桁を受け、地面につなぐ壁。
 *
 * 実物の橋は必ず両岸に橋台があり、そこで路面と地面がつながっている。
 * これが無いと床版が空中で終わり、道路から切り離されて浮いて見える。
 * 桁を持たない床版橋でも、両端の橋台だけは必ずある。
 *
 * ラーメン高架橋のように延々と続く構造には付けない（端が街の外に続くため）。
 */
function abutmentShapes(
  s: ElevatedStructure,
  metrics: PathMetrics,
  beamBottom: number[],
  ground: number[],
  pierColor: string,
): SceneShape[] {
  if (s.form === 'rigid-frame') return [];

  const lats = s.path.map((p) => p.lat);
  const lngs = s.path.map((p) => p.lng);
  // 橋台の厚み。桁を受けるので床版より少し内側から立ち上がる
  const depth = Math.min(2.2, Math.max(0.9, metrics.total * 0.06));
  const out: SceneShape[] = [];

  for (const d of [depth / 2, metrics.total - depth / 2]) {
    const point = pointAt(lats, lngs, metrics.cumulative, d);
    const heading = headingAtDistance(s.path, metrics.cumulative, d);
    const top = valueAt(beamBottom, metrics.cumulative, d);
    const soil = valueAt(ground, metrics.cumulative, d);
    const height = top - soil;
    // 地面すれすれの橋には橋台が見えない
    if (height < 0.4) continue;

    out.push(
      boxAt(point, heading, {
        // 床版よりわずかに広い。実物も桁の外側まで受けている
        halfX: s.width * 0.52,
        halfY: depth / 2,
        halfZ: height / 2,
        z: soil + height / 2,
        color: pierColor,
      }),
    );
  }
  return out;
}

/**
 * 段。
 *
 * 斜めの段裏（床版）の上に、段を 1 つずつ載せる。
 * 段の高さの半分が段裏に埋まる位置に置くことで、
 * 側面から見たときに段裏の斜面から段鼻が並んで突き出る形になる。
 *
 * 段の割り付け方は STEP_RISE_MAX_M / STEP_TREAD_MIN_M の説明を参照。
 */
function stairShapes(
  s: ElevatedStructure,
  metrics: PathMetrics,
  base: number[],
  deckColor: string,
  distanceM: number,
  budget: number,
): SceneShape[] {
  const start = s.startHeight ?? s.deckHeight;
  const rise = s.deckHeight - start;
  // 上がらないものは階段ではない
  if (!(rise > 0.3) || !(metrics.total > 0)) return [];
  if (distanceM > STEP_DETAIL_DISTANCE_M) return [];

  const count = Math.ceil(rise / STEP_RISE_MAX_M);
  const tread = metrics.total / count;
  if (tread < STEP_TREAD_MIN_M) return [];
  if (count > budget) return [];

  const riser = rise / count;
  const lats = s.path.map((p) => p.lat);
  const lngs = s.path.map((p) => p.lng);
  // 段は段裏より明るくして、影の付き方で段が読み取れるようにする
  const color = shade(deckColor, 0.1, true);
  // 手すりの内側に収める
  const halfX = Math.max(0.3, s.width / 2 - 0.15);

  const out: SceneShape[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = (i + 0.5) * tread;
    const point = pointAt(lats, lngs, metrics.cumulative, d);
    const heading = headingAtDistance(s.path, metrics.cumulative, d);
    const soil = valueAt(base, metrics.cumulative, d);
    // i 段目の踏面は、起点の高さから (i+1) 段ぶん上がったところ
    const treadTop = soil + start + (i + 1) * riser;
    out.push(
      boxAt(point, heading, {
        halfX,
        halfY: tread / 2,
        halfZ: riser / 2,
        z: treadTop - riser / 2,
        color,
      }),
    );
  }
  return out;
}

/**
 * 盛土・擁壁を受ける壁。
 *
 * 柱は立てない。OSM が `embankment=yes` と書いているのは
 * 「土を盛って持ち上げてある」という意味で、柱の上に載っているという
 * 意味ではないため。取付部（普通の道から高架へ上がる区間）も同じ造り。
 *
 * 壁の面は路肩の位置に置く。盛土の法面（標準は 1:1.5）まで再現すると、
 * 高さ 9m の区間で片側 13.5m ぶん、実際には持っていない隣地まで
 * 構造物が広がってしまう。OSM は擁壁か法面かを区別していないので、
 * 狭いほう（擁壁）に倒す。
 *
 * 幅を路面とほぼ同じ（0.92 倍）に取るのには、もう 1 つ理由がある。
 * 取付部の平面形は地表にも道として描かれている（そこには実際に道があり、
 * 立体だけにすると接続先が見つからなかったときに道が消える）。
 * 壁が地面から路面まで塞いでいれば、その帯は横からも上からも隠れる。
 */
function rampWallShapes(
  s: ElevatedStructure,
  metrics: PathMetrics,
  slabBottom: number[],
  ground: number[],
  color: string,
  distanceM: number,
  budget: number,
): SceneShape[] {
  if (budget <= 0 || metrics.total <= 0) return [];

  // 離れるほど粗くする。区間の境目は床版に覆われて見えないので、
  // 粗くしても輪郭は変わらない
  const stride = pierStride(distanceM);
  const wanted = Math.ceil(metrics.total / (RAMP_WALL_SEGMENT_M * stride));
  const count = Math.max(1, Math.min(RAMP_WALL_MAX_SEGMENTS, wanted));
  if (count > budget) return [];

  const span = metrics.total / count;
  const lats = s.path.map((p) => p.lat);
  const lngs = s.path.map((p) => p.lng);
  const out: SceneShape[] = [];

  for (let i = 0; i < count; i += 1) {
    const d = (i + 0.5) * span;
    const point = pointAt(lats, lngs, metrics.cumulative, d);
    const heading = headingAtDistance(s.path, metrics.cumulative, d);
    const top = valueAt(slabBottom, metrics.cumulative, d);
    const soil = valueAt(ground, metrics.cumulative, d);
    const height = top - soil;
    // 地面すれすれの区間には壁が見えない
    if (height < 0.4) continue;

    out.push(
      boxAt(point, heading, {
        // 床版よりわずかに内側。実物も路肩の下で受けている
        halfX: s.width * 0.46,
        halfY: span / 2,
        halfZ: height / 2,
        z: soil + height / 2,
        color,
      }),
    );
  }
  return out;
}

/** 柱まわり（形式ごとに造りが変わる部分） */
function frameShapes(
  s: ElevatedStructure,
  metrics: PathMetrics,
  beamBottom: number[],
  ground: number[],
  slabBottom: number[],
  material: { deck: string; pier: string },
  budget: number,
  distanceM: number,
): SceneShape[] {
  if (s.pierSpacing <= 0 || budget <= 0) return [];

  // 離れた高架では柱を間引く。径間 8.9m の 1 本おきは
  // 数百メートル先では見分けがつかない
  const stride = pierStride(distanceM);
  const bays = bayPositions(metrics.total, s.pierSpacing).filter((_, i) => i % stride === 0);

  // 予算が尽きて途中から柱が消えると、そこだけ床版が宙に浮いて見える。
  // 1 本ぶんまるごと入らないなら、その構造物には柱を付けない。
  // 並べ替えでカメラに近いものから処理しているので、手前の高架が優先される
  const perBay =
    s.form === 'rigid-frame' ? 1 + girderOffsets(s).length : s.form === 'girder' ? 2 : 1;
  if (bays.length * perBay > budget) return [];

  const lats = s.path.map((p) => p.lat);
  const lngs = s.path.map((p) => p.lng);
  const out: SceneShape[] = [];

  for (const d of bays) {
    if (out.length >= budget) break;
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
        boxAt(point, heading, {
          halfX: s.width * 0.42,
          halfY: Math.max(0.45, s.pierSize * 0.65),
          halfZ: Math.max(0.3, (beamTop - columnTop) / 2),
          z: (beamTop + columnTop) / 2,
          color: shade(material.deck, 0.18),
        }),
      );

      // 柱。縦梁の真下に 1 本ずつ立てる
      for (const offset of girderOffsets(s)) {
        if (out.length >= budget) break;
        out.push(
          boxAt(shift(point, offset, heading), heading, {
            halfX: s.pierSize * 0.5,
            halfY: s.pierSize * 0.6,
            halfZ: columnHeight / 2,
            z: soil + columnHeight / 2,
            color: material.pier,
          }),
        );
      }
      continue;
    }

    if (s.form === 'slab' || s.form === 'stair') {
      // 歩道橋・階段。細い柱 1 本
      out.push(
        boxAt(point, heading, {
          halfX: s.pierSize * 0.5,
          halfY: s.pierSize * 0.5,
          halfZ: columnHeight / 2,
          z: soil + columnHeight / 2,
          color: material.pier,
        }),
      );
      continue;
    }

    // 桁橋。柱頭部（張り出し）の上に桁が載る
    const capHeight = Math.min(1.4, Math.max(0.6, s.girderDepth * 0.7));
    if (columnHeight <= capHeight + 0.8) continue;
    out.push(
      boxAt(point, heading, {
        halfX: Math.max(s.pierSize, s.width * 0.34),
        halfY: s.pierSize * 0.6,
        halfZ: capHeight / 2,
        z: columnTop - capHeight / 2,
        color: shade(material.pier, 0.08),
      }),
    );
    if (out.length >= budget) break;

    const shaft = columnHeight - capHeight;
    out.push(
      boxAt(point, heading, {
        halfX: s.pierSize * 0.55,
        halfY: s.pierSize * 0.7,
        halfZ: shaft / 2,
        z: soil + shaft / 2,
        color: material.pier,
      }),
    );
  }

  return out;
}

/** 組み立ての結果。描画側は種類ごとにまとめてバッチにする */
export interface StructureShapes {
  /** 床版と桁 */
  deck: SceneShape[];
  /** 柱・横梁・橋台 */
  frame: SceneShape[];
  /** 高欄・防音壁 */
  parapet: SceneShape[];
}

export interface StructureBuildOptions {
  /** 経路の各頂点における地表の標高 (m)。構造物ごとに 1 本 */
  ground: number[][];
  /** カメラからの距離 (m)。柱の間引きに使う。構造物ごとに 1 つ */
  distances: number[];
  /** 柱として作ってよい形の総数 */
  frameBudget?: number;
}

/**
 * 構造物の一群を形の記述に変換する。
 *
 * 高さは路面を基準に、上から下へ決める。
 * 桁下を基準にすると、同じ路線でも構造形式が変わる接続部で
 * 路面に段差ができてしまう（実際に 1.2m の段ができていた）。
 *
 *   deckTop    = 地盤 + deckHeight   路面（軌道面・車道面）
 *   slabBottom = deckTop - 版厚      床版の下面 = 梁の上面
 *   beamBottom = slabBottom - 梁高   梁下。柱の頭でもある
 */
export function buildStructureShapes(
  structures: ElevatedStructure[],
  options: StructureBuildOptions,
): StructureShapes {
  const out: StructureShapes = { deck: [], frame: [], parapet: [] };
  let budget = options.frameBudget ?? MAX_FRAME_SHAPES;

  structures.forEach((s, index) => {
    if (s.path.length < 2) return;
    const metrics = measurePath(s.path);
    if (metrics.total < 1) return;

    // 地形が取れなかった点は 0（平地）として扱う。
    // NaN のまま進むと、床版の高さも柱の位置もすべて NaN になり、
    // 描画側で「何も出ない」という形でしか分からなくなる
    const raw = options.ground[index] ?? [];
    const ground = s.path.map((_, i) =>
      Number.isFinite(raw[i]) ? raw[i] : 0,
    );
    // 階段は地表に足を着けている。地形を均した路盤に載せると、
    // 均しで上がったぶんだけ下の段が地面から浮く
    const base = s.form === 'stair' ? ground : gradeProfile(ground, metrics.cumulative);
    const material = MATERIAL[s.kind];

    // 路面の高さは、起点から終点へ変化しうる（階段・取付部）
    const rise = heightProfile(s.deckHeight, s.startHeight, metrics.cumulative);
    const deckTop = base.map((g, i) => g + rise[i]);
    const slabBottom = deckTop.map((h) => h - s.deckThickness);
    const beamBottom = slabBottom.map((h) => h - s.girderDepth);

    out.deck.push(...deckShapes(s, beamBottom, slabBottom, material.deck));
    out.parapet.push(...parapetShapes(s, deckTop, material.deck));
    if (s.form === 'stair') {
      // 階段は上端で高架の床版に直接つながる。そこに橋台を立てると
      // 上がりきったところに壁ができてしまう
      const steps = stairShapes(
        s,
        metrics,
        ground,
        material.deck,
        options.distances[index] ?? 0,
        budget,
      );
      out.deck.push(...steps);
      budget -= steps.length;
    } else if (s.form === 'ramp') {
      // 盛土・取付部。柱でも橋台でもなく、路面の下を壁で受ける
      const wall = rampWallShapes(
        s,
        metrics,
        slabBottom,
        ground,
        material.pier,
        options.distances[index] ?? 0,
        budget,
      );
      out.frame.push(...wall);
      budget -= wall.length;
    } else {
      out.frame.push(...abutmentShapes(s, metrics, beamBottom, ground, material.pier));
    }

    // 柱は均した路盤ではなく実際の地表まで伸ばす（浮かせない）
    const frame = frameShapes(
      s,
      metrics,
      beamBottom,
      ground,
      slabBottom,
      material,
      budget,
      options.distances[index] ?? 0,
    );
    out.frame.push(...frame);
    budget -= frame.length;
  });

  return out;
}
