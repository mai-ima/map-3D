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
    clearance: number;
    pierSpacing: number;
    pierSize: number;
    parapetHeight: number;
  }
> = {
  // 高架鉄道。ラーメン高架橋。短い径間の柱が連続するのが最大の特徴
  'rail-elevated': {
    form: 'rigid-frame',
    width: 11,
    deckThickness: 0.35,
    girderDepth: 1.0, // 径間 8.9m の約 1/9
    clearance: 8,
    pierSpacing: 8.9,
    pierSize: 0.9,
    parapetHeight: 2.0, // 防音壁
  },
  // 鉄道橋。川や道路をまたぐ区間は桁橋になり、支間が長く柱の数が減る
  'rail-bridge': {
    form: 'girder',
    width: 11,
    deckThickness: 0.35,
    girderDepth: 1.8,
    clearance: 6,
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
    clearance: 7,
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
    clearance: 3,
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
    clearance: 5,
    pierSpacing: 18,
    pierSize: 0.5,
    parapetHeight: 1.2,
  },
};

/** 1 車線あたりの幅 (m)。日本の一般道の標準 */
const LANE_WIDTH = 3.25;

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

function parseIntTag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 種別を判定する。
 *
 * lengthM を渡すと、長く続く構造を「橋」ではなく「高架」として扱う。
 * OSM の bridge タグだけでは市街地の高架と川をまたぐ橋を区別できない。
 */
export function classify(tags: Record<string, string>, lengthM = 0): StructureKind | null {
  const isBridge = tags.bridge !== undefined && tags.bridge !== 'no';
  const layer = parseIntTag(tags.layer) ?? 0;
  const elevated = layer > 0;
  if (!isBridge && !elevated) return null;

  // 長く続くもの、または viaduct と明記されたものは高架
  const isViaduct = tags.bridge === 'viaduct' || lengthM >= VIADUCT_MIN_LENGTH_M;

  if (tags.railway) {
    // 側線や引込線は景観への寄与が小さいので除く
    if (!['rail', 'light_rail', 'subway', 'tram', 'monorail'].includes(tags.railway)) return null;
    return isViaduct || (elevated && !isBridge) ? 'rail-elevated' : 'rail-bridge';
  }

  const hw = tags.highway;
  if (!hw) return null;
  if (['footway', 'path', 'pedestrian', 'steps', 'cycleway'].includes(hw)) return 'footbridge';
  if (isViaduct || (elevated && !isBridge)) {
    return ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'secondary'].includes(hw)
      ? 'road-elevated'
      : 'road-bridge';
  }
  return 'road-bridge';
}

export function widthOf(kind: StructureKind, tags: Record<string, string>): number {
  const explicit = Number.parseFloat(tags.width ?? '');
  if (Number.isFinite(explicit) && explicit > 1) return explicit;

  const base = PROFILE[kind].width;
  if (kind === 'rail-elevated' || kind === 'rail-bridge') {
    const tracks = parseIntTag(tags.tracks);
    // 単線 5m、複線で 11m 程度
    if (tracks) return Math.max(5, 5 + (tracks - 1) * 4.5);
    return base;
  }

  const lanes = parseIntTag(tags.lanes);
  if (lanes) return Math.max(4, lanes * LANE_WIDTH + 1.5);
  return base;
}

export function toStructure(el: OverpassElement): ElevatedStructure | null {
  const tags = el.tags ?? {};
  const geometry = el.geometry ?? [];
  // 2 点未満では線にならない
  if (geometry.length < 2) return null;

  // 長さは形式の判定に要る。市街地を貫く高架は 1km を超える 1 本の way になっている
  const kind = classify(tags, pathLength(geometry));
  if (!kind) return null;

  const profile = PROFILE[kind];
  const layer = parseIntTag(tags.layer) ?? (tags.bridge && tags.bridge !== 'no' ? 1 : 0);
  const width = widthOf(kind, tags);

  // layer が 2 以上なら他の構造物の上を通っているので、その分持ち上げる
  const clearance = profile.clearance + Math.max(0, layer - 1) * 5;

  // 高さ 10m を超えるラーメン高架橋は柱の中間につなぎ梁が入る。
  // 柱が細長く見えないよう、高いものは柱を太くする
  const pierSize = clearance > 10 ? profile.pierSize * 1.25 : profile.pierSize;

  return {
    id: `osm:way${el.id}`,
    kind,
    form: profile.form,
    name: tags.name,
    path: geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
    width,
    layer,
    deckThickness: profile.deckThickness,
    girderDepth: profile.girderDepth,
    clearance,
    // 短い跨線橋に柱を並べると実物と違う見た目になる
    pierSpacing: kind === 'road-bridge' && layer <= 1 ? 0 : profile.pierSpacing,
    pierSize,
    parapetHeight: profile.parapetHeight,
    lanes: parseIntTag(tags.lanes),
    tracks: parseIntTag(tags.tracks),
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

  const query = `
    [out:json][timeout:60];
    (
      way["bridge"]["bridge"!="no"]["highway"](${b});
      way["bridge"]["bridge"!="no"]["railway"](${b});
      way["layer"]["highway"](${b});
      way["layer"]["railway"](${b});
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

  const list: ElevatedStructure[] = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const s = toStructure(el);
    if (!s) continue;
    const runs = clipPathToBBox(s.path, bbox);
    if (runs.length === 1) {
      list.push({ ...s, path: runs[0] });
      continue;
    }
    // 範囲を出入りする経路は区間ごとに分ける。ID が重ならないよう連番を付ける
    runs.forEach((path, i) => list.push({ ...s, id: `${s.id}#${i}`, path }));
  }
  return list;
}
