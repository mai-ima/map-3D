/**
 * Overpass API クライアント。
 *
 * 公開インスタンスは可用性・レート制限が読めないため、
 *  - 複数エンドポイントのフェイルオーバ
 *  - プロセス内 LRU キャッシュ
 *  - 失敗時は例外ではなく「空 + 警告」を返せる呼び出し口
 * を用意している（POI が取れなくても地図とナビは動き続ける、という方針）。
 */

import type { BBox, LatLng, Poi } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import { fetchWithTimeout, getGisConfig } from './config';
import { fetchOsmMap } from './osm-api';
import { CATEGORY_DEFINITIONS, categoryOfTags, findCategory } from './poi-categories';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// ---- 簡易 LRU キャッシュ ------------------------------------------------

const CACHE_MAX = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: OverpassResponse }>();

function cacheGet(key: string): OverpassResponse | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // LRU: 参照したら末尾へ
  cache.delete(key);
  cache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, data: OverpassResponse): void {
  cache.set(key, { at: Date.now(), data });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---- クエリ実行 ---------------------------------------------------------

export class OverpassUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassUnavailableError';
  }
}

export async function runOverpassQuery(query: string): Promise<OverpassResponse> {
  const cached = cacheGet(query);
  if (cached) return cached;

  const cfg = getGisConfig();
  const errors: string[] = [];

  for (const endpoint of cfg.overpassEndpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': cfg.userAgent,
        },
        body: `data=${encodeURIComponent(query)}`,
        timeoutMs: cfg.timeoutMs,
      });
      if (!res.ok) {
        errors.push(`${endpoint}: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as OverpassResponse;
      cacheSet(query, data);
      return data;
    } catch (e) {
      errors.push(`${endpoint}: ${(e as Error).message}`);
    }
  }

  throw new OverpassUnavailableError(
    `Overpass API に到達できませんでした（${errors.join(' / ')}）`,
  );
}

function elementCoord(el: OverpassElement): LatLng | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lng: el.lon };
  }
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  if (el.geometry && el.geometry.length > 0) {
    const g = el.geometry;
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length;
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length;
    return { lat, lng: lon };
  }
  return null;
}

// ---- POI 検索 -----------------------------------------------------------

export interface NearbySearchOptions {
  center: LatLng;
  radius: number;
  /** カテゴリ名（日本語別名も可）。未指定なら主要カテゴリすべて */
  categories?: string[];
  limit?: number;
}

export async function searchNearbyPois(options: NearbySearchOptions): Promise<Poi[]> {
  const { center, radius, limit = 30 } = options;
  const defs =
    options.categories && options.categories.length > 0
      ? options.categories
          .map((c) => findCategory(c))
          .filter((d): d is (typeof CATEGORY_DEFINITIONS)[number] => Boolean(d))
      : CATEGORY_DEFINITIONS.filter((d) =>
          ['convenience', 'cafe', 'restaurant', 'station', 'park'].includes(d.category),
        );

  if (defs.length === 0) return [];

  const around = `around:${Math.round(radius)},${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
  const clauses = defs
    .flatMap((d) => d.filters)
    .flatMap((f) => [`node${f}(${around});`, `way${f}(${around});`]);

  const query = `[out:json][timeout:25];(${clauses.join('')});out center ${limit * 2};`;

  // Overpass の公開インスタンスは混雑時に落ちる。全滅した場合は
  // OSM 本体の API から範囲内の要素を取り、こちら側で絞り込む。
  let elements: OverpassElement[];
  try {
    elements = (await runOverpassQuery(query)).elements;
  } catch (error) {
    elements = await fallbackNearbyFromOsmApi(center, radius, defs);
    if (elements.length === 0) throw error;
  }

  const pois: Poi[] = [];
  for (const el of elements) {
    const coord = elementCoord(el);
    if (!coord || !el.tags) continue;
    const name = el.tags.name || el.tags['name:ja'] || el.tags.brand || '';
    if (!name) continue;
    pois.push({
      id: `${el.type}/${el.id}`,
      name,
      category: categoryOfTags(el.tags),
      lat: coord.lat,
      lng: coord.lng,
      tags: el.tags,
      distance: Math.round(distanceMeters(center, coord)),
    });
  }

  pois.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  return pois.slice(0, limit);
}

/**
 * Overpass が使えないときに OSM 本体の API から POI を拾う。
 *
 * OSM API は絞り込みができず範囲内の全要素を返すため、
 * カテゴリ判定はこちら側で行う。転送量が大きいので半径は控えめに切る。
 */
async function fallbackNearbyFromOsmApi(
  center: LatLng,
  radius: number,
  defs: (typeof CATEGORY_DEFINITIONS)[number][],
): Promise<OverpassElement[]> {
  // 半径 700m 程度までに抑える（それ以上は転送量が跳ね上がる）
  const capped = Math.min(radius, 700);
  const dLat = capped / 111_320;
  const dLng = capped / (111_320 * Math.cos((center.lat * Math.PI) / 180) || 1);

  try {
    const all = await fetchOsmMap([
      center.lng - dLng,
      center.lat - dLat,
      center.lng + dLng,
      center.lat + dLat,
    ]);
    const wanted = new Set(defs.map((d) => d.category));
    return all.filter((el) => el.tags && wanted.has(categoryOfTags(el.tags)));
  } catch {
    return [];
  }
}

// ---- 建物情報 -----------------------------------------------------------

export async function fetchBuildingAt(point: LatLng, radius = 40): Promise<OverpassElement | null> {
  const around = `around:${radius},${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  const query = `[out:json][timeout:25];(way["building"](${around});relation["building"](${around}););out center tags 10;`;
  const res = await runOverpassQuery(query);
  if (res.elements.length === 0) return null;

  let best: OverpassElement | null = null;
  let bestDist = Infinity;
  for (const el of res.elements) {
    const c = elementCoord(el);
    if (!c) continue;
    const d = distanceMeters(point, c);
    if (d < bestDist) {
      bestDist = d;
      best = el;
    }
  }
  return best;
}

// ---- 道路ネットワーク ---------------------------------------------------

/**
 * 道路・歩道・横断歩道・信号などをまとめて取得する。
 * ナビゲーションの視覚表現（交差点ハイライト等）に使う。
 */
export async function fetchRoadNetwork(bbox: BBox): Promise<OverpassResponse> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const box = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `[out:json][timeout:30];
(
  way["highway"](${box});
  node["highway"="traffic_signals"](${box});
  node["highway"="crossing"](${box});
  node["highway"="stop"](${box});
);
out geom;`;
  return runOverpassQuery(query);
}

/**
 * 街路樹・街灯など、3D 装飾を「実在位置に」置くための点データ。
 * ※ 位置は必ず OSM の実データを使い、AI 生成で位置を捏造しない。
 */
export async function fetchStreetFurniture(bbox: BBox): Promise<OverpassElement[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const box = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `[out:json][timeout:30];
(
  node["natural"="tree"](${box});
  node["highway"="street_lamp"](${box});
  node["amenity"="bench"](${box});
);
out body 3000;`;
  const res = await runOverpassQuery(query);
  return res.elements;
}
