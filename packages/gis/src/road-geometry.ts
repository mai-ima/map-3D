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
import { bearingDegrees, distanceMeters } from '@ijm/shared';
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
  /**
   * 線路の種別（OSM の `railway`）。
   * 縦断勾配の上限がこれで変わる（新幹線は緩く、路面電車は急）。
   */
  kind?: 'rail' | 'light_rail' | 'subway' | 'tram' | 'monorail';
  /**
   * 電化されているか（OSM の `electrified`）。
   * 架線柱を立てるかどうかの判断に使う。**タグが無ければ立てない。**
   */
  electrified?: boolean;
  /** 新幹線か（OSM の `usage=main` かつ `highspeed=yes`、または名前から） */
  highspeed?: boolean;
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
        kind: tags.railway as RailPiece['kind'],
        // 電化の有無は OSM に入っているときだけ見る。
        // `electrified=no` と書かれていることもあるので、値まで確かめる
        electrified:
          tags.electrified !== undefined && tags.electrified !== 'no'
            ? true
            : tags.electrified === 'no'
              ? false
              : undefined,
        highspeed: tags.highspeed === 'yes',
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
  // toFixed は書式化のために文字列を組み立て直すので、整数へ丸めてから
  // 文字列にするより数倍遅い。ここは道の頂点ごとに何度も呼ばれる
  // （東京駅周辺 1km 四方で 1 回の組み立てにつき約 9 万回）。
  // OSM で同じノードを共有する way はまったく同じ値を持つので、
  // どちらの丸め方でも同じキーになる
  return `${Math.round(p.lat * 1e7)},${Math.round(p.lng * 1e7)}`;
}

/**
 * 交差点の手前で区画線を切るための余裕 (m)。
 *
 * 停止線は横断歩道の手前に引かれる。横断歩道の幅は 3〜4m
 * （道路標識・区画線及び道路標示に関する命令 別表第 4 の 201 横断歩道）。
 */
const STOP_LINE_SETBACK_M = 2.0;

/**
 * 信号が「その交差点のもの」とみなす距離 (m)。
 *
 * 信号のノードは交差点の中心ではなく停止線の位置に打たれることが多い。
 * 交差点の幅が片側 2 車線でも 15m 前後なので、25m 取れば取りこぼさない。
 */
const SIGNAL_MATCH_M = 25;

/**
 * 近くに信号があるかを引くための格子。
 *
 * 素朴に「すべての信号との距離を測る」と、交差点候補 × 信号数の掛け算になる。
 * 東京駅周辺 1km 四方の実測（2026-09）では候補が約 3 万点・信号が約 400 個で、
 * 1,200 万回の距離計算になり、これだけで 13.7ms かかっていた
 * （1 フレーム 16.7ms のほとんどを 1 つの処理が食う）。
 *
 * 25m の格子に入れておけば、見るのは自分と周囲 8 マスの計 9 マスで済む。
 * 精度は落ちない。距離の判定そのものは今までどおり行う。
 */
function signalGrid(signals: RoadPoint[]): (at: LatLng) => boolean {
  if (signals.length === 0) return () => false;

  // 経度 1 度あたりの距離は緯度で変わる。範囲の中央で 1 度だけ求める
  const midLat = signals.reduce((sum, s) => sum + s.position.lat, 0) / signals.length;
  const cos = Math.max(0.1, Math.cos((midLat * Math.PI) / 180));
  const latCell = SIGNAL_MATCH_M / 111_320;
  const lngCell = latCell / cos;

  const cells = new Map<string, LatLng[]>();
  for (const signal of signals) {
    const key = `${Math.floor(signal.position.lat / latCell)},${Math.floor(signal.position.lng / lngCell)}`;
    const list = cells.get(key);
    if (list) list.push(signal.position);
    else cells.set(key, [signal.position]);
  }

  return (at: LatLng) => {
    const row = Math.floor(at.lat / latCell);
    const col = Math.floor(at.lng / lngCell);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const list = cells.get(`${row + dr},${col + dc}`);
        if (!list) continue;
        for (const position of list) {
          if (distanceMeters(position, at) < SIGNAL_MATCH_M) return true;
        }
      }
    }
    return false;
  };
}

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
  const hasSignalNear = signalGrid(points.filter((p) => p.kind === 'traffic_signal'));

  const out: IntersectionIndex = new Map();
  for (const [key, count] of degree) {
    if (count < 3) continue;
    const point = at.get(key);
    if (!point) continue;
    const width = widest.get(key) ?? 6;
    out.set(key, {
      point,
      radius: width / 2 + STOP_LINE_SETBACK_M,
      signalised: hasSignalNear(point),
    });
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
 * 縦断勾配の上限 (‰)。
 *
 * 出典: 鉄道に関する技術上の基準を定める省令の解釈基準 第 15 条。
 * 実物の線路は路盤で平されていて、地面の細かい起伏をなぞらない。
 * 標高をそのまま使うと線路が波打ち、見た目が地面の凹凸そのものになる。
 */
const MAX_RAIL_GRADE: Record<NonNullable<RailPiece['kind']>, number> = {
  // 本線の最急勾配。新幹線は 15‰ だが、上越新幹線に 30‰ の区間がある
  rail: 35,
  light_rail: 40,
  subway: 35,
  // 併用軌道（路面電車）は道路の勾配に従うので緩められない
  tram: 60,
  monorail: 60,
};

/**
 * 道床が路盤に食い込む深さ (m)。
 *
 * バラスト道床は路盤の上に「載っている」のではなく、
 * 路盤を掘り下げた道床厚のぶんだけ沈んでいる。
 * 在来線の道床厚は 25cm（省令の解釈基準）で、
 * そのうち枕木下の有効厚が確保されていればよい。
 *
 * **これが「線路が埋まる」ことへの備えにもなる。**
 * 地形の標高は格子から補間するので、実際の地面と数十センチずれる。
 * 東京駅周辺の実測（2026-09、国土地理院の標高 API と 100m 格子の比較）
 * では中央値 0.08m・最大 0.25m ずれ、半数の点で地形のほうが高かった。
 * 道床の上面が地表より確実に出るよう、下端を沈めて高さを稼ぐ。
 */
const BALLAST_EMBED_M = 0.15;

/**
 * 架線柱の高さ (m)。
 *
 * 出典: 電車線路設備の標準。
 * 架線（トロリ線）の高さは軌道面から 5.0m 以上、
 * その上に吊架線とがいし・腕金が載るので、柱の頂部は 6.5m 前後になる。
 */
const CATENARY_HEIGHT_M = 6.5;

/**
 * 枕木の標準間隔 (m)。
 *
 * 出典: 在来線 1 級線の PC まくらぎは 1km あたり 1,850 本。
 * 1000 / 1850 ＝ 0.54m。
 */
const SLEEPER_STEP_M = 0.54;

/**
 * 架線柱の標準間隔 (m)。
 * 出典: 電車線路設備の標準（直線区間の標準径間 50m）。
 */
const CATENARY_STEP_M = 50;

/**
 * way 1 本あたりの上限。
 *
 * OSM の way は 1 本で数キロに及ぶことがあり、`tracks` も 40 まで来る。
 * 東京駅周辺 1km 四方の地表の線路は総延長およそ 7km あり、
 * 0.54m 間隔の枕木は 13,000 本になる。20 面 20 線の駅構内なら桁が増える。
 *
 * **上限は way 全体で掛け、線路の本数で割り振る。**
 * 線路ごとに上限を掛けると、駅構内で本数ぶんだけ倍になる
 * （実際に tracks=40 で 24,000 個まで膨らんだ）。
 *
 * 300 本 × 0.54m ＝ 162m ぶん。描画側は半径 120m の線路にしか
 * 枕木を描かないので、往復ぶんとして足りる。
 */
const MAX_SLEEPERS_PER_WAY = 300;
const MAX_CATENARY_PER_WAY = 80;

/**
 * 枕木を描く線路の本数の上限。
 *
 * 駅構内のように何本も並ぶところでは、枕木まで描いても分からない。
 * 1 本ずつ見分けられるのは、せいぜい複線・複々線まで。
 */
const MAX_TRACKS_WITH_SLEEPERS = 4;

/**
 * 線路をどこまで細かく描くか。
 *
 * カメラからの距離で決める。刻み幅は **2 の冪で**変える。
 * 半端な比率だと、詳細度が戻ったときに枕木が横滑りして見える。
 */
export interface RailDetail {
  /** 枕木の間隔 (m)。0 なら描かない */
  sleeperStep: number;
  /** 架線柱の間隔 (m)。0 なら描かない */
  catenaryStep: number;
}

export const FULL_RAIL_DETAIL: RailDetail = {
  sleeperStep: SLEEPER_STEP_M,
  catenaryStep: CATENARY_STEP_M,
};

/**
 * カメラの高さから線路の詳細度を決める。
 *
 *   60m 未満   枕木を実寸の間隔で。架線柱も標準間隔で
 *   160m 未満  枕木を 2 本に 1 本、架線柱は標準間隔のまま
 *   600m 未満  枕木は描かない（0.24m の幅は 1 画素を割る）。架線柱は 2 本に 1 本
 *   それ以上   道床とレールだけ
 *
 * 枕木の幅 0.24m は、視野角 60 度・幅 400 画素の画面で
 * 160m 離れるとおよそ 0.8 画素になる。そこから先は描いても見えない。
 *
 * 描画側はさらに「カメラから 120m 以内の線路」に絞る。
 * 東京駅は 20 面 20 線で密集しており、範囲内すべてに描くと
 * 道路全体より重くなる（実測: 枕木 13,397 個・頂点 339,448）。
 */
export function railDetailForHeight(cameraHeightM: number): RailDetail {
  const h = Number.isFinite(cameraHeightM) ? cameraHeightM : 0;
  if (h < 60) return FULL_RAIL_DETAIL;
  if (h < 160) return { sleeperStep: SLEEPER_STEP_M * 2, catenaryStep: CATENARY_STEP_M };
  if (h < 600) return { sleeperStep: 0, catenaryStep: CATENARY_STEP_M * 2 };
  return { sleeperStep: 0, catenaryStep: 0 };
}

/**
 * 線路の高さを、実際の敷設に合わせて平す。
 *
 * 地形の標高をそのまま頂点に当てると、線路が地面の凹凸をなぞって波打つ。
 * 実物の線路は路盤で平されていて、勾配は連続で緩やかに変わる。
 *
 * 2 段構えにする。
 *   1. 移動平均で細かい凹凸を落とす（路盤で平すことに相当）
 *   2. 隣り合う点の勾配が上限を超えないよう、下流へ向かって補正する
 *
 * @returns 各頂点の路盤高さ (m)
 */
export function levelRailHeights(
  path: LatLng[],
  groundHeight: (p: LatLng) => number,
  kind: RailPiece['kind'] = 'rail',
): number[] {
  const raw = path.map((p) => {
    const h = groundHeight(p);
    return Number.isFinite(h) ? h : 0;
  });
  if (raw.length <= 2) return raw;

  // 1. 移動平均（前後 1 点）。端は動かさない（接続先とずれるため）
  const smoothed = raw.map((h, i) => {
    if (i === 0 || i === raw.length - 1) return h;
    return (raw[i - 1] + h * 2 + raw[i + 1]) / 4;
  });

  // 2. 勾配の上限を守らせる。前から 1 回、後ろから 1 回かけると
  //    どちらの向きから見ても上限に収まる
  const maxGrade = (MAX_RAIL_GRADE[kind ?? 'rail'] ?? 35) / 1000;
  const limit = (from: number, to: number, step: number) => {
    for (let i = from; i !== to; i += step) {
      const span = distanceMeters(path[i - step], path[i]);
      if (!(span > 0)) continue;
      const allowed = span * maxGrade;
      const diff = smoothed[i] - smoothed[i - step];
      if (Math.abs(diff) > allowed) {
        smoothed[i] = smoothed[i - step] + Math.sign(diff) * allowed;
      }
    }
  };
  limit(1, smoothed.length, 1);
  limit(smoothed.length - 2, -1, -1);

  return smoothed;
}

/**
 * 地表の線路。
 *
 * バラスト（道床）の台形と、その上の 2 本のレール。
 * 高架区間は elevated-structures が別に建てるので、ここでは扱わない。
 */
export function railShapes(
  rail: RailPiece,
  groundHeight: (p: LatLng) => number,
  detail: RailDetail = FULL_RAIL_DETAIL,
): SceneShape[] {
  if (rail.elevated || rail.underground) return [];
  if (rail.path.length < 2) return [];
  const out: SceneShape[] = [];

  /**
   * 路盤の高さ。
   *
   * 地形の標高をそのまま当てず、実際の敷設に合わせて平す。
   * そのままだと線路が地面の凹凸をなぞって波打つ（`levelRailHeights` を参照）。
   */
  const levels = levelRailHeights(rail.path, groundHeight, rail.kind);
  /** 元の経路上の位置から、路盤の高さを引く */
  const bedHeight = (index: number) => levels[Math.min(levels.length - 1, Math.max(0, index))];

  // 呼び出し側が上限を掛け忘れても固まらないよう、ここでも収める
  const tracks = clamp(Math.round(rail.tracks), 1, MAX_TRACKS);
  const span = (tracks - 1) * TRACK_SPACING;
  const gauge = railGaugeOf(rail);

  for (let i = 0; i < tracks; i += 1) {
    const offset = -span / 2 + i * TRACK_SPACING;
    const centre = offsetPath(rail.path, offset);
    // 平行に寄せても頂点の数と順序は変わらないので、添字で高さを引ける
    const withHeight: LatLngAlt[] = centre.map((p, k) => ({ ...p, alt: bedHeight(k) }));

    /**
     * 道床（バラスト）。上底 3.0m / 下底 4.4m / 高さ 0.55m の台形。
     *
     * 出典: 鉄道に関する技術上の基準を定める省令の解釈基準。
     * 道床厚は在来線で 0.25m 以上、道床肩の勾配は 1:1.5。
     *
     * 下端を路盤より `BALLAST_EMBED_M` だけ沈める。
     * バラストは路盤の上に載っているのではなく、掘り下げたところに入っている。
     * 地形の標高が格子の補間で数十センチずれても、上面が地表に出る。
     */
    out.push({
      kind: 'extrusion',
      id: `${rail.id}#bed${i}`,
      path: withHeight.map((p) => ({ ...p, alt: (p.alt ?? 0) - BALLAST_EMBED_M })),
      section: [
        { x: -2.2, y: 0 },
        { x: 2.2, y: 0 },
        { x: 1.5, y: BALLAST_EMBED_M + 0.4 },
        { x: -1.5, y: BALLAST_EMBED_M + 0.4 },
      ],
      color: '#6e6a63',
    } as SceneShape);

    /**
     * 枕木。
     *
     * 出典: 鉄道の軌道構造（PC まくらぎ 2.0m × 0.24m × 0.2m、
     * 本数は在来線の 1 級線で 1km あたり 1,850 本 ＝ 間隔 0.54m）。
     * 近くで見ると、これが無いだけで「レールが浮いた棒」に見える。
     *
     * 数が多いので、近いときだけ描く。
     * 東京駅周辺 1km 四方の地表の線路は総延長およそ 7km あり、
     * 0.54m 間隔だと 13,000 本になる。
     */
    if (detail.sleeperStep > 0 && tracks <= MAX_TRACKS_WITH_SLEEPERS) {
      out.push(
        ...sleeperShapes(
          rail,
          centre,
          levels,
          i,
          detail.sleeperStep,
          Math.floor(MAX_SLEEPERS_PER_WAY / tracks),
        ),
      );
    }

    // レール 2 本。レール頭部は道床の上面から 0.15m
    for (const side of [-gauge / 2, gauge / 2]) {
      out.push({
        kind: 'extrusion',
        id: `${rail.id}#rail${i}${side > 0 ? 'R' : 'L'}`,
        path: offsetPath(centre, side).map((p, k) => ({ ...p, alt: bedHeight(k) + 0.4 })),
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

  /**
   * 架線柱。
   *
   * **OSM に `electrified` が入っているときだけ立てる。**
   * 非電化の路線に架線柱を立てるのは、実在しない構造物を作ることになる。
   *
   * 出典: 電車線路設備の標準（き電線を支持する柱の間隔は直線区間で
   * 50m 前後、曲線では短くなる。高さは架線 5.0m + がいし・腕金で 6.5m 前後）。
   */
  if (rail.electrified && detail.catenaryStep > 0) {
    out.push(...catenaryShapes(rail, levels, span, detail.catenaryStep));
  }

  return out;
}

/** 方位 headingDeg に対して直角へ offsetM だけ寄せた地点（正が右） */
function railSideOffset(point: LatLng, offsetM: number, headingDeg: number): LatLng {
  const rad = ((headingDeg + 90) * Math.PI) / 180;
  const cos = Math.cos((point.lat * Math.PI) / 180) || 1;
  return {
    lat: point.lat + (Math.cos(rad) * offsetM) / 111_320,
    lng: point.lng + (Math.sin(rad) * offsetM) / (111_320 * cos),
  };
}

/**
 * 軌間 (m)。
 *
 * 出典: 鉄道に関する技術上の基準を定める省令。
 *   在来線・地下鉄の多く … 1,067mm（狭軌）
 *   新幹線・一部の私鉄   … 1,435mm（標準軌）
 *
 * OSM に `gauge` が入っていればそちらが正だが、
 * ここでは種別からの一般値にとどめる（`gauge` の整備率が低いため）。
 * モノレールは軌条式ではないので、軌道桁の幅として扱う。
 */
function railGaugeOf(rail: RailPiece): number {
  if (rail.highspeed) return 1.435;
  if (rail.kind === 'monorail') return 0.85;
  return 1.067;
}

/** 枕木。等間隔に並べる */
function sleeperShapes(
  rail: RailPiece,
  centre: LatLng[],
  levels: number[],
  track: number,
  stepM: number,
  maxCount: number,
): SceneShape[] {
  const out: SceneShape[] = [];
  // 累積距離を作り、等間隔で刻む
  const cumulative = [0];
  for (let i = 1; i < centre.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMeters(centre[i - 1], centre[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return out;

  // 1 本の way が長いと枕木だけで数千個になる。上限を掛ける
  const count = Math.min(maxCount, Math.floor(total / stepM));
  for (let n = 0; n <= count; n += 1) {
    const d = n * stepM;
    if (d > total) break;
    // その距離にある区間を探す
    let seg = 1;
    while (seg < cumulative.length - 1 && cumulative[seg] < d) seg += 1;
    const span = cumulative[seg] - cumulative[seg - 1];
    const t = span > 0 ? (d - cumulative[seg - 1]) / span : 0;
    const a = centre[seg - 1];
    const b = centre[seg];
    const position = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    };
    const alt = levels[seg - 1] + (levels[seg] - levels[seg - 1]) * t;

    out.push({
      kind: 'box',
      id: `${rail.id}#tie${track}-${n}`,
      centre: { ...position, alt: alt + 0.3 },
      // PC まくらぎ 2.0m × 0.24m × 0.2m。中心は道床の上面から半分の高さ
      size: { x: 0.24, y: 2.0, z: 0.2 },
      headingDeg: bearingDegrees(a, b),
      color: '#7a746c',
      castsShadow: false,
    } as SceneShape);
  }
  return out;
}

/**
 * 架線柱。
 *
 * 線路の脇に、直線区間の標準間隔で立てる。
 * 本数が多いので、遠いときは間引く（間引きは 2 の冪で行う）。
 */
function catenaryShapes(
  rail: RailPiece,
  levels: number[],
  trackSpan: number,
  stepM: number,
): SceneShape[] {
  const out: SceneShape[] = [];
  const path = rail.path;
  const cumulative = [0];
  for (let i = 1; i < path.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distanceMeters(path[i - 1], path[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) return out;

  // 柱は線路群の外側に立てる。軌道中心から半分 + 建築限界の余裕 1.9m
  const sideOffset = trackSpan / 2 + 1.9;
  const count = Math.min(MAX_CATENARY_PER_WAY, Math.floor(total / stepM));

  for (let n = 0; n <= count; n += 1) {
    const d = n * stepM;
    if (d > total) break;
    let seg = 1;
    while (seg < cumulative.length - 1 && cumulative[seg] < d) seg += 1;
    const span = cumulative[seg] - cumulative[seg - 1];
    const t = span > 0 ? (d - cumulative[seg - 1]) / span : 0;
    const a = path[seg - 1];
    const b = path[seg];
    const on = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const alt = levels[seg - 1] + (levels[seg] - levels[seg - 1]) * t;
    const heading = bearingDegrees(a, b);
    // 進行方向に対して左右交互に立てる（実物も片側に寄せることが多い）
    const side = n % 2 === 0 ? sideOffset : -sideOffset;
    const base = railSideOffset(on, side, heading);

    out.push({
      kind: 'revolved',
      id: `${rail.id}#pole${n}`,
      base: { ...base, alt },
      height: CATENARY_HEIGHT_M,
      // H 鋼の柱。根元 0.13m / 頂部 0.10m の円柱として近似する
      bottomRadius: 0.13,
      topRadius: 0.1,
      color: '#5e6165',
    } as SceneShape);
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
