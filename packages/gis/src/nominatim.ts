/**
 * Nominatim（OSM ジオコーダ）クライアント。
 *
 * 公開インスタンスの利用規約:
 *  - 1 リクエスト/秒まで
 *  - 識別可能な User-Agent が必須
 *  - 結果には ODbL の帰属表示が必要
 * https://operations.osmfoundation.org/policies/nominatim/
 */

import type { SearchResult } from '@ijm/shared';
import { fetchWithTimeout, getGisConfig } from './config';

interface NominatimPlace {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
  boundingbox?: [string, string, string, string];
  address?: Record<string, string>;
}

/** 呼び出し間隔を 1 秒以上空けるための簡易スロットル（プロセス内） */
let lastCallAt = 0;
async function throttle(minIntervalMs = 1100): Promise<void> {
  const wait = lastCallAt + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function toSearchResult(p: NominatimPlace): SearchResult {
  return {
    id: `osm:${p.osm_type ?? 'n'}${p.osm_id ?? p.place_id}`,
    name: p.name || p.display_name.split(',')[0],
    address: p.display_name,
    lat: Number(p.lat),
    lng: Number(p.lon),
    category: p.type ?? p.category,
    bbox: p.boundingbox
      ? [
          Number(p.boundingbox[2]),
          Number(p.boundingbox[0]),
          Number(p.boundingbox[3]),
          Number(p.boundingbox[1]),
        ]
      : undefined,
    source: 'nominatim',
  };
}

export interface GeocodeOptions {
  limit?: number;
  /** 近傍を優先する中心 */
  near?: { lat: number; lng: number };
  /** 優先する範囲 (viewbox) */
  bbox?: [number, number, number, number];
  language?: string;
  countryCodes?: string;
}

export async function geocode(query: string, options: GeocodeOptions = {}): Promise<SearchResult[]> {
  const cfg = getGisConfig();
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(options.limit ?? 8),
    'accept-language': options.language ?? 'ja',
    addressdetails: '1',
    countrycodes: options.countryCodes ?? 'jp',
  });

  if (options.bbox) {
    params.set('viewbox', options.bbox.join(','));
    params.set('bounded', '0');
  } else if (options.near) {
    // 中心から約 ±0.15 度の範囲を優先
    const d = 0.15;
    params.set(
      'viewbox',
      [
        options.near.lng - d,
        options.near.lat + d,
        options.near.lng + d,
        options.near.lat - d,
      ].join(','),
    );
  }

  await throttle();
  const res = await fetchWithTimeout(`${cfg.nominatimEndpoint}/search?${params.toString()}`, {
    headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' },
    timeoutMs: cfg.timeoutMs,
  });
  if (!res.ok) {
    throw new Error(`Nominatim の検索に失敗しました (HTTP ${res.status})`);
  }
  const places = (await res.json()) as NominatimPlace[];
  return places.map(toSearchResult);
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  language = 'ja',
): Promise<SearchResult | null> {
  const cfg = getGisConfig();
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'jsonv2',
    'accept-language': language,
    addressdetails: '1',
    zoom: '18',
  });

  await throttle();
  const res = await fetchWithTimeout(`${cfg.nominatimEndpoint}/reverse?${params.toString()}`, {
    headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' },
    timeoutMs: cfg.timeoutMs,
  });
  if (!res.ok) return null;
  const place = (await res.json()) as NominatimPlace & { error?: string };
  if (!place || place.error || !place.lat) return null;
  return toSearchResult(place);
}
