/**
 * OSRM ルーティングプロバイダ（Valhalla が使えないときのフォールバック）。
 * 仕様: https://project-osrm.org/docs/v5.24.0/api/
 *  - プロファイルはサーバ側で固定されるため、モードごとに別 URL を設定する
 *  - 形状は polyline (precision 5) を既定とする
 */

import type {
  Lane,
  LaneIndication,
  Maneuver,
  ManeuverType,
  Route,
  RouteRequest,
  RouteStep,
  TravelMode,
} from '@ijm/shared';
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
/**
 * 交差点。step の走行中に通るものが順に並ぶ。
 * 先頭がその step のマニューバ地点（OSRM の仕様）。
 */
interface OsrmIntersection {
  lanes?: { valid?: boolean; indications?: string[] }[];
}

interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  geometry?: string;
  /** 路線番号。セミコロン区切りで複数（例: "1; 20"） */
  ref?: string;
  /** 案内標識の行き先（例: "E1: 横浜, 静岡"） */
  destinations?: string;
  intersections?: OsrmIntersection[];
  maneuver?: {
    type?: string;
    modifier?: string;
    location?: [number, number];
    bearing_before?: number;
    bearing_after?: number;
  };
}

/**
 * 車線の矢印。OSRM は OSM の `turn:lanes` を解釈して、
 * 空白区切りの語で返してくる（実データで確認: left / straight /
 * slight right / right）。
 *
 * 仕様上ありうる値をすべて並べてある。
 * 知らない語は 'none'（矢印なし）にする。**推測して矢印を作らない。**
 * 実在しない矢印を出すと、運転中にその車線へ寄ってしまう。
 */
const LANE_INDICATIONS: Record<string, LaneIndication> = {
  left: 'left',
  'slight left': 'slight_left',
  'sharp left': 'sharp_left',
  straight: 'through',
  right: 'right',
  'slight right': 'slight_right',
  'sharp right': 'sharp_right',
  uturn: 'uturn',
  merge_to_left: 'merge_left',
  merge_to_right: 'merge_right',
  none: 'none',
};

/**
 * 車線案内を読み取る。
 *
 * OSRM は step の走行中に通るすべての交差点を `intersections` に並べ、
 * **先頭がその step のマニューバ地点**になる。案内パネルが出すのは
 * 「次に何をするか」なので、そのマニューバ地点の車線だけを使う。
 *
 * 途中の交差点にも車線情報が付くことがあるが（実データでは
 * 1 つの step に 29 個の交差点が並び、そのうち 1 つが車線を持っていた）、
 * それは通過点の話なので、次の分岐の案内としては使わない。
 *
 * OSM に `turn:lanes` が無い交差点では OSRM も返さない。
 * そのときは車線案内を出さない（車線数から矢印を作らない）。
 */
/**
 * 路線番号を読む。
 *
 * OSM の `ref` はセミコロン区切りで複数入る（重複区間）。
 * 実データの例: "406"（都道 406 号）/ "1; 20"（国道 1 号と 20 号）/ "E1"（東名）。
 * 日本の案内標識の慣習に合わせ「・」で並べる。
 */
function readRef(value: string | undefined): string | undefined {
  const parts = (value ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('・') : undefined;
}

/**
 * 方面（案内標識の行き先）を読む。
 *
 * OSM の `destination` を OSRM がそのまま渡してくる。
 * 実データの例（2026-09）:
 *   "E1: 横浜, 静岡"  路線番号つき（コロンの前が `destination:ref`）
 *   "138: 山中湖, 箱根"
 *   "三軒茶屋"        路線番号なし
 *
 * コロンの前は路線番号なので、方面としては外す
 * （路線番号は `routeRef` で別に持つ）。
 * カンマ区切りの行き先は「・」で並べる（日本の案内標識の書き方）。
 */
function readDestination(value: string | undefined): {
  destination?: string;
  ref?: string;
} {
  const raw = (value ?? '').trim();
  if (!raw) return {};

  // OSRM は `destination:ref` と `destination` をコロンでつないで返す。
  // 番号が無ければコロンの前は空になる（":" だけの応答もありうる）
  const colon = raw.indexOf(':');
  const ref = colon >= 0 ? raw.slice(0, colon).trim() : '';
  const places = (colon >= 0 ? raw.slice(colon + 1) : raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    destination: places.length > 0 ? places.join('・') : undefined,
    ref: ref ? readRef(ref) : undefined,
  };
}

function readLanes(step: OsrmStep): Lane[] | undefined {
  const lanes = step.intersections?.[0]?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) return undefined;

  const out: Lane[] = [];
  for (const lane of lanes) {
    const indications = Array.isArray(lane?.indications)
      ? lane.indications.map((i) => LANE_INDICATIONS[i] ?? 'none')
      : [];
    out.push({ indications, valid: lane?.valid === true });
  }
  // どの車線も通れないという応答は解釈できない。出さないほうが安全
  return out.some((l) => l.valid) ? out : undefined;
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

    // 車線案内は intersections に入っている。steps=true で付いてくる
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
        const signed = readDestination(step.destinations);

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
          lanes: readLanes(step),
          destination: signed.destination,
          // 標識に書かれている番号（destination:ref）を優先する。
          // いま走っている道の番号（ref）より、進む先の番号のほうが役に立つ
          routeRef: signed.ref ?? readRef(step.ref),
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
