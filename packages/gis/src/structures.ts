/**
 * 高架・橋梁などの立体構造物を OpenStreetMap から取得する。
 *
 * PLATEAU の橋梁モデル（brid）は整備されている自治体が限られており、
 * 浜松市には存在しない。一方 OSM には橋（bridge）と高架（layer > 0）が
 * 形状付きで入っているので、そこから立体を組み立てる。
 *
 * 浜松駅周辺 1.2km 四方の実測（2026-08）:
 *   鉄道の橋 50 / 鉄道の高架 46 / 道路の橋 26 / 道路の高架 23
 * 東海道新幹線と東海道本線が高架で通っており、街の見た目を大きく左右する。
 *
 * 高さについて:
 *   OSM には桁下高や構造の寸法が入っていない。そのため layer と種別から
 *   一般的な寸法を当てている。「実在する構造物の位置と形」は OSM の実データ、
 *   「桁の厚みや橋脚の間隔」は標準的な値、という切り分けにしている。
 */

import type { BBox, ElevatedStructure, LatLng, StructureForm, StructureKind } from '@ijm/shared';
import { fetchOsmMap } from './osm-api';
import { runOverpassQuery, type OverpassElement } from './overpass';
import { consolidateStructures } from './structure-merge';

/**
 * 種別ごとの標準的な寸法。
 *
 * OSM には構造の寸法が入っていないため、実際の設計基準から値を取っている。
 *
 * 鉄道のラーメン高架橋（都市部の鉄道高架はほぼこの形式）:
 *   径間        8.6〜8.9m。山陽新幹線の 4 径間背割式ラーメン高架橋の実寸
 *   梁下高      8.0〜8.5m
 *   縦梁の高さ  径間の 1/8〜1/9（2 線 2 柱式・列車荷重 EA-17）
 *   1 層で組むのは高さ 10m まで。それ以上は柱の中間につなぎ梁が入る
 *   出典: 山陽新幹線ラーメン高架橋の施工（コンクリート工学 8(10)）ほか
 *
 * 道路橋（桁橋）:
 *   桁高は支間長のおよそ 1/16〜1/20。支間は 25〜40m 程度が一般的
 *   出典: 各地方整備局の橋梁設計要領
 */
const PROFILE: Record<
  StructureKind,
  {
    form: StructureForm;
    width: number;
    deckThickness: number;
    girderDepth: number;
    deckHeight: number;
    pierSpacing: number;
    pierSize: number;
    parapetHeight: number;
  }
> = {
  // 高架鉄道。ラーメン高架橋。短い径間の柱が連続するのが最大の特徴。
  // 路面 9.4m − 版 0.35 − 梁 1.0 = 梁下 8.05m（実測の 8.0〜8.5m に入る）
  'rail-elevated': {
    form: 'rigid-frame',
    width: 4.4, // way 1 本 = 線路 1 本。まとめるときに実幅を計算する
    deckThickness: 0.35,
    girderDepth: 1.0, // 径間 8.9m の約 1/9
    deckHeight: 9.4,
    pierSpacing: 8.9,
    pierSize: 0.9,
    parapetHeight: 2.0, // 防音壁
  },
  // 鉄道橋。川や道路をまたぐ区間は桁橋になり、支間が長く柱の数が減る。
  // 軌道面の高さは高架区間と同じにする（同じ線路がつながっているため）
  'rail-bridge': {
    form: 'girder',
    width: 4.4,
    deckThickness: 0.35,
    girderDepth: 1.8,
    deckHeight: 9.4,
    pierSpacing: 30,
    pierSize: 1.6,
    parapetHeight: 1.6,
  },
  // 高架道路。都市高速など
  'road-elevated': {
    form: 'girder',
    width: 9,
    deckThickness: 0.28,
    girderDepth: 1.6,
    deckHeight: 8.9,
    pierSpacing: 32,
    pierSize: 1.8,
    parapetHeight: 1.1,
  },
  // 一般的な道路橋
  'road-bridge': {
    form: 'girder',
    width: 9,
    deckThickness: 0.25,
    girderDepth: 1.4,
    deckHeight: 4.65,
    pierSpacing: 30,
    pierSize: 1.5,
    parapetHeight: 1.0,
  },
  // 歩道橋・ペデストリアンデッキ。桁を持たない薄い床版が多い
  footbridge: {
    form: 'slab',
    width: 3.5,
    deckThickness: 0.45,
    girderDepth: 0,
    deckHeight: 5.45,
    pierSpacing: 18,
    pierSize: 0.5,
    parapetHeight: 1.2,
  },
};

/** 線路 1 本あたりの軌道中心間隔 (m)。在来線 3.8〜4.0 / 新幹線 4.3 */
const TRACK_SPACING = 4.1;
/** 軌道の中心から床版の縁までの余裕 (m) */
const TRACK_MARGIN = 2.2;

/** 1 車線あたりの幅 (m)。日本の一般道の標準 */
const LANE_WIDTH = 3.25;

/**
 * 道路種別ごとの標準的な幅員 (m)。lanes が入っていないときに使う。
 *
 * 一律 9m にしていたため、幅 6m の生活道路に架かる橋まで 9m の床版になり、
 * 橋だけが道路より太く見えていた。
 */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 10.5,
  motorway_link: 7,
  trunk: 10,
  trunk_link: 7,
  primary: 9.5,
  primary_link: 6.5,
  secondary: 8.5,
  secondary_link: 6,
  tertiary: 7.5,
  unclassified: 6,
  residential: 6,
  living_street: 4.5,
  service: 4.5,
  track: 3.5,
};

/**
 * 路面の地上高 (m)。
 *
 * 浜松の実測（2026-08）で分かったこと:
 *   道路橋 57 本の長さは中央値 10m・最大 68m で、その大半が
 *   馬込川などを渡る「川の橋」だった（八幡橋・諏訪橋など）。
 *   OSM ではこれらにも layer=1 が付く。水路が layer 0 だからで、
 *   「道路の上をまたいでいる」という意味ではない。
 *   layer だけで高さを決めると、川の橋が 4.65m 浮いて道路から離れる。
 *
 * そこで「何をまたいでいるか」で決める。水路をまたぐ橋は路面が
 * 前後の道路と続いており、地上高はほとんど無い。
 */
const DECK_HEIGHT = {
  /** 水路をまたぐ橋。前後の道路と同じ高さで渡る */
  overWater: { road: 1.2, foot: 1.6, rail: 1.8 },
  /** 道路や線路をまたぐ橋。建築限界を確保する */
  overTraffic: { road: 5.6, foot: 5.6, rail: 6.5 },
  /** layer が 1 増えるごとに積み増す高さ */
  perLayer: 5,
} as const;

/**
 * 桁を持たない板橋として組む長さの上限 (m)。
 *
 * 支間 30m ほどまでは床版橋・中空床版橋が使われる。
 * 短い橋に箱桁と橋脚を付けると、実物と違ううえに描画も重くなる。
 */
const SLAB_BRIDGE_MAX_M = { road: 30, foot: 40 } as const;

/**
 * ラーメン高架橋とみなす最小の長さ (m)。
 *
 * OSM では市街地を貫く鉄道高架も bridge=yes で入っている。
 * 浜松の実測（2026-08）では、東海道本線が 1,776m / 1,612m / 987m、
 * 東海道新幹線が 1,374m / 1,197m / 1,066m という 1 本の way になっていて、
 * これを桁橋として支間 30m で組むと柱がまばらになり、実物と似ても似つかない。
 *
 * 一方、川や道路をまたぐ本物の桁橋はこれよりずっと短い。
 * 長さで切り分けると、市街地の高架をラーメン高架橋として組める。
 * bridge=viaduct が付いていれば長さによらず高架として扱う。
 */
const VIADUCT_MIN_LENGTH_M = 250;

/** 経路の長さ (m) */
function pathLength(points: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const cos = Math.cos((a.lat * Math.PI) / 180);
    total += Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * cos);
  }
  return total;
}

/**
 * 実データとして受け入れる上限。
 *
 * OSM のタグは自由入力で、入力ミスや荒らしで極端な値が入ることがある。
 * 上限を掛けないと、layer=1000 の高架が 5km 浮いたり、
 * tracks=1000000000 の床版が地球を一周する幅になったりする。
 *
 *   層     … OSM の慣習では -5〜5 程度。立体交差でも 4 層あれば足りる
 *   線路数 … 世界最大級の駅でも 30 本程度（東京駅は 20 面 20 線）
 *   車線数 … 最多はカナダのハイウェイ 401 で往復 18 車線
 *   幅     … 道路の幅は最大でも 100m 程度
 */
const MAX_LAYER = 6;
const MAX_TRACKS = 40;
const MAX_LANES = 24;
const MAX_WIDTH_M = 100;

function parseIntTag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 値を上限と下限に収める。読めない値は下限にする */
function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** layer タグを、扱える範囲に収めて読む */
function layerOf(tags: Record<string, string>): number {
  return clampValue(parseIntTag(tags.layer) ?? 0, -MAX_LAYER, MAX_LAYER);
}

/**
 * 種別を判定する。
 *
 * lengthM を渡すと、長く続く構造を「橋」ではなく「高架」として扱う。
 * OSM の bridge タグだけでは市街地の高架と川をまたぐ橋を区別できない。
 *
 * **`layer > 0` は「地面から浮いている」ことの根拠にならない。**
 * OSM の layer は交差する相手との相対的な重なり順を表すもので、
 * 地上の線路が道路と交差するところや、建物の中を通る通路にも付く。
 * 浮いていることを示すのは bridge タグのほう。
 *
 * layer だけで判定していたときの実測（2026-09、東京駅周辺 4km 四方）:
 *   トンネル・屋内の通路を高架にしていた      92 本
 *   駅構内の階段や通路を歩道橋にしていた     162 本（9m の階段など）
 *   線路の交差部だけを高架にしていた          40 本（最短 8m）
 */
export function classify(tags: Record<string, string>, lengthM = 0): StructureKind | null {
  // トンネル・屋内は地面より下か建物の中。高架ではない。
  // tunnel=building_passage（建物を貫く通路）もここで落ちる。
  // covered は落とさない。覆いのある高架（東北新幹線など）があるため
  if (tags.tunnel !== undefined && tags.tunnel !== 'no') return null;
  if (tags.indoor === 'yes') return null;

  const isBridge = tags.bridge !== undefined && tags.bridge !== 'no';
  const layer = layerOf(tags);

  // 長く続くもの、または viaduct と明記されたものは高架
  const isViaduct = tags.bridge === 'viaduct' || lengthM >= VIADUCT_MIN_LENGTH_M;

  // bridge が無いものを建てるのは、市街地を貫く高架のように
  // 長く続いていて、かつ上の層にあると明記されているときだけ。
  // OSM ではそうした高架に bridge が付いていないことがある
  if (!isBridge && !(layer > 0 && isViaduct)) return null;

  if (tags.railway) {
    // 側線や引込線は景観への寄与が小さいので除く。
    // ホーム（platform）や停車場の構内線もここで落ちる
    if (!['rail', 'light_rail', 'subway', 'tram', 'monorail'].includes(tags.railway)) return null;
    return isViaduct ? 'rail-elevated' : 'rail-bridge';
  }

  const hw = tags.highway;
  if (!hw) return null;
  if (['footway', 'path', 'pedestrian', 'steps', 'cycleway'].includes(hw)) {
    // 歩道橋やペデストリアンデッキには bridge が付く。
    // bridge が無いまま上の層にある歩行者用の道は、駅の構内通路や
    // ビルの中の通路であることがほとんどで、独立した構造物ではない。
    // 実測（東京駅周辺 4km 四方）では、400m 前後の footway が 17 本あり、
    // 名前を見ると「JR秋葉原駅;3階;5番線」のようにホーム上の通路だった
    return isBridge ? 'footbridge' : null;
  }
  // 高架道路として扱うのは都市高速など自動車専用道路だけにする。
  // 一般道は長い橋でも路面の高さが桁橋と変わらないので、
  // ここを広げると普通の橋との接続部が段差になる
  if (isViaduct && ['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(hw)) {
    return 'road-elevated';
  }
  return 'road-bridge';
}

/**
 * 橋の造りを決める文脈。
 *
 * どれも OSM から読み取れる事実で、こちらで創作しているものはない。
 */
export interface StructureContext {
  /** 経路の長さ (m) */
  lengthM: number;
  /** 川・水路をまたいでいるか（水路の線と交差するかで判定） */
  overWater: boolean;
}

/** 路面の地上高を決める */
export function deckHeightOf(
  kind: StructureKind,
  layer: number,
  context: StructureContext,
): number {
  // 高架は橋とは別。市街地を貫く構造なので、またぐものによらず高い
  if (kind === 'rail-elevated') return PROFILE[kind].deckHeight + Math.max(0, layer - 1) * DECK_HEIGHT.perLayer;
  if (kind === 'road-elevated') return PROFILE[kind].deckHeight + Math.max(0, layer - 1) * DECK_HEIGHT.perLayer;

  const family = kind === 'footbridge' ? 'foot' : kind === 'rail-bridge' ? 'rail' : 'road';
  // 水路をまたぐ橋は、前後の道路と同じ高さで渡る
  if (context.overWater) {
    return DECK_HEIGHT.overWater[family] + Math.max(0, layer - 1) * DECK_HEIGHT.perLayer;
  }
  // 道路や線路をまたぐ橋。layer が無いなら渡っている相手も分からないので、
  // 平面交差に近いものとして低く置く
  if (layer <= 0) return DECK_HEIGHT.overWater[family];
  return DECK_HEIGHT.overTraffic[family] + (layer - 1) * DECK_HEIGHT.perLayer;
}

/**
 * 構造形式を決める。
 *
 * 短い橋は床版橋（桁を持たない板）。実物がそうであるうえに、
 * 箱桁と橋脚を作らないぶん描画も軽くなる。
 */
export function formOf(kind: StructureKind, context: StructureContext): StructureForm {
  // 市街地を貫く鉄道高架はラーメン高架橋、都市高速は桁橋。
  // どちらも長い構造なので、長さでは切り替えない
  if (kind === 'rail-elevated') return 'rigid-frame';
  if (kind === 'road-elevated') return 'girder';
  // 歩道橋は桁を持たない薄い床版
  if (kind === 'footbridge') return 'slab';
  // 道路橋・鉄道橋は支間が短ければ床版橋
  return context.lengthM <= SLAB_BRIDGE_MAX_M.road ? 'slab' : 'girder';
}

/** 2 つの線分が交差するか（水路をまたいでいるかの判定に使う） */
function segmentsCross(
  a1: LatLng,
  a2: LatLng,
  b1: LatLng,
  b2: LatLng,
): boolean {
  const cross = (o: LatLng, p: LatLng, q: LatLng): number =>
    (p.lng - o.lng) * (q.lat - o.lat) - (p.lat - o.lat) * (q.lng - o.lng);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 経路を囲む矩形 [minLng, minLat, maxLng, maxLat] */
function boundsOf(path: LatLng[]): BBox {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const p of path) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function boundsOverlap(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/** 水路の矩形は橋の本数ぶん繰り返し要るので、一度だけ求めて覚えておく */
const boundsCache = new WeakMap<LatLng[], BBox>();
function cachedBounds(path: LatLng[]): BBox {
  const hit = boundsCache.get(path);
  if (hit) return hit;
  const bounds = boundsOf(path);
  boundsCache.set(path, bounds);
  return bounds;
}

/**
 * 水路をまたいでいるか。
 *
 * 「川の橋」と「道路をまたぐ跨道橋」は、OSM のタグだけでは区別できない
 * （どちらも bridge=yes + layer=1 になる）。実際に水路の線と交差するかで見る。
 *
 * 総当たりだと橋 153 本 × 水路の線分すべてで 154ms かかっていた。
 * 先に矩形が重なるかだけを見て、ほとんどの組み合わせを弾く。
 */
export function crossesWaterway(path: LatLng[], waterways: LatLng[][]): boolean {
  if (path.length < 2) return false;
  const bounds = boundsOf(path);

  for (const water of waterways) {
    if (water.length < 2) continue;
    if (!boundsOverlap(bounds, cachedBounds(water))) continue;
    for (let i = 1; i < path.length; i += 1) {
      for (let j = 1; j < water.length; j += 1) {
        if (segmentsCross(path[i - 1], path[i], water[j - 1], water[j])) return true;
      }
    }
  }
  return false;
}

export function widthOf(kind: StructureKind, tags: Record<string, string>): number {
  const explicit = Number.parseFloat(tags.width ?? '');
  if (Number.isFinite(explicit) && explicit > 1) return clampValue(explicit, 1, MAX_WIDTH_M);

  const base = PROFILE[kind].width;
  if (kind === 'rail-elevated' || kind === 'rail-bridge') {
    // OSM の way は原則 1 本が線路 1 本。tracks が入っていればその本数ぶん。
    // 複線が 2 本の way で表されている場合は、平行なものをまとめる段階で
    // 実際の幅を計算するので、ここでは way 1 本ぶんに留める
    const tracks = clampValue(parseIntTag(tags.tracks) ?? 1, 1, MAX_TRACKS);
    return TRACK_MARGIN * 2 + (tracks - 1) * TRACK_SPACING;
  }

  const lanes = parseIntTag(tags.lanes);
  if (lanes) return Math.max(4, clampValue(lanes, 1, MAX_LANES) * LANE_WIDTH + 1.5);
  // 道路種別ごとの標準幅員。一律だと生活道路の橋まで幹線道路の幅になる
  return ROAD_WIDTH[tags.highway ?? ''] ?? base;
}

export function toStructure(
  el: OverpassElement,
  waterways: LatLng[][] = [],
): ElevatedStructure | null {
  const tags = el.tags ?? {};
  const geometry = el.geometry ?? [];
  // 2 点未満では線にならない
  if (geometry.length < 2) return null;

  const path = geometry.map((p) => ({ lat: p.lat, lng: p.lon }));
  const lengthM = pathLength(geometry);
  // 長さは形式の判定に要る。市街地を貫く高架は 1km を超える 1 本の way になっている
  const kind = classify(tags, lengthM);
  if (!kind) return null;

  const context: StructureContext = {
    lengthM,
    overWater: crossesWaterway(path, waterways),
  };
  const profile = PROFILE[kind];
  const layer = layerOf(tags);
  const width = widthOf(kind, tags);
  const form = formOf(kind, context);
  const deckHeight = deckHeightOf(kind, layer, context);

  // 床版橋は桁を持たず、そのぶん版が厚い（中空床版橋で支間の 1/20 前後）
  const deckThickness =
    form === 'slab' && kind !== 'footbridge'
      ? Math.min(1.2, Math.max(0.45, lengthM / 22))
      : profile.deckThickness;
  const girderDepth = form === 'slab' ? 0 : profile.girderDepth;

  // 高さ 12m を超えるラーメン高架橋は柱の中間につなぎ梁が入る。
  // 柱が細長く見えないよう、高いものは柱を太くする
  const pierSize = deckHeight > 12 ? profile.pierSize * 1.25 : profile.pierSize;

  // 橋脚を立てるのは、支える相手が要るときだけ。
  // 短い橋は両岸の橋台で支えており、川の中に橋脚は立っていない
  const needsPiers =
    form === 'rigid-frame' ||
    (form === 'girder' && lengthM > profile.pierSpacing * 1.5) ||
    (kind === 'footbridge' && deckHeight > 3 && lengthM > profile.pierSpacing * 1.5);

  return {
    id: `osm:way${el.id}`,
    kind,
    form,
    name: tags.name,
    path,
    width,
    layer,
    deckThickness,
    girderDepth,
    deckHeight,
    pierSpacing: needsPiers ? profile.pierSpacing : 0,
    pierSize,
    parapetHeight: profile.parapetHeight,
    lanes: parseIntTag(tags.lanes),
    tracks: tags.tracks ? clampValue(parseIntTag(tags.tracks) ?? 1, 1, MAX_TRACKS) : undefined,
  };
}

/** 表示範囲の外へどれだけはみ出させるか (度)。約 250m */
const CLIP_MARGIN_DEG = 0.0023;

/**
 * 表示範囲の外まで伸びている部分を切り落とす。
 *
 * Overpass は way を丸ごと返すため、東海道本線のように 1,776m の 1 本が
 * そのまま入ってくる。見えない部分まで柱を並べると無駄が大きいので、
 * 範囲の外へ少しだけはみ出したところで切る。
 *
 * 形式（ラーメン高架橋か桁橋か）は元の全長で判定済みなので、
 * ここで切っても短い橋と取り違えることはない。
 *
 * 範囲を出入りする経路は複数の区間に分かれるため、配列で返す。
 */
export function clipPathToBBox(path: LatLng[], bbox: BBox): LatLng[][] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const inside = (p: LatLng) =>
    p.lng >= minLng - CLIP_MARGIN_DEG &&
    p.lng <= maxLng + CLIP_MARGIN_DEG &&
    p.lat >= minLat - CLIP_MARGIN_DEG &&
    p.lat <= maxLat + CLIP_MARGIN_DEG;

  const runs: LatLng[][] = [];
  let current: LatLng[] = [];

  for (let i = 0; i < path.length; i += 1) {
    if (inside(path[i])) {
      // 範囲に入る直前の点も残す。切り口が見えないところまで伸ばすため
      if (current.length === 0 && i > 0) current.push(path[i - 1]);
      current.push(path[i]);
      continue;
    }
    if (current.length > 0) {
      // 範囲を出た直後の点まで残してから区切る
      current.push(path[i]);
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  return runs.filter((r) => r.length >= 2);
}

/**
 * 範囲内の高架・橋梁を取得する。
 *
 * geom 付きで取得するので、そのまま 3D 化できる。
 * 取得できなかった場合は空配列を返す（構造物が出なくても地図は成立する）。
 */
export async function fetchElevatedStructures(bbox: BBox): Promise<ElevatedStructure[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const b = `${minLat},${minLng},${maxLat},${maxLng}`;

  // 水路も一緒に取る。「川を渡る橋」と「道路をまたぐ跨道橋」は
  // タグでは区別できず、実際に交差するかどうかでしか分からない。
  // これが分からないと川の橋まで 5m 持ち上がり、道路から浮いてしまう
  const query = `
    [out:json][timeout:60];
    (
      way["bridge"]["bridge"!="no"]["highway"](${b});
      way["bridge"]["bridge"!="no"]["railway"](${b});
      way["layer"]["highway"](${b});
      way["layer"]["railway"](${b});
      way["waterway"~"^(river|stream|canal|drain|ditch)$"](${b});
    );
    out geom;
  `;

  // Overpass が落ちていても構造物は出したいので、OSM 本体の API に切り替える
  let elements: OverpassElement[] = [];
  try {
    elements = (await runOverpassQuery(query)).elements;
  } catch {
    try {
      elements = await fetchOsmMap(bbox);
    } catch {
      return [];
    }
  }

  const waterways: LatLng[][] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.waterway) continue;
    const geometry = el.geometry ?? [];
    if (geometry.length >= 2) waterways.push(geometry.map((p) => ({ lat: p.lat, lng: p.lon })));
  }

  const list: ElevatedStructure[] = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const s = toStructure(el, waterways);
    if (!s) continue;
    const runs = clipPathToBBox(s.path, bbox);
    if (runs.length === 1) {
      list.push({ ...s, path: runs[0] });
      continue;
    }
    // 範囲を出入りする経路は区間ごとに分ける。ID が重ならないよう連番を付ける
    runs.forEach((path, i) => list.push({ ...s, id: `${s.id}#${i}`, path }));
  }
  // OSM は線路を 1 本ずつ別の way にしているため、そのまま建てると
  // 複線の高架が 4m 間隔で積み上がる。実際の構造物の単位にまとめる
  return consolidateStructures(list);
}
