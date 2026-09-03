/**
 * BFF (Next.js Route Handlers) への薄いクライアント。
 * 外部サービスへ直接アクセスするのはタイル配信だけで、それ以外は必ずここを通す。
 */

import type {
  ElevatedStructure,
  BuildingInfo,
  LatLng,
  Poi,
  PublicConfig,
  Route,
  SearchResult,
  TravelMode,
} from '@ijm/shared';
import type { RailPiece, RoadPiece, RoadPoint } from '@ijm/gis';
import type { AgentResult, ChatMessage, MapContext } from '@ijm/ai';

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? `リクエストに失敗しました (${res.status})`);
  }
  return json as T;
}

export function fetchConfig(): Promise<PublicConfig> {
  return getJson<PublicConfig>('/api/config');
}

export function searchPlaces(query: string, near?: LatLng): Promise<{ results: SearchResult[] }> {
  const params = new URLSearchParams({ q: query });
  if (near) params.set('near', `${near.lat},${near.lng}`);
  return getJson(`/api/search?${params.toString()}`);
}

/** 高架・橋梁の立体構造物（OSM 由来） */
export function fetchStructures(
  bbox: [number, number, number, number],
): Promise<{ structures: ElevatedStructure[]; degraded: boolean }> {
  return getJson(`/api/structures?bbox=${bbox.map((n) => n.toFixed(5)).join(',')}`);
}

/** 車道・車線・横断歩道・信号・線路（OSM 由来） */
export function fetchRoads(
  bbox: [number, number, number, number],
): Promise<{ roads: RoadPiece[]; rails: RailPiece[]; points: RoadPoint[]; degraded: boolean }> {
  return getJson(`/api/roads?bbox=${bbox.map((n) => n.toFixed(5)).join(',')}`);
}

export function fetchRoute(
  from: LatLng,
  to: LatLng,
  mode: TravelMode,
  /** 経由地。出発地から目的地へ向かう途中で、この順に必ず通る */
  via: LatLng[] = [],
): Promise<Route> {
  return getJson<Route>('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, mode, ...(via.length > 0 ? { via } : {}) }),
  });
}

export function fetchPois(
  center: LatLng,
  categories: string[],
  radius = 500,
): Promise<{ pois: Poi[]; degraded?: boolean; message?: string }> {
  const params = new URLSearchParams({
    lat: String(center.lat),
    lng: String(center.lng),
    radius: String(radius),
    categories: categories.join(','),
  });
  return getJson(`/api/poi?${params.toString()}`);
}

export function fetchBuilding(
  position: LatLng,
  attributes: Record<string, unknown>,
): Promise<{ building: BuildingInfo }> {
  return getJson('/api/building', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat: position.lat, lng: position.lng, attributes }),
  });
}

export function fetchStreetFurniture(bbox: [number, number, number, number]): Promise<{
  points: {
    lat: number;
    lng: number;
    kind: 'tree' | 'street_lamp' | 'bench';
    height?: number;
    /** 樹種・樹高・樹冠幅。形を決めるのに使う（OSM に入っているときだけ） */
    tags?: Record<string, string>;
  }[];
  degraded?: boolean;
}> {
  return getJson(`/api/furniture?bbox=${bbox.join(',')}`);
}

export function askAI(messages: ChatMessage[], mapContext: MapContext): Promise<AgentResult> {
  return getJson<AgentResult>('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, mapContext }),
  });
}
