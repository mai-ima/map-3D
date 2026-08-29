/**
 * ルーティングプロバイダのファクトリ。
 * 環境変数だけで「公開デモサーバ」と「自前 Valhalla」を切り替えられる。
 */

import type { Route, RouteRequest } from '@ijm/shared';
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

export function createRouteProvider(env: RoutingEnv = process.env as RoutingEnv): RouteProvider {
  const engine = (env.ROUTING_ENGINE ?? 'valhalla').toLowerCase();
  const timeoutMs = Number(env.ROUTING_TIMEOUT_MS ?? 20000);

  if (engine === 'osrm') {
    return new OsrmProvider({
      endpoints: {
        drive: env.OSRM_DRIVE_URL,
        walk: env.OSRM_WALK_URL,
        bicycle: env.OSRM_BIKE_URL,
      },
      timeoutMs,
    });
  }

  return new ValhallaProvider({
    baseUrl: env.VALHALLA_URL ?? PUBLIC_VALHALLA_URL,
    clientId: env.VALHALLA_CLIENT_ID ?? 'immersive-japan-map',
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
    const hasOsrm = Boolean(env.OSRM_DRIVE_URL ?? env.OSRM_WALK_URL ?? env.OSRM_BIKE_URL);
    if (!hasOsrm || primary.name === 'osrm') throw error;

    const fallback = new OsrmProvider({
      endpoints: {
        drive: env.OSRM_DRIVE_URL,
        walk: env.OSRM_WALK_URL,
        bicycle: env.OSRM_BIKE_URL,
      },
    });
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
