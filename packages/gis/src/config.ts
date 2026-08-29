/**
 * GIS 系外部サービスの設定。すべて環境変数で差し替えられる。
 * サーバ側でのみ読み込まれる（ブラウザからは直接呼ばない）。
 */

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

export function getGisConfig(env: Record<string, string | undefined> = process.env): GisConfig {
  const endpoints = (env.OVERPASS_ENDPOINTS ?? env.OVERPASS_URL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    overpassEndpoints: endpoints.length > 0 ? endpoints : DEFAULT_OVERPASS,
    nominatimEndpoint: env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent:
      env.OSM_USER_AGENT ??
      'immersive-japan-map/0.1 (+https://github.com/mai-ima/map-3d)',
    timeoutMs: Number(env.GIS_TIMEOUT_MS ?? 20000),
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
