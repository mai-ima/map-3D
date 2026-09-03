/**
 * OpenStreetMap の道路・線路・信号から、街の地表を組み立てる。
 *
 * ここは描画エンジンに触れない純粋な変換で、出力は SceneShape の配列。
 * Cesium でも、将来 Swift（SceneKit / RealityKit）へ移しても、
 * この処理はそのまま使える。
 *
 * 実データと補完の切り分け:
 *   位置・線形・種別・車線数・速度制限 … OSM の実データ
 *   幅員・区画線の寸法・レールの太さ   … 道路構造令などの標準値
 * 位置や形を創作することはせず、断面の寸法だけを標準値で補う。
 *
 * 浜松駅周辺 3km 四方の実測（2026-08）:
 *   道路 2,011 本（歩道 902 / 住宅街の道 499 / 3 級 162 / 区画内 142）
 *   線路 69 本、車線数が入っているのは 7%、速度制限は 3%。
 * 属性が乏しいので、車線数は道路種別から標準値を当てる。
 * 一方、速度制限は「実際に入っているときだけ」使う（推測して表示しない）。
 */

import type { BBox, GroundRibbon, LatLng, LatLngAlt, SceneShape } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import { primaryDeadline } from './config';
import { fetchOsmMap } from './osm-api';
import { fetchRoadNetwork, type OverpassElement, deadlineIn } from './overpass';
import { trafficSignalShapes } from './street-furniture-geometry';
import { classify } from './structures';

/** 道路の種別。描き分けと幅員の決定に使う */
export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'living_street'
  | 'pedestrian'
  | 'footway'
  | 'cycleway'
  | 'steps'
  | 'crossing';

/**
 * 種別ごとの標準幅員 (m) と、片側の車線数。
 *
 * 出典: 道路構造令（第 3 種・第 4 種の車道幅員 2.75〜3.5m、
 * 歩道の有効幅員 2.0m 以上）。lanes が入っていればそちらを優先する。
 * lanes は「片側の車線数」。対面通行ならこの 2 倍になる。
 */
const ROAD_SPEC: Record<RoadClass, { width: number; lanes: number; color: string }> = {
  motorway: { width: 10.5, lanes: 3, color: '#4a4a4d' },
  trunk: { width: 10, lanes: 2, color: '#4c4c4f' },
  primary: { width: 9.5, lanes: 2, color: '#4e4e51' },
  secondary: { width: 8.5, lanes: 1, color: '#505053' },
  tertiary: { width: 7.5, lanes: 1, color: '#525255' },
  residential: { width: 5.5, lanes: 1, color: '#565659' },
  service: { width: 4, lanes: 1, color: '#5a5a5d' },
  living_street: { width: 4.5, lanes: 1, color: '#585858' },
  pedestrian: { width: 6, lanes: 0, color: '#6b6560' },
  footway: { width: 2.2, lanes: 0, color: '#6f6a64' },
  cycleway: { width: 2.5, lanes: 0, color: '#5d6155' },
  steps: { width: 1.8, lanes: 0, color: '#726d67' },
  crossing: { width: 4, lanes: 0, color: '#d8d5cf' },
};

/** 区画線の寸法。出典: 道路標識・区画線及び道路標示に関する命令 */
const LINE = {
  /** 車道中央線・車線境界線の幅 (m) */
  width: 0.15,
  /** 車線境界線（白の破線）の [線, 空き] (m) */
  laneDash: [8, 12] as [number, number],
  /** 外側線の幅 (m) */
  edgeWidth: 0.15,
  centreColor: '#e8e4d8',
  laneColor: '#dcd9d0',
  edgeColor: '#cfccc4',
} as const;

/** 描く順。大きいほど手前 */
const ORDER = { pavement: 0, edge: 1, lane: 2, centre: 3, crossing: 4 } as const;

/**
 * 車道外側線を引く道路の種別。
 *
 * 出典: 道路標識・区画線及び道路標示に関する命令 別表第 3（区画線 103 車道外側線）。
 * 車道の外側の縁を示す必要がある道路に引かれる。実務上は幹線道路で、
 * 住宅街の生活道路や区画内の通路には引かれていない
 * （幅員 4〜5.5m の道に白線が無いのは実際に見てのとおり）。
 */
const HAS_EDGE_LINE = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);

/**
 * 実データとして受け入れる上限。
 *
 * OSM のタグは自由入力なので、入力ミスや荒らしで極端な値が入ることがある。
 * tracks=1000000000 をそのまま使うと線路を 10 億本組み立てようとして
 * ブラウザが固まる（実際に固まることを確かめた）。
 *
 * 上限は実在するものの最大に合わせる:
 *   線路数 … 世界最大級の駅でも 30 本程度（東京駅は 20 面 20 線）
 *   車線数 … 最多はカナダのハイウェイ 401 で往復 18 車線
 *   幅     … 道路の幅は最大でも 100m 程度
 */
const MAX_TRACKS = 40;
const MAX_LANES = 24;
const MAX_WIDTH_M = 100;

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 値を上限と下限に収める。読めない値は下限にする */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** OSM の highway タグを、描き分けの種別に落とす */
export function roadClassOf(tags: Record<string, string>): RoadClass | null {
  const hw = tags.highway;
  if (!hw) return null;
  if (hw === 'footway' && tags.footway === 'crossing') return 'crossing';
  switch (hw) {
    case 'motorway':
    case 'motorway_link':
      return 'motorway';
    case 'trunk':
    case 'trunk_link':
      return 'trunk';
    case 'primary':
    case 'primary_link':
      return 'primary';
    case 'secondary':
    case 'secondary_link':
      return 'secondary';
    case 'tertiary':
    case 'tertiary_link':
    case 'unclassified':
      return 'tertiary';
    case 'residential':
      return 'residential';
    case 'living_street':
      return 'living_street';
    case 'service':
    case 'track':
      return 'service';
    case 'pedestrian':
      return 'pedestrian';
    case 'footway':
    case 'path':
      return 'footway';
    case 'cycleway':
      return 'cycleway';
    case 'steps':
      return 'steps';
    default:
      return null;
  }
}

/** 車線数。OSM に入っていればそれを、無ければ種別の標準値を使う */
export function laneCountOf(cls: RoadClass, tags: Record<string, string>): number {
  const explicit = parseNumber(tags.lanes);
  if (explicit && explicit > 0) return clamp(Math.round(explicit), 1, MAX_LANES);
  const spec = ROAD_SPEC[cls];
  // 一方通行は往復ぶんが要らない
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout';
  return oneway ? spec.lanes : spec.lanes * 2;
}

/**
 * 車道の幅 (m)。
 *
 * width タグがあればそれを使う。無ければ、車線数が実データとして
 * 入っているときだけそこから計算し、それも無ければ種別の標準幅にする。
 *
 * 車線数を補完値から逆算してはいけない。生活道路も 3 級道路も
 * 「対面 2 車線」と数えられてしまい、どちらも同じ 7m になる。
 * 実際の生活道路は 4〜6m で、中央線も引かれていない。
 */
export function roadWidthOf(cls: RoadClass, tags: Record<string, string>): number {
  const explicit = parseNumber(tags.width);
  if (explicit && explicit > 1) return clamp(explicit, 1, MAX_WIDTH_M);

  const spec = ROAD_SPEC[cls];
  if (spec.lanes === 0) return spec.width;

  const lanes = parseNumber(tags.lanes);
  if (lanes && lanes > 0) {
    // 1 車線 3.0m に路肩 0.5m×2。道路構造令の第 4 種に相当する値
    const width = Math.max(spec.width, clamp(lanes, 1, MAX_LANES) * 3.0 + 1.0);
    return clamp(width, 1, MAX_WIDTH_M);
  }
  return spec.width;
}

/**
 * 速度制限 (km/h)。
 *
 * OSM に入っているときだけ返す。浜松では 3% にしか入っていないが、
 * 標識に書いてある値は推測してよいものではないので、
 * 「分からないものは出さない」を通す。
 */
export function speedLimitOf(tags: Record<string, string>): number | undefined {
  const raw = tags.maxspeed;
  if (!raw) return undefined;
  // "40", "40 km/h", "JP:urban" などが入る
  const n = parseNumber(raw);
  if (n && n > 0) return Math.round(n);
  return undefined;
}

/** 道路 1 本ぶんの、描画と案内に使う情報 */
export interface RoadPiece {
  id: string;
  cls: RoadClass;
  name?: string;
  path: LatLng[];
  width: number;
  lanes: number;
  oneway: boolean;
  /** OSM に入っていた速度制限 (km/h)。無ければ未設定 */
  speedLimit?: number;
  /** 橋・高架の上か（地表の描画から外す） */
  elevated: boolean;
  /** 地下か（描かない） */
  underground: boolean;
}

/** 線路 1 本ぶん */
export interface RailPiece {
  id: string;
  name?: string;
  path: LatLng[];
  tracks: number;
  elevated: boolean;
  underground: boolean;
}

/** 信号・横断歩道など、点として置くもの */
export interface RoadPoint {
  id: string;
  kind: 'traffic_signal' | 'crossing' | 'stop';
  position: LatLng;
  name?: string;
  /**
   * その点が付いている道の向き（真北 0・東回りの度）。
   *
   * 信号の灯器とアームをこの向きに合わせる。以前はすべて真北を向いていて、
   * 交差点のどの方向を制御しているのか分からなかった。
   * 値は OSM の way の形から取るので、創作ではない。
   */
  headingDeg?: number;
  /**
   * その点が付いている道の幅 (m)。
   *
   * OSM の `highway=traffic_signals` は車道の中心線上のノードに付くので、
   * そのまま柱を立てると道の真ん中に生える。実物は路肩に立っているので、
   * 幅の半分だけ寄せるのに使う。
   */
  roadWidth?: number;
}

export interface RoadScene {
  roads: RoadPiece[];
  rails: RailPiece[];
  points: RoadPoint[];
  /**
   * 取り寄せそのものに失敗したか。
   *
   * 「この範囲に道が無い」と「取り寄せられなかった」は別のこと。
   * 区別しないと、道のある場所でも「データがありません」と出てしまう。
   */
  degraded?: boolean;
}

/**
 * 地表に描かないもの（高架として別に建てられるもの）か。
 *
 * 判定は高架を建てる側（structures.ts の classify）と必ず揃える。
 * 揃っていないと、どちらからも描かれない道や線路ができる。
 *
 * 実際にそうなっていた。高架の判定を「layer > 0」から
 * 「bridge があるか、250m 以上続いて上の層にある」に直したとき、
 * こちらは古いままだったので、layer=1 の短い線路が
 * 高架としても建てられず、地表にも描かれなくなっていた。
 * 浜松駅周辺 1km 四方の実測で、地表の線路が 46 本すべて消えていた。
 */
function isElevated(tags: Record<string, string>, lengthM: number): boolean {
  return classify(tags, lengthM) !== null;
}

function isUnderground(tags: Record<string, string>): boolean {
  const layer = parseNumber(tags.layer) ?? 0;
  return (tags.tunnel !== undefined && tags.tunnel !== 'no') || layer < 0;
}

/** 経路の長さ (m) */
function pathLengthOf(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const cos = Math.cos((a.lat * Math.PI) / 180) || 1;
    total += Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * 111_320 * cos);
  }
  return total;
}

/** OSM の要素から、道路・線路・点を取り出す */
export function buildRoadScene(elements: OverpassElement[]): RoadScene {
  const roads: RoadPiece[] = [];
  const rails: RailPiece[] = [];
  const points: RoadPoint[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};

    if (el.type === 'node') {
      const kind =
        tags.highway === 'traffic_signals'
          ? 'traffic_signal'
          : tags.highway === 'crossing'
            ? 'crossing'
            : tags.highway === 'stop'
              ? 'stop'
              : null;
      if (kind && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
        points.push({
          id: `osm:node${el.id}`,
          kind,
          position: { lat: el.lat as number, lng: el.lon as number },
          name: tags.name,
        });
      }
      continue;
    }

    if (el.type !== 'way') continue;
    const geometry = el.geometry ?? [];
    if (geometry.length < 2) continue;
    const path = geometry.map((p) => ({ lat: p.lat, lng: p.lon }));
    // 高架として建てられるかは長さにも依る（市街地の高架は長く続く）
    const lengthM = pathLengthOf(path);

    if (tags.railway) {
      if (!['rail', 'light_rail', 'subway', 'tram', 'monorail'].includes(tags.railway)) continue;
      rails.push({
        id: `osm:way${el.id}`,
        name: tags.name,
        path,
        tracks: clamp(Math.round(parseNumber(tags.tracks) ?? 1), 1, MAX_TRACKS),
        elevated: isElevated(tags, lengthM),
        underground: isUnderground(tags),
      });
      continue;
    }

    const cls = roadClassOf(tags);
    if (!cls) continue;
    roads.push({
      id: `osm:way${el.id}`,
      cls,
      name: tags.name,
      path,
      width: roadWidthOf(cls, tags),
      lanes: laneCountOf(cls, tags),
      oneway: tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout',
      speedLimit: speedLimitOf(tags),
      elevated: isElevated(tags, lengthM),
      underground: isUnderground(tags),
    });
  }

  return { roads, rails, points: orientPoints(points, roads) };
}

/**
 * 点（信号など）に、その点が付いている道の向きを与える。
 *
 * 信号の灯器とアームはこの向きに合わせる。以前は真北に固定していたため、
 * 交差点のどの方向を制御しているのか分からず、
 * 灯器を真横から見ることになって「信号が無い」ようにしか見えなかった。
 *
 * 向きは OSM の way の形から取る。信号のノードは必ずどれかの way の上に
 * あるので、最も近い区間の方位をそのまま使う。
 */
export function orientPoints(points: RoadPoint[], roads: RoadPiece[]): RoadPoint[] {
  if (roads.length === 0) return points;
  return points.map((point) => {
    if (point.kind !== 'traffic_signal') return point;
    const near = nearestCarriageway(point.position, roads);
    if (!near) return point;
    return { ...point, headingDeg: near.headingDeg, roadWidth: near.width };
  });
}

/** その地点にいちばん近い車道の区間。向きと幅を返す。無ければ null */
function nearestCarriageway(
  point: LatLng,
  roads: RoadPiece[],
): { headingDeg: number; width: number } | null {
  let best = Number.POSITIVE_INFINITY;
  let found: { headingDeg: number; width: number } | null = null;
  for (const road of roads) {
    // 歩道や横断歩道ではなく、車道の向きに合わせる
    if (road.lanes === 0) continue;
    for (let i = 1; i < road.path.length; i += 1) {
      const a = road.path[i - 1];
      const b = road.path[i];
      const d = distanceToSegment(point, a, b);
      if (d >= best) continue;
      best = d;
      const cos = Math.cos((a.lat * Math.PI) / 180) || 1;
      found = {
        headingDeg: (Math.atan2((b.lng - a.lng) * cos, b.lat - a.lat) * 180) / Math.PI,
        width: road.width,
      };
    }
  }
  // 20m 以上離れているなら、その道に付いている信号とは言えない
  if (!found || best > 20) return null;
  return found;
}

// ---- 細切れの道をつなぐ -----------------------------------------------

/**
 * つないでよいと見なす端点の距離 (m)。
 * OSM の交差点ノードは共有されるので、本来は完全一致する。
 * 浮動小数の丸めぶんだけ見ておく。
 */
const STITCH_TOLERANCE_M = 0.5;

/** 描き方が同じかどうか。違えば別の形として描く必要がある */
function sameAppearance(a: RoadPiece, b: RoadPiece): boolean {
  return (
    a.cls === b.cls &&
    a.width === b.width &&
    a.lanes === b.lanes &&
    a.oneway === b.oneway &&
    a.elevated === b.elevated &&
    a.underground === b.underground &&
    a.speedLimit === b.speedLimit
  );
}

function samePoint(a: LatLng, b: LatLng): boolean {
  const cos = Math.cos((a.lat * Math.PI) / 180) || 1;
  const dx = (b.lng - a.lng) * cos * 111_320;
  const dy = (b.lat - a.lat) * 111_320;
  return Math.hypot(dx, dy) <= STITCH_TOLERANCE_M;
}

function endpointKey(p: LatLng): string {
  // 約 0.1m 格子。STITCH_TOLERANCE_M より細かいので取りこぼさない
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

/**
 * 交差点で切れた道をつなぎ直す。
 *
 * OSM は道路を交差点ごとに別の way にする。そのまま描くと、
 * 1 本の通りが何十個もの形に分かれ、描画のまとまりがその数だけ要る。
 * 浜松駅周辺 1km 四方の実測（2026-09）で道路 1,817 本。
 *
 * 頂点の数は変わらない（つなぎ目の重複が減るだけ）。減るのは
 * **形の個数**で、これは組み立てとメモリの負担に直結する。
 * 部品も精度も落とさずに軽くする方法。
 *
 * 誤ってつなぐと、曲がっていない道が曲がって見える。防ぐために:
 *   - 描き方が同じもの同士でしかつながない（種別・幅・車線数・速度制限）
 *   - 名前があるときは名前の一致を要求する
 *   - その端点でつながる候補が **ちょうど 1 本** のときだけつなぐ。
 *     分岐点では、どちらへ延ばしても嘘になるのでつながない
 */
export function stitchRoads(roads: RoadPiece[]): RoadPiece[] {
  // 端点 → そこに接する道の添字
  const ends = new Map<string, number[]>();
  const add = (p: LatLng, i: number) => {
    const key = endpointKey(p);
    const list = ends.get(key);
    if (list) list.push(i);
    else ends.set(key, [i]);
  };
  roads.forEach((r, i) => {
    if (r.path.length < 2) return;
    add(r.path[0], i);
    add(r.path[r.path.length - 1], i);
  });

  /**
   * その端点でつなげる相手を返す。
   *
   * 端点に接する道が **ちょうど 2 本** のときだけつなぐ。
   * 1 本なら行き止まり、3 本以上なら交差点か分岐で、
   * どちらへ延ばしても実際とは違う線形になる。
   */
  const partnerAt = (point: LatLng): number | null => {
    const list = ends.get(endpointKey(point)) ?? [];
    if (list.length !== 2) return null;
    // 取り込み済みのものは相手にならない（自分自身もここで外れる）
    const free = list.filter((j) => !used.has(j));
    return free.length === 1 ? free[0] : null;
  };

  const used = new Set<number>();
  const out: RoadPiece[] = [];

  for (let i = 0; i < roads.length; i += 1) {
    if (used.has(i)) continue;
    const start = roads[i];
    if (start.path.length < 2) {
      used.add(i);
      out.push(start);
      continue;
    }
    used.add(i);
    let path = [...start.path];

    // 前と後ろへ、つながる限り伸ばす
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? path[path.length - 1] : path[0];
        const j = partnerAt(tip);
        if (j === null) break;

        const next = roads[j];
        if (!sameAppearance(start, next)) break;
        if ((start.name ?? null) !== (next.name ?? null)) break;

        // 相手の向きを揃えてつなぐ（つなぎ目の点は重複させない）
        const head = next.path[0];
        const tail = next.path[next.path.length - 1];
        let piece: LatLng[];
        if (samePoint(tip, head)) piece = next.path.slice(1);
        else if (samePoint(tip, tail)) piece = [...next.path].reverse().slice(1);
        else break;

        used.add(j);
        path = forward ? [...path, ...piece] : [...piece.reverse(), ...path];
      }
    }

    out.push(path.length === start.path.length ? start : { ...start, path });
  }

  return out;
}

// ---- 形を組み立てる ---------------------------------------------------

/** 中心線を進行方向の右へ offset だけずらす */
function offsetPath(path: LatLng[], offsetM: number): LatLng[] {
  if (offsetM === 0) return path;
  return path.map((p, i) => {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    const cos = Math.cos((p.lat * Math.PI) / 180) || 1;
    const east = (next.lng - prev.lng) * cos;
    const north = next.lat - prev.lat;
    const len = Math.hypot(east, north);
    if (len === 0) return p;
    // 進行方向に対して右向きの単位ベクトル
    const rx = north / len;
    const ry = -east / len;
    return {
      lat: p.lat + (ry * offsetM) / 111_320,
      lng: p.lng + (rx * offsetM) / (111_320 * cos),
    };
  });
}

/**
 * どこまで細かく組み立てるか。
 *
 * 上空から街全体を見ているとき、区画線は幅 15cm しかなく、
 * 描いても線が密集した灰色の帯にしかならない。
 * 市販のカーナビや地図アプリも、引くと区画線を消している。
 *
 * 部品を減らしているのではなく、見えないものを描いていない。
 * 近づけば元どおり出る。
 */
export interface RoadDetail {
  /** 区画線（外側線・中央線・車線境界線）と横断歩道を引くか */
  laneMarkings: boolean;
}

export const FULL_DETAIL: RoadDetail = { laneMarkings: true };

/**
 * 区画線を描く上限のカメラ高度 (m)。
 *
 * これより上から見ると、区画線は互いに近すぎて分離して見えない。
 * 街区の形が分かればよい高さなので、舗装だけで足りる。
 */
export const LANE_MARKING_MAX_HEIGHT_M = 800;

/** カメラ高度から詳細度を決める */
export function detailForHeight(heightMeters: number): RoadDetail {
  return { laneMarkings: heightMeters <= LANE_MARKING_MAX_HEIGHT_M };
}

// ---- 交差点 ------------------------------------------------------------

/**
 * 交差点。
 *
 * OSM は交差する道どうしにノードを共有させているので、
 * 「何本の道の端がその点に集まっているか」で交差点を見分けられる。
 * 位置を作っているわけではなく、共有ノードを数えているだけ。
 */
export interface Intersection {
  point: LatLng;
  /**
   * 交差点の広がり (m)。
   *
   * 交わっている道のうち最も広いものの半分に、停止線の手前ぶんを足す。
   * 実物の区画線は交差点の中まで引かれておらず、
   * 手前の停止線で切れている（区画線 203 停止線）。
   */
  radius: number;
  /** 信号のある交差点か */
  signalised: boolean;
}

/** 座標をキーにした交差点の索引 */
export type IntersectionIndex = Map<string, Intersection>;

/**
 * 座標のキー。
 *
 * OSM で同じノードを共有する way は、まったく同じ座標を持つ。
 * 小数 7 桁（およそ 1cm）まで見れば取り違えない。
 */
function nodeKey(p: LatLng): string {
  return `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
}

/**
 * 交差点の手前で区画線を切るための余裕 (m)。
 *
 * 停止線は横断歩道の手前に引かれる。横断歩道の幅は 3〜4m
 * （道路標識・区画線及び道路標示に関する命令 別表第 4 の 201 横断歩道）。
 */
const STOP_LINE_SETBACK_M = 2.0;

/**
 * 道路のつながりから交差点を割り出す。
 *
 * 「次数」で見分ける。ある点に集まっている道路区間の端の数を数え、
 * 3 以上なら交差点とする。way が途中で分割されているだけの点は 2 になる。
 *
 * これをやらないと、区画線が交差点の中を突っ切って互いに交わり、
 * 上から見ると白線が格子状に重なって見える（実物はそうなっていない）。
 */
export function buildIntersections(
  roads: RoadPiece[],
  points: RoadPoint[] = [],
): IntersectionIndex {
  const degree = new Map<string, number>();
  const widest = new Map<string, number>();
  const at = new Map<string, LatLng>();

  for (const road of roads) {
    // 歩道や横断歩道は車道の交差点を作らない
    if (road.lanes === 0 || road.underground || road.elevated) continue;
    road.path.forEach((p, i) => {
      const key = nodeKey(p);
      // 端は 1、途中の点は 2 本ぶんの区間が集まっている
      const add = i === 0 || i === road.path.length - 1 ? 1 : 2;
      degree.set(key, (degree.get(key) ?? 0) + add);
      widest.set(key, Math.max(widest.get(key) ?? 0, road.width));
      if (!at.has(key)) at.set(key, p);
    });
  }

  // 信号のある点。信号は交差点の中心ではなく停止線の位置に打たれることが
  // 多いので、少し離れていても同じ交差点とみなす
  const signals = points.filter((p) => p.kind === 'traffic_signal');

  const out: IntersectionIndex = new Map();
  for (const [key, count] of degree) {
    if (count < 3) continue;
    const point = at.get(key);
    if (!point) continue;
    const width = widest.get(key) ?? 6;
    const signalised = signals.some((s) => distanceMeters(s.position, point) < 25);
    out.set(key, { point, radius: width / 2 + STOP_LINE_SETBACK_M, signalised });
  }
  return out;
}

/**
 * 経路を交差点で分断する。
 *
 * 交差点は道の端にも途中にもある。途中の交差点で切らないと、
 * その道の区画線だけが交差点を突っ切ることになる。
 *
 * 舗装は切らない（アスファルトは交差点の中まで続いている）。
 * 切るのは区画線だけ。
 *
 * @returns 区画線を引いてよい区間の並び。引けるところが無ければ空
 */
export function splitAtIntersections(
  path: LatLng[],
  intersections: IntersectionIndex,
): LatLng[][] {
  if (path.length < 2) return [];
  if (intersections.size === 0) return [path];

  // まず、経路上のどこに交差点があるかを累積距離で拾う
  const cumulative = [0];
  for (let i = 1; i < path.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMeters(path[i - 1], path[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return [];

  /** 引かない区間 [開始, 終了]（累積距離） */
  const gaps: [number, number][] = [];
  path.forEach((p, i) => {
    const node = intersections.get(nodeKey(p));
    if (!node) return;
    gaps.push([cumulative[i] - node.radius, cumulative[i] + node.radius]);
  });
  if (gaps.length === 0) return [path];

  gaps.sort((a, b) => a[0] - b[0]);
  const out: LatLng[][] = [];
  let from = 0;
  for (const [gapStart, gapEnd] of gaps) {
    if (gapStart > from) {
      const piece = sliceByDistance(path, cumulative, from, Math.min(gapStart, total));
      if (piece.length >= 2) out.push(piece);
    }
    from = Math.max(from, gapEnd);
  }
  if (from < total) {
    const piece = sliceByDistance(path, cumulative, from, total);
    if (piece.length >= 2) out.push(piece);
  }
  return out;
}

/** 累積距離 [from, to] の区間を切り出す */
function sliceByDistance(
  path: LatLng[],
  cumulative: number[],
  from: number,
  to: number,
): LatLng[] {
  if (!(to > from)) return [];
  const out: LatLng[] = [pointAtDistance(path, cumulative, from)];
  for (let i = 0; i < path.length; i += 1) {
    if (cumulative[i] > from && cumulative[i] < to) out.push(path[i]);
  }
  out.push(pointAtDistance(path, cumulative, to));
  return out;
}

/** 累積距離 d の位置の座標 */
function pointAtDistance(path: LatLng[], cumulative: number[], d: number): LatLng {
  if (d <= 0) return path[0];
  const last = cumulative.length - 1;
  if (d >= cumulative[last]) return path[last];
  for (let i = 1; i <= last; i += 1) {
    if (d <= cumulative[i]) {
      const span = cumulative[i] - cumulative[i - 1];
      const r = span > 0 ? (d - cumulative[i - 1]) / span : 0;
      return {
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * r,
        lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * r,
      };
    }
  }
  return path[last];
}

/**
 * 停止線。
 *
 * 出典: 道路標識、区画線及び道路標示に関する命令 別表第 4（203 停止線）。
 *   幅 0.3〜0.45m、車道を横断して引く。
 *
 * 信号のある交差点の、進入してくる車線ぶんだけに引く。
 * 日本は左側通行なので、進入側は進行方向に向かって左半分。
 */
export function stopLineShapes(
  road: RoadPiece,
  intersections: IntersectionIndex,
): SceneShape[] {
  if (road.lanes === 0 || road.underground || road.elevated) return [];
  if (!(road.width > 0) || road.path.length < 2) return [];

  const cumulative = [0];
  for (let i = 1; i < road.path.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMeters(road.path[i - 1], road.path[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return [];

  const out: SceneShape[] = [];
  road.path.forEach((p, i) => {
    const node = intersections.get(nodeKey(p));
    if (!node?.signalised) return;

    // 交差点へ向かってくる側それぞれに 1 本ずつ。
    // 道の途中の交差点なら手前と奥の 2 本、端なら 1 本
    for (const sign of [-1, 1] as const) {
      const at = cumulative[i] + sign * node.radius;
      if (at <= 0 || at >= total) continue;
      const centreLine = pointAtDistance(road.path, cumulative, at);
      // 交差点へ向かう向き
      const ahead = pointAtDistance(road.path, cumulative, at - sign * 1);
      const heading = headingBetween(ahead, centreLine);

      // 進入車線ぶんの幅。一方通行なら全幅、対面通行なら左半分
      const span = road.oneway ? road.width : road.width / 2;
      const centre = road.oneway ? centreLine : offsetFrom(centreLine, span / 2, heading - 90);

      out.push({
        kind: 'ribbon',
        id: `${road.id}#stop${i}${sign > 0 ? 'f' : 'b'}`,
        path: [
          offsetFrom(centre, span / 2, heading + 90),
          offsetFrom(centre, span / 2, heading - 90),
        ],
        width: 0.45,
        color: LINE.centreColor,
        order: ORDER.centre,
      });
    }
  });
  return out;
}

/** 真北 0・東回りの方位角 (度) */
function headingBetween(a: LatLng, b: LatLng): number {
  const cos = Math.cos((a.lat * Math.PI) / 180) || 1;
  return (Math.atan2((b.lng - a.lng) * cos, b.lat - a.lat) * 180) / Math.PI;
}

/** 方位 headingDeg の向きへ offsetM 進んだ地点 */
function offsetFrom(point: LatLng, offsetM: number, headingDeg: number): LatLng {
  const rad = (headingDeg * Math.PI) / 180;
  const cos = Math.cos((point.lat * Math.PI) / 180) || 1;
  return {
    lat: point.lat + (Math.cos(rad) * offsetM) / 111_320,
    lng: point.lng + (Math.sin(rad) * offsetM) / (111_320 * cos),
  };
}

/**
 * 車道 1 本ぶんの地表の形。
 *
 * 舗装の帯を敷き、その上に区画線を重ねる。
 * 車線が 2 以上あるときだけ中央線を引く（1 車線の道に中央線は無い）。
 */
export function roadShapes(
  road: RoadPiece,
  detail: RoadDetail = FULL_DETAIL,
  /**
   * 交差点の索引。渡すと、区画線を交差点の手前で切る。
   *
   * 実物の区画線は交差点の中まで引かれていない。切らずに引くと、
   * 交差する道の白線どうしが中央で重なり、上から見ると格子状になる。
   */
  intersections: IntersectionIndex = new Map(),
): SceneShape[] {
  if (road.underground || road.elevated) return [];
  // 幅の無い舗装は描けない。0 や負の値が来たら何も出さない
  if (!(road.width > 0)) return [];
  const spec = ROAD_SPEC[road.cls];
  const out: SceneShape[] = [];

  const pavement: GroundRibbon = {
    kind: 'ribbon',
    id: road.id,
    // 舗装は切らない。アスファルトは交差点の中まで続いている
    path: road.path,
    width: road.width,
    color: spec.color,
    order: ORDER.pavement,
  } as GroundRibbon;
  out.push(pavement);

  // 歩行者用の道には区画線を引かない。
  // 上空から見ているときも、区画線は見えないので組み立てない
  if (spec.lanes === 0 || !detail.laneMarkings) return out;

  // 区画線はここから先、交差点にかからない区間ごとに引く
  const segments = splitAtIntersections(road.path, intersections);
  if (segments.length === 0) return out;

  // 外側線（車道外側線）。車道の両端から 0.5m 内側。
  // 引くのは幹線の道だけ。住宅街の道や区画内の通路には引かれていない。
  // 以前はすべての車道に引いていたが、それは実際と違ううえ、
  // 浜松 1km 四方の実測（2026-09）で全頂点の 39% を占めていた
  if (HAS_EDGE_LINE.has(road.cls)) {
    const edgeOffset = road.width / 2 - 0.5;
    for (const segment of segments) {
      for (const side of [-1, 1]) {
        out.push({
          kind: 'ribbon',
          path: offsetPath(segment, edgeOffset * side),
          width: LINE.edgeWidth,
          color: LINE.edgeColor,
          order: ORDER.edge,
        });
      }
    }
  }

  // 中央線を引くのは、対向車線があり、かつ車道幅員が 5.5m 以上のとき。
  // 道路構造令でセンターラインが引かれるのはこの幅から。
  // 生活道路（幅 4〜5m）に中央線が引かれることは実際には無い
  if (road.lanes >= 2 && !road.oneway && road.width >= 5.5) {
    for (const segment of segments) {
      out.push({
        kind: 'ribbon',
        path: segment,
        width: LINE.width,
        color: LINE.centreColor,
        order: ORDER.centre,
      });
    }
  }

  // 車線境界線。中央線と外側線の間を車線数で割る
  const half = road.oneway ? road.lanes : road.lanes / 2;
  if (half >= 2) {
    const laneWidth = (road.width - 1.0) / road.lanes;
    for (const segment of segments) {
      for (let i = 1; i < half; i += 1) {
        for (const side of road.oneway ? [1] : [-1, 1]) {
          out.push({
            kind: 'ribbon',
            path: offsetPath(segment, laneWidth * i * side),
            width: LINE.width,
            color: LINE.laneColor,
            dash: LINE.laneDash,
            order: ORDER.lane,
          });
        }
      }
    }
  }

  // 信号のある交差点には停止線を引く
  out.push(...stopLineShapes(road, intersections));

  return out;
}

/** 横断歩道。等間隔の白い帯を並べる（実物と同じゼブラ） */
export function crossingShapes(road: RoadPiece, detail: RoadDetail = FULL_DETAIL): SceneShape[] {
  if (road.cls !== 'crossing' || road.underground) return [];
  // 45cm の縞は上空からは分離して見えない
  if (!detail.laneMarkings) return [];
  return [
    {
      kind: 'ribbon',
      id: road.id,
      path: road.path,
      width: ROAD_SPEC.crossing.width,
      color: ROAD_SPEC.crossing.color,
      // 45cm の白帯を 45cm 間隔で。道路標示の標準
      dash: [0.45, 0.45],
      order: ORDER.crossing,
    },
  ];
}

/** 軌道中心の間隔 (m)。在来線 3.8〜4.0 / 新幹線 4.3 */
const TRACK_SPACING = 4.1;

/**
 * 地表の線路。
 *
 * バラスト（道床）の台形と、その上の 2 本のレール。
 * 高架区間は elevated-structures が別に建てるので、ここでは扱わない。
 */
export function railShapes(rail: RailPiece, groundHeight: (p: LatLng) => number): SceneShape[] {
  if (rail.elevated || rail.underground) return [];
  const out: SceneShape[] = [];
  // 地形が取れないと NaN が返ることがある。平地として扱う
  const height = (p: LatLng) => {
    const h = groundHeight(p);
    return Number.isFinite(h) ? h : 0;
  };
  // 呼び出し側が上限を掛け忘れても固まらないよう、ここでも収める
  const tracks = clamp(Math.round(rail.tracks), 1, MAX_TRACKS);
  const span = (tracks - 1) * TRACK_SPACING;

  for (let i = 0; i < tracks; i += 1) {
    const offset = -span / 2 + i * TRACK_SPACING;
    const centre = offsetPath(rail.path, offset);
    const withHeight: LatLngAlt[] = centre.map((p) => ({ ...p, alt: height(p) }));

    // 道床。上底 3.0m / 下底 4.4m / 高さ 0.4m の台形
    out.push({
      kind: 'extrusion',
      id: `${rail.id}#bed${i}`,
      path: withHeight,
      section: [
        { x: -2.2, y: 0 },
        { x: 2.2, y: 0 },
        { x: 1.5, y: 0.4 },
        { x: -1.5, y: 0.4 },
      ],
      color: '#6e6a63',
    } as SceneShape);

    // レール 2 本。軌間 1,067mm（在来線）。レール頭部は道床から 0.2m
    for (const gauge of [-0.5335, 0.5335]) {
      out.push({
        kind: 'extrusion',
        id: `${rail.id}#rail${i}${gauge > 0 ? 'R' : 'L'}`,
        path: offsetPath(centre, gauge).map((p) => ({ ...p, alt: height(p) + 0.4 })),
        section: [
          { x: -0.035, y: 0 },
          { x: 0.035, y: 0 },
          { x: 0.035, y: 0.15 },
          { x: -0.035, y: 0.15 },
        ],
        color: '#8a8073',
        castsShadow: false,
      } as SceneShape);
    }
  }
  return out;
}

/**
 * 信号機。
 *
 * 位置は OSM の実データ。柱の高さと灯器の大きさは
 * 日本の車両用交通信号灯器（300mm 灯 3 位）の標準寸法に合わせている。
 */
/**
 * 信号 1 基。
 *
 * 形と寸法は street-furniture-geometry が持つ（警察庁の設置基準の実寸）。
 * ここは「どの点に、どの向きで置くか」だけを決める。
 */
export function signalShapes(
  point: RoadPoint,
  groundHeight: (p: LatLng) => number,
): SceneShape[] {
  if (point.kind !== 'traffic_signal') return [];
  const raw = groundHeight(point.position);
  // 柱は路肩に立てる。車道の半分 + 路肩 0.6m
  const kerbOffsetM = point.roadWidth ? point.roadWidth / 2 + 0.6 : 0;
  return trafficSignalShapes(point.position, {
    ground: Number.isFinite(raw) ? raw : 0,
    headingDeg: point.headingDeg,
    kerbOffsetM,
  });
}

/** 範囲内に収まる道路だけに絞る（表示範囲の外を組み立てない） */
export function clipToBBox<T extends { path: LatLng[] }>(pieces: T[], bbox: BBox): T[] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return pieces.filter((piece) =>
    piece.path.some(
      (p) => p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat,
    ),
  );
}

/**
 * 点から線分までの距離 (m)。
 *
 * 緯度経度のまま計算すると経度方向が詰まって見えるので、
 * その緯度での 1 度あたりの距離を掛けて局所的な平面に直す。
 */
function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const cos = Math.cos((p.lat * Math.PI) / 180) || 1;
  const toXY = (q: LatLng) => ({
    x: (q.lng - p.lng) * cos * 111_320,
    y: (q.lat - p.lat) * 111_320,
  });
  const A = toXY(a);
  const B = toXY(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(A.x, A.y);
  // 線分上への射影の位置（0〜1 に切り詰める）
  const t = Math.min(1, Math.max(0, -(A.x * dx + A.y * dy) / lenSq));
  return Math.hypot(A.x + dx * t, A.y + dy * t);
}

/**
 * その位置にいちばん近い道路を返す。
 *
 * 走行中の制限速度を出すために使う。
 * 離れすぎているとき（道の無いところにいるとき）は null を返す。
 * 見つからないより、間違った道の制限速度を出すほうが害が大きい。
 */
export function nearestRoad(
  roads: RoadPiece[],
  position: LatLng,
  maxDistanceM = 25,
): RoadPiece | null {
  let best: RoadPiece | null = null;
  let bestDistance = maxDistanceM;

  // 緯度経度での許容差。これより離れた頂点しか持たない道は見るまでもない。
  // 全線分の距離を真面目に測ると、道路 2,500 本で 1 回 4ms かかる
  const cos = Math.cos((position.lat * Math.PI) / 180) || 1;
  const dLat = maxDistanceM / 111_320;
  const dLng = maxDistanceM / (111_320 * cos);

  for (const road of roads) {
    // 歩道や横断歩道に車の制限速度は無い
    if (ROAD_SPEC[road.cls].lanes === 0) continue;

    // 経路を囲む矩形で早めに落とす。線分ごとの計算より桁違いに安い
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const p of road.path) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    if (
      position.lat < minLat - dLat ||
      position.lat > maxLat + dLat ||
      position.lng < minLng - dLng ||
      position.lng > maxLng + dLng
    ) {
      continue;
    }

    for (let i = 0; i < road.path.length - 1; i += 1) {
      const d = distanceToSegment(position, road.path[i], road.path[i + 1]);
      if (d < bestDistance) {
        bestDistance = d;
        best = road;
      }
    }
  }
  return best;
}

/**
 * 範囲内の道路・線路・信号を取得して解釈する。
 *
 * Overpass の公開インスタンスは混雑時に落ちるので、
 * そのときは OSM 本体の API に切り替える（絞り込みができない代わりに
 * 範囲内の全要素を確実に返す）。どちらも駄目なら空で返す。
 * 道が出なくても地図とナビは成立するので、例外は投げない。
 */
export async function fetchRoadScene(bbox: BBox): Promise<RoadScene> {
  // 切り替えぶんも含めた合計時間に締め切りを置く。
  // 置かないと、Overpass の各エンドポイントが順に時間切れになったあとに
  // OSM 本体を待つことになり、API 側の maxDuration を超える
  const deadline = deadlineIn();
  let elements: OverpassElement[] = [];
  try {
    elements = (await fetchRoadNetwork(bbox, primaryDeadline(deadline))).elements;
  } catch {
    try {
      elements = await fetchOsmMap(bbox, deadline);
    } catch {
      return { roads: [], rails: [], points: [], degraded: true };
    }
  }
  return buildRoadScene(elements);
}
