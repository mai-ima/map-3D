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

import type { BBox, ElevatedStructure, StructureKind } from '@ijm/shared';
import { fetchOsmMap } from './osm-api';
import { runOverpassQuery, type OverpassElement } from './overpass';

/** 種別ごとの標準的な寸法 */
const PROFILE: Record<
  StructureKind,
  { width: number; deckThickness: number; clearance: number; pierSpacing: number }
> = {
  // 新幹線・在来線の高架橋。桁が厚く、橋脚は 20〜25m 間隔が一般的
  'rail-elevated': { width: 11, deckThickness: 2.2, clearance: 8, pierSpacing: 22 },
  'rail-bridge': { width: 11, deckThickness: 1.8, clearance: 6, pierSpacing: 28 },
  // 都市高速のような高架道路
  'road-elevated': { width: 9, deckThickness: 1.6, clearance: 7, pierSpacing: 26 },
  // 河川や道路をまたぐ一般的な橋
  'road-bridge': { width: 9, deckThickness: 1.2, clearance: 3, pierSpacing: 30 },
  footbridge: { width: 3.5, deckThickness: 0.8, clearance: 5, pierSpacing: 20 },
};

/** 1 車線あたりの幅 (m)。日本の一般道の標準 */
const LANE_WIDTH = 3.25;

function parseIntTag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function classify(tags: Record<string, string>): StructureKind | null {
  const isBridge = tags.bridge !== undefined && tags.bridge !== 'no';
  const layer = parseIntTag(tags.layer) ?? 0;
  const elevated = layer > 0;
  if (!isBridge && !elevated) return null;

  if (tags.railway) {
    // 側線や引込線は景観への寄与が小さいので除く
    if (!['rail', 'light_rail', 'subway', 'tram', 'monorail'].includes(tags.railway)) return null;
    return elevated && !isBridge ? 'rail-elevated' : 'rail-bridge';
  }

  const hw = tags.highway;
  if (!hw) return null;
  if (['footway', 'path', 'pedestrian', 'steps', 'cycleway'].includes(hw)) return 'footbridge';
  if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(hw)) {
    return elevated && !isBridge ? 'road-elevated' : 'road-bridge';
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
  const kind = classify(tags);
  if (!kind) return null;

  const geometry = el.geometry ?? [];
  // 2 点未満では線にならない
  if (geometry.length < 2) return null;

  const profile = PROFILE[kind];
  const layer = parseIntTag(tags.layer) ?? (tags.bridge && tags.bridge !== 'no' ? 1 : 0);

  return {
    id: `osm:way${el.id}`,
    kind,
    name: tags.name,
    path: geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
    width: widthOf(kind, tags),
    layer,
    deckThickness: profile.deckThickness,
    // layer が 2 以上の場合は更に上を通っているので、その分持ち上げる
    clearance: profile.clearance + Math.max(0, layer - 1) * 5,
    pierSpacing: kind === 'road-bridge' && layer <= 1 ? 0 : profile.pierSpacing,
    lanes: parseIntTag(tags.lanes),
    tracks: parseIntTag(tags.tracks),
  };
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
    if (s) list.push(s);
  }
  return list;
}
