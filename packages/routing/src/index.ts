/**
 * ルーティングプロバイダのファクトリ。
 * 環境変数だけで「公開デモサーバ」と「自前 Valhalla」を切り替えられる。
 */

import { envFirst, envNumber, envOptionalUrl, envUrl, type Route, type RouteRequest } from '@ijm/shared';
import { OsrmProvider } from './osrm';
import { RoutingError, type RouteProvider } from './types';
import { ValhallaProvider } from './valhalla';

export * from './types';
export * from './valhalla';
export * from './osrm';

export interface RoutingEnv {
  ROUTING_ENGINE?: string;
  VALHALLA_URL?: string;
  VALHALLA_CLIENT_ID?: string;
  OSRM_DRIVE_URL?: string;
  OSRM_WALK_URL?: string;
  OSRM_BIKE_URL?: string;
  ROUTING_TIMEOUT_MS?: string;
}

/** FOSSGIS の公開デモサーバ（利用ポリシー: 1req/user/sec, X-Client-Id 推奨） */
export const PUBLIC_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';

/** 空文字や相対 URL を弾いた OSRM エンドポイント（未設定なら undefined） */
export function resolveOsrmEndpoints(env: RoutingEnv): {
  drive?: string;
  walk?: string;
  bicycle?: string;
} {
  return {
    drive: envOptionalUrl(env.OSRM_DRIVE_URL),
    walk: envOptionalUrl(env.OSRM_WALK_URL),
    bicycle: envOptionalUrl(env.OSRM_BIKE_URL),
  };
}

export function createRouteProvider(env: RoutingEnv = process.env as RoutingEnv): RouteProvider {
  const engine = (envFirst(env.ROUTING_ENGINE) ?? 'valhalla').toLowerCase();
  const timeoutMs = envNumber(env.ROUTING_TIMEOUT_MS, 20000);

  if (engine === 'osrm') {
    return new OsrmProvider({ endpoints: resolveOsrmEndpoints(env), timeoutMs });
  }

  return new ValhallaProvider({
    // 空文字が入っていると相対 URL になり fetch が即失敗するため、必ず絶対 URL に正規化する
    baseUrl: envUrl(env.VALHALLA_URL, PUBLIC_VALHALLA_URL),
    clientId: envFirst(env.VALHALLA_CLIENT_ID) ?? 'immersive-japan-map',
    timeoutMs,
  });
}

/**
 * フォールバック付きルーティング。
 * 主エンジンが失敗し、かつ OSRM が設定されている場合のみ切り替える。
 */
export async function routeWithFallback(
  request: RouteRequest,
  env: RoutingEnv = process.env as RoutingEnv,
): Promise<Route> {
  const primary = createRouteProvider(env);
  try {
    return await primary.route(request);
  } catch (error) {
    const endpoints = resolveOsrmEndpoints(env);
    const hasOsrm = Boolean(endpoints.drive ?? endpoints.walk ?? endpoints.bicycle);
    if (!hasOsrm || primary.name === 'osrm') throw error;

    const fallback = new OsrmProvider({ endpoints });
    try {
      return await fallback.route(request);
    } catch {
      // フォールバックも失敗したら、元のエラーを返す（原因が分かりやすい）
      throw error instanceof RoutingError
        ? error
        : new RoutingError('経路探索に失敗しました', error);
    }
  }
}
