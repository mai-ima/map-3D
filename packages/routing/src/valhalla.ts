/**
 * Valhalla ルーティングプロバイダ。
 *
 * 公式仕様: https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
 *  - 形状は polyline6
 *  - 距離は units 指定（既定 km）
 *  - maneuver.type は数値の列挙
 *
 * FOSSGIS の公開デモサーバを使う場合は、利用ポリシーに従い
 * X-Client-Id ヘッダを付与し、リクエスト間隔を空ける。
 */

import type { LatLng, Maneuver, ManeuverType, Route, RouteRequest, RouteStep, TravelMode } from '@ijm/shared';
import { bboxOf, bearingDegrees, decodePolyline } from '@ijm/shared';
import { RoutingError, UnsupportedModeError, type RouteProvider } from './types';

export interface ValhallaOptions {
  baseUrl: string;
  clientId?: string;
  timeoutMs?: number;
  language?: string;
}

const COSTING: Partial<Record<TravelMode, string>> = {
  walk: 'pedestrian',
  drive: 'auto',
  bicycle: 'bicycle',
  multimodal: 'multimodal',
  transit: 'multimodal',
};

/** Valhalla の maneuver.type → 共通 ManeuverType */
const MANEUVER_TYPES: Record<number, ManeuverType> = {
  0: 'continue',
  1: 'start',
  2: 'start',
  3: 'start',
  4: 'destination',
  5: 'destination',
  6: 'destination',
  7: 'continue',
  8: 'continue',
  9: 'slight_right',
  10: 'turn_right',
  11: 'sharp_right',
  12: 'uturn',
  13: 'uturn',
  14: 'sharp_left',
  15: 'turn_left',
  16: 'slight_left',
  17: 'ramp',
  18: 'ramp',
  19: 'ramp',
  20: 'ramp',
  21: 'ramp',
  22: 'continue',
  23: 'slight_right',
  24: 'slight_left',
  25: 'merge',
  26: 'roundabout_enter',
  27: 'roundabout_exit',
  28: 'ferry',
  29: 'ferry',
  30: 'transit',
  31: 'transit',
  32: 'transit',
  33: 'transit',
  34: 'transit',
  35: 'transit',
  36: 'transit',
  37: 'merge',
  38: 'merge',
  39: 'continue',
  40: 'stairs',
  41: 'continue',
  42: 'continue',
  43: 'continue',
};

interface ValhallaManeuver {
  type: number;
  instruction?: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  street_names?: string[];
  begin_street_names?: string[];
  time: number;
  length: number;
  begin_shape_index: number;
  end_shape_index: number;
  bearing_before?: number;
  bearing_after?: number;
  travel_mode?: string;
}

interface ValhallaLeg {
  maneuvers: ValhallaManeuver[];
  shape: string;
  summary: { time: number; length: number };
}

interface ValhallaResponse {
  trip?: {
    legs: ValhallaLeg[];
    summary: { time: number; length: number };
    status?: number;
    status_message?: string;
    units?: string;
  };
  error?: string;
  error_code?: number;
}

export class ValhallaProvider implements RouteProvider {
  readonly name = 'valhalla';
  readonly supportedModes: readonly TravelMode[] = ['walk', 'drive', 'bicycle', 'multimodal'];

  constructor(private readonly options: ValhallaOptions) {}

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.options.baseUrl}/status`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.clientId) headers['X-Client-Id'] = this.options.clientId;
    return headers;
  }

  async route(request: RouteRequest): Promise<Route> {
    const costing = COSTING[request.mode];
    if (!costing) throw new UnsupportedModeError(request.mode, this.name);

    const locations: { lat: number; lon: number }[] = [
      { lat: request.from.lat, lon: request.from.lng },
      ...(request.via ?? []).map((v) => ({ lat: v.lat, lon: v.lng })),
      { lat: request.to.lat, lon: request.to.lng },
    ];

    const body = {
      locations,
      costing,
      units: 'kilometers',
      language: request.language ?? this.options.language ?? 'ja-JP',
      directions_options: { units: 'kilometers', language: request.language ?? 'ja-JP' },
      // 歩行者は屋内・階段を含むため、案内を細かめに
      costing_options:
        costing === 'pedestrian'
          ? { pedestrian: { walking_speed: 4.5, use_ferry: 0.5 } }
          : undefined,
    };

    let res: Response;
    try {
      res = await fetch(`${this.options.baseUrl}/route`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      });
    } catch (e) {
      throw new RoutingError('ルーティングサーバに接続できませんでした', e);
    }

    const json = (await res.json().catch(() => ({}))) as ValhallaResponse;
    if (!res.ok || !json.trip) {
      throw new RoutingError(
        json.error ?? `経路を計算できませんでした (HTTP ${res.status})`,
        json,
        res.status === 400 ? 400 : 502,
      );
    }

    return this.toRoute(json, request);
  }

  private toRoute(json: ValhallaResponse, request: RouteRequest): Route {
    const trip = json.trip!;
    const coordinates: [number, number][] = [];
    const maneuvers: Maneuver[] = [];
    const steps: RouteStep[] = [];

    for (const leg of trip.legs) {
      const offset = coordinates.length;
      const legCoords = decodePolyline(leg.shape, 6);
      // 連続するレグの重複点を除去
      coordinates.push(...(offset > 0 ? legCoords.slice(1) : legCoords));
      const indexOffset = offset > 0 ? offset - 1 : 0;

      leg.maneuvers.forEach((m, i) => {
        const shapeIndex = Math.min(m.begin_shape_index + indexOffset, coordinates.length - 1);
        const point = coordinates[shapeIndex] ?? coordinates[coordinates.length - 1];
        const location: LatLng = { lng: point[0], lat: point[1] };
        const streetName = m.street_names?.[0] ?? m.begin_street_names?.[0];
        const next = leg.maneuvers[i + 1];

        maneuvers.push({
          type: MANEUVER_TYPES[m.type] ?? 'continue',
          instruction: m.instruction ?? '',
          verbalInstruction: m.verbal_pre_transition_instruction,
          location,
          bearingBefore: m.bearing_before ?? bearingFromShape(coordinates, shapeIndex, -1),
          bearingAfter: m.bearing_after ?? bearingFromShape(coordinates, shapeIndex, 1),
          distanceToNext: Math.round(m.length * 1000),
          durationToNext: Math.round(m.time),
          streetName,
          nextStreetName: next?.street_names?.[0],
          shapeIndex,
        });

        steps.push({
          index: steps.length,
          distance: Math.round(m.length * 1000),
          duration: Math.round(m.time),
          streetName,
          beginIndex: shapeIndex,
          endIndex: Math.min(m.end_shape_index + indexOffset, coordinates.length - 1),
        });
      });
    }

    return {
      id: `valhalla-${Date.now().toString(36)}`,
      mode: request.mode,
      geometry: trip.legs.map((l) => l.shape).join(''),
      coordinates,
      distance: Math.round(trip.summary.length * 1000),
      duration: Math.round(trip.summary.time),
      steps,
      maneuvers,
      bbox: bboxOf(coordinates),
      attribution: ['© OpenStreetMap contributors', 'Routing by Valhalla'],
      engine: this.name,
    };
  }
}

/** shape 上の前後の点から方位を求める（エンジンが bearing を返さない場合の補完） */
function bearingFromShape(
  coordinates: [number, number][],
  index: number,
  direction: 1 | -1,
): number | undefined {
  const other = index + direction * 2;
  if (other < 0 || other >= coordinates.length || index < 0 || index >= coordinates.length) {
    return undefined;
  }
  const a = coordinates[direction === 1 ? index : other];
  const b = coordinates[direction === 1 ? other : index];
  return Math.round(bearingDegrees({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] }));
}
