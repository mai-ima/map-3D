import type { Route, RouteRequest, TravelMode } from '@ijm/shared';

/**
 * ルーティングエンジンの抽象。
 * Valhalla / OSRM / 将来の公共交通エンジンをこのインタフェースの裏に隠す。
 */
export interface RouteProvider {
  readonly name: string;
  /** このエンジンが対応する移動手段 */
  readonly supportedModes: readonly TravelMode[];
  route(request: RouteRequest): Promise<Route>;
  /** 疎通確認 */
  healthCheck?(): Promise<boolean>;
}

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export class UnsupportedModeError extends RoutingError {
  constructor(mode: TravelMode, engine: string) {
    super(`${engine} は移動手段「${mode}」に対応していません`, undefined, 400);
    this.name = 'UnsupportedModeError';
  }
}
