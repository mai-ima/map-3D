/**
 * OSRM ルーティングプロバイダ（Valhalla が使えないときのフォールバック）。
 * 仕様: https://project-osrm.org/docs/v5.24.0/api/
 *  - プロファイルはサーバ側で固定されるため、モードごとに別 URL を設定する
 *  - 形状は polyline (precision 5) を既定とする
 */

import type { Maneuver, ManeuverType, Route, RouteRequest, RouteStep, TravelMode } from '@ijm/shared';
import { bboxOf, decodePolyline } from '@ijm/shared';
import { RoutingError, UnsupportedModeError, type RouteProvider } from './types';

export interface OsrmOptions {
  /** 例: { drive: 'https://router.project-osrm.org/route/v1/driving' } */
  endpoints: Partial<Record<TravelMode, string>>;
  timeoutMs?: number;
}

/**
 * 応答の型。ネットワーク越しの JSON なので、
 * 仕様上は必ずある項目も省略可として書く（無いことを解析側で確かめられるように）。
 */
interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  geometry?: string;
  maneuver?: {
    type?: string;
    modifier?: string;
    location?: [number, number];
    bearing_before?: number;
    bearing_after?: number;
  };
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: string;
    legs?: { steps?: OsrmStep[] }[];
  }[];
}

function mapType(type: string, modifier?: string): ManeuverType {
  if (type === 'depart') return 'start';
  if (type === 'arrive') return 'destination';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout_enter';
  if (type === 'exit roundabout' || type === 'exit rotary') return 'roundabout_exit';
  if (type === 'merge') return 'merge';
  if (type === 'on ramp' || type === 'off ramp') return 'ramp';
  switch (modifier) {
    case 'left':
      return 'turn_left';
    case 'right':
      return 'turn_right';
    case 'slight left':
      return 'slight_left';
    case 'slight right':
      return 'slight_right';
    case 'sharp left':
      return 'sharp_left';
    case 'sharp right':
      return 'sharp_right';
    case 'uturn':
      return 'uturn';
    default:
      return 'continue';
  }
}

const JA_INSTRUCTIONS: Partial<Record<ManeuverType, string>> = {
  start: '出発します',
  continue: '直進します',
  turn_left: '左折します',
  turn_right: '右折します',
  slight_left: '斜め左方向です',
  slight_right: '斜め右方向です',
  sharp_left: '鋭角に左折します',
  sharp_right: '鋭角に右折します',
  uturn: 'Uターンします',
  merge: '合流します',
  ramp: 'ランプに入ります',
  roundabout_enter: 'ラウンドアバウトに入ります',
  roundabout_exit: 'ラウンドアバウトを出ます',
  destination: '目的地に到着します',
  stairs: '階段を使います',
};

export class OsrmProvider implements RouteProvider {
  readonly name = 'osrm';
  readonly supportedModes: readonly TravelMode[];

  constructor(private readonly options: OsrmOptions) {
    this.supportedModes = Object.keys(options.endpoints) as TravelMode[];
  }

  async route(request: RouteRequest): Promise<Route> {
    const endpoint = this.options.endpoints[request.mode];
    if (!endpoint) throw new UnsupportedModeError(request.mode, this.name);

    const coords = [
      `${request.from.lng},${request.from.lat}`,
      ...(request.via ?? []).map((v) => `${v.lng},${v.lat}`),
      `${request.to.lng},${request.to.lat}`,
    ].join(';');

    const url = `${endpoint}/${coords}?overview=full&geometries=polyline&steps=true&annotations=false`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000) });
    } catch (e) {
      throw new RoutingError('OSRM に接続できませんでした', e);
    }

    const json = (await res.json().catch(() => ({}))) as OsrmResponse;
    if (!res.ok || json.code !== 'Ok' || !json.routes?.length) {
      throw new RoutingError(json.message ?? `経路を計算できませんでした (HTTP ${res.status})`, json);
    }

    const r = json.routes[0];
    const coordinates = typeof r.geometry === 'string' ? decodePolyline(r.geometry, 5) : [];
    // 2 点なければ線にならない。ここで打ち切って呼び出し側に判断させる
    if (coordinates.length < 2) {
      throw new RoutingError('経路の形状を受け取れませんでした', json);
    }

    const maneuvers: Maneuver[] = [];
    const steps: RouteStep[] = [];

    let cursor = 0;
    // 応答の欠けは「配列があるはずの場所が undefined」で来る。
    // for-of をそのまま当てると TypeError になり、内部メッセージが利用者に出てしまう
    for (const leg of r.legs ?? []) {
      for (const step of leg?.steps ?? []) {
        const type = mapType(step.maneuver?.type ?? '', step.maneuver?.modifier);
        const stepCoords = typeof step.geometry === 'string' ? decodePolyline(step.geometry, 5) : [];
        const beginIndex = cursor;
        cursor = Math.min(cursor + Math.max(0, stepCoords.length - 1), coordinates.length - 1);
        // maneuver.location が無ければ、その位置の形状点で代用する
        const at = step.maneuver?.location;
        const point = at ?? coordinates[beginIndex];
        const distance = Math.round(finite(step.distance));
        const duration = Math.round(finite(step.duration));

        maneuvers.push({
          type,
          instruction: step.name
            ? `${JA_INSTRUCTIONS[type] ?? ''}（${step.name}）`
            : (JA_INSTRUCTIONS[type] ?? ''),
          location: { lng: point[0], lat: point[1] },
          bearingBefore: step.maneuver?.bearing_before,
          bearingAfter: step.maneuver?.bearing_after,
          distanceToNext: distance,
          durationToNext: duration,
          streetName: step.name || undefined,
          shapeIndex: beginIndex,
        });

        steps.push({
          index: steps.length,
          distance,
          duration,
          streetName: step.name || undefined,
          beginIndex,
          endIndex: cursor,
        });
      }
    }

    return {
      id: `osrm-${Date.now().toString(36)}`,
      mode: request.mode,
      geometry: r.geometry ?? '',
      coordinates,
      distance: Math.round(finite(r.distance)),
      duration: Math.round(finite(r.duration)),
      steps,
      maneuvers,
      bbox: bboxOf(coordinates),
      attribution: ['© OpenStreetMap contributors', 'Routing by OSRM'],
      engine: this.name,
    };
  }
}

/** 数値でない値は 0 として扱う（NaN を下流に流さない） */
function finite(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}
