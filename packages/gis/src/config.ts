/**
 * GIS 系外部サービスの設定。すべて環境変数で差し替えられる。
 * サーバ側でのみ読み込まれる（ブラウザからは直接呼ばない）。
 */

import { envFirst, envNumber, envUrl, envUrlList } from '@ijm/shared';

export interface GisConfig {
  /** Overpass API のエンドポイント（複数指定でフェイルオーバ） */
  overpassEndpoints: string[];
  nominatimEndpoint: string;
  /** 公開インスタンス利用時に必要な連絡先付き User-Agent */
  userAgent: string;
  /** 外部リクエストのタイムアウト (ms) */
  timeoutMs: number;
}

const DEFAULT_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const DEFAULT_NOMINATIM = 'https://nominatim.openstreetmap.org';
export const DEFAULT_OSM_USER_AGENT =
  'immersive-japan-map/0.1 (+https://github.com/mai-ima/map-3d)';

/**
 * 空文字や相対 URL が入っていても既定値に落ちるよう、@ijm/shared の env ヘルパ経由で読む。
 * （ホスティング側で「変数名だけ登録され値が空」というケースを吸収する）
 */
export function getGisConfig(env: Record<string, string | undefined> = process.env): GisConfig {
  return {
    overpassEndpoints: envUrlList(
      envFirst(env.OVERPASS_ENDPOINTS, env.OVERPASS_URL),
      DEFAULT_OVERPASS,
    ),
    nominatimEndpoint: envUrl(env.NOMINATIM_URL, DEFAULT_NOMINATIM),
    userAgent: envFirst(env.OSM_USER_AGENT) ?? DEFAULT_OSM_USER_AGENT,
    timeoutMs: envNumber(env.GIS_TIMEOUT_MS, 20000),
  };
}

/** AbortSignal 付き fetch（タイムアウト制御） */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
