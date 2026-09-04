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
import { bboxOf, bearingDegrees, decodePolyline, encodePolyline } from '@ijm/shared';
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

/**
 * 応答の型。相手はネットワーク越しの JSON なので、
 * 仕様上は必ずある項目も「無いことがある」として省略可で書く。
 * 必須で書くと、解析側で存在を確かめる分岐が型エラーとして消されてしまう。
 */
interface ValhallaManeuver {
  type: number;
  instruction?: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  /** 曲がる直前に読み上げる短い警告 */
  verbal_transition_alert_instruction?: string;
  street_names?: string[];
  begin_street_names?: string[];
  time?: number;
  length?: number;
  begin_shape_index: number;
  end_shape_index: number;
  bearing_before?: number;
  bearing_after?: number;
  travel_mode?: string;
  /**
   * 案内標識の内容（高速道路の分岐・出口）。
   *
   * 実データで確認した形（2026-09, valhalla1.openstreetmap.de、
   * 東京駅 → 御殿場。16 のマニューバのうち 3 つが中身を持っていた）:
   *
   *   exit_number_elements  [{ text: "7" }]                     出口番号
   *   exit_branch_elements  [{ text: "138" }]                   分岐先の路線番号
   *   exit_toward_elements  [{ text: "山中湖" }, { text: "箱根" }]  方面
   *   exit_name_elements    [{ text: "御殿場ＩＣ" }, { text: "Gotemba" }] 出口名
   *
   * 一般道だけの経路では `sign: {}` と空で返る。
   */
  sign?: {
    exit_number_elements?: { text?: string }[];
    exit_branch_elements?: { text?: string }[];
    exit_toward_elements?: { text?: string }[];
    exit_name_elements?: { text?: string }[];
  };
  /**
   * 車線案内。
   *
   * **2026-09 時点の公開デモ（valhalla1.openstreetmap.de）は返さない。**
   * 一般道・高速道路のどちらの経路でも 0 件だった（実測）。
   * 自前の Valhalla を新しい版で立てれば入る可能性があるので、
   * 来ていたら読めるように型だけ置いておく。
   * ただし **中身の形を実データで確認できるまで解釈しない**
   * （推測で車線の矢印を作ると、運転中に誤った車線へ寄せることになる）。
   */
  lanes?: unknown;
}

/**
 * 標識の要素から日本語のものを選ぶ。
 *
 * Valhalla は日本語と英語を並べて返すことがある
 * （実データ: 「御殿場ＩＣ」と「Gotemba」）。
 * 日本の案内標識に合わせて日本語を優先し、
 * 日本語が無ければ先頭を使う（英語しか無い地域のため）。
 */
function pickJapanese(elements: { text?: string }[] | undefined): string | undefined {
  // 配列で来るとは限らない。相手はネットワーク越しの JSON で、
  // 型どおりでない値が届いても案内そのものは出す
  const texts = signTexts(elements);
  if (texts.length === 0) return undefined;
  // ひらがな・カタカナ・漢字のいずれかを含むものを日本語とみなす
  return texts.find((t) => /[ぁ-んァ-ヶ一-龠]/.test(t)) ?? texts[0];
}

/** 標識の要素を「・」で並べる（日本の案内標識の書き方） */
function joinElements(elements: { text?: string }[] | undefined): string | undefined {
  const texts = signTexts(elements);
  return texts.length > 0 ? texts.join('・') : undefined;
}

/** 標識の要素から、読める文字列だけを取り出す */
function signTexts(elements: { text?: string }[] | undefined): string[] {
  if (!Array.isArray(elements)) return [];
  return elements
    .map((e) => (typeof e?.text === 'string' ? e.text.trim() : ''))
    .filter((t) => t.length > 0);
}

interface ValhallaLeg {
  maneuvers?: ValhallaManeuver[];
  shape?: string;
  summary?: { time?: number; length?: number };
}

interface ValhallaResponse {
  trip?: {
    legs?: ValhallaLeg[];
    summary?: { time?: number; length?: number };
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

    // 応答の欠けは HTTP エラーではなく「配列があるはずの場所が undefined」で来る。
    // for-of や forEach をそのまま当てると TypeError になり、
    // 利用者には英語の内部メッセージがそのまま出てしまう。
    const legs = Array.isArray(trip.legs) ? trip.legs : [];

    for (const leg of legs) {
      const offset = coordinates.length;
      const legCoords = typeof leg?.shape === 'string' ? decodePolyline(leg.shape, 6) : [];
      // 連続するレグの重複点を除去
      coordinates.push(...(offset > 0 ? legCoords.slice(1) : legCoords));
      const indexOffset = offset > 0 ? offset - 1 : 0;
      const legManeuvers = Array.isArray(leg?.maneuvers) ? leg.maneuvers : [];

      legManeuvers.forEach((m, i) => {
        // 座標が 1 点も取れていないと参照先が無い。案内だけ先に積んでも意味がないので飛ばす
        if (coordinates.length === 0) return;
        // 範囲外や負の添字がそのまま残ると、案内までの距離が 0 と扱われて
        // 「出発した瞬間に通過済み」になる（maneuver-planner が cumulative[index] を引く）
        const shapeIndex = clampIndex(m.begin_shape_index + indexOffset, coordinates.length);
        const point = coordinates[shapeIndex];
        const location: LatLng = { lng: point[0], lat: point[1] };
        const streetName = m.street_names?.[0] ?? m.begin_street_names?.[0];
        const next = legManeuvers[i + 1];
        // length/time が欠けると NaN になり、残距離も到着時刻も表示できなくなる
        const distance = Math.round(finite(m.length) * 1000);
        const duration = Math.round(finite(m.time));

        maneuvers.push({
          type: MANEUVER_TYPES[m.type] ?? 'continue',
          instruction: m.instruction ?? '',
          verbalInstruction: m.verbal_pre_transition_instruction,
          verbalAlert: m.verbal_transition_alert_instruction,
          verbalPost: m.verbal_post_transition_instruction,
          location,
          bearingBefore: m.bearing_before ?? bearingFromShape(coordinates, shapeIndex, -1),
          bearingAfter: m.bearing_after ?? bearingFromShape(coordinates, shapeIndex, 1),
          distanceToNext: distance,
          durationToNext: duration,
          streetName,
          nextStreetName: next?.street_names?.[0],
          shapeIndex,
          // 案内標識（高速道路の分岐・出口）。無ければ何も出さない
          destination: joinElements(m.sign?.exit_toward_elements),
          routeRef: joinElements(m.sign?.exit_branch_elements),
          exitNumber: pickJapanese(m.sign?.exit_number_elements),
          exitName: pickJapanese(m.sign?.exit_name_elements),
        });

        steps.push({
          index: steps.length,
          distance,
          duration,
          streetName,
          beginIndex: shapeIndex,
          endIndex: clampIndex(m.end_shape_index + indexOffset, coordinates.length),
        });
      });
    }

    // 2 点なければ線にならない。フォールバック側に回せるよう、ここで打ち切る
    if (coordinates.length < 2) {
      throw new RoutingError('経路の形状を受け取れませんでした', json);
    }

    // レグごとの polyline は「直前の点からの差分」で書かれているので、
    // 文字列をつないでも 2 本目以降が元の位置に戻らない。つなげた座標から再度符号化する
    const summary = trip.summary ?? { time: NaN, length: NaN };
    return {
      id: `valhalla-${Date.now().toString(36)}`,
      mode: request.mode,
      geometry: encodePolyline(coordinates, 6),
      coordinates,
      distance: Math.round(finite(summary.length) * 1000),
      duration: Math.round(finite(summary.time)),
      steps,
      maneuvers,
      bbox: bboxOf(coordinates),
      attribution: ['© OpenStreetMap contributors', 'Routing by Valhalla'],
      engine: this.name,
    };
  }
}

/** 数値でない値は 0 として扱う（NaN を下流に流さない） */
function finite(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

/** 添字を [0, length-1] に収める。数値でなければ先頭 */
function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), length - 1));
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
