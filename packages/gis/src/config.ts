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
  /** 外部リクエスト 1 回あたりのタイムアウト (ms) */
  timeoutMs: number;
  /**
   * 1 つの取得にかけてよい合計時間 (ms)。
   *
   * エンドポイントを順に試すので、1 回あたりのタイムアウトだけを決めていると
   * 合計が青天井になる。実測（2026-09、浜松の高架）では
   * Overpass の 3 か所が順に時間切れになり、そのあと OSM 本体に切り替えて
   * **80 秒**かかっていた。API 側の maxDuration は 45 秒なので、
   * 本番では応答が返る前に打ち切られ、利用者にはエラーとして見えていた。
   *
   * 「遅れて全部出る」より「早く諦めて、出せるものを出す」ほうがよい。
   */
  budgetMs: number;
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
    // 1 回あたり 12 秒。健康な Overpass は数秒で返し、混んでいるときは
    // 503/504 をすぐ返す。20 秒待っても結果が良くなることはほとんどない
    timeoutMs: envNumber(env.GIS_TIMEOUT_MS, 12000),
    // 合計 30 秒。API 側の maxDuration（45 秒）に対して、
    // 受け取ったあとの組み立てぶんを残す
    budgetMs: envNumber(env.GIS_BUDGET_MS, 30000),
  };
}

/**
 * 締め切りまでの残り時間 (ms)。
 * 締め切りが無ければ既定値をそのまま返す。
 */
export function remainingMs(deadline: number | undefined, fallback: number): number {
  if (deadline === undefined) return fallback;
  return Math.max(0, deadline - Date.now());
}

/**
 * 予備の取得先のために残しておく時間 (ms)。
 *
 * OSM 本体の API は、範囲を絞れない代わりに Overpass より安定している。
 */
export const FALLBACK_RESERVE_MS = 8000;

/**
 * 主の取得先（Overpass）に許す締め切り。
 *
 * これを入れないと、Overpass が合計時間を使い切ったところで
 * 予備に切り替える時間が残らない。実測（2026-09、浜松の高架）では
 * Overpass の 2 か所が順に時間切れになった時点で締め切りに達し、
 * OSM 本体を一度も呼ばないまま空を返していた。
 */
export function primaryDeadline(deadline: number, reserveMs = FALLBACK_RESERVE_MS): number {
  // 主の取得先にも最低限の時間は与える（全部を予備に回さない）
  return Math.max(Date.now() + 3000, deadline - reserveMs);
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
