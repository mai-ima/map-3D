/**
 * 太陽の位置と、そこから決まる明るさ。
 *
 * 描画エンジンに依存しない純粋な計算。Swift へもそのまま持っていける。
 *
 * **なぜ計算するのか。**
 * 以前は「5:30 より前と 18:30 より後は夜」という固定の閾値で
 * 昼夜を切り替えていた。日本の実際の日の出・日の入りは季節で大きく動く。
 *
 *   東京（北緯 35.68 度）の実際:
 *     夏至  日の出 04:25 / 日の入り 19:00
 *     冬至  日の出 06:47 / 日の入り 16:32
 *
 * 固定の閾値だと、12 月の 17 時が「昼」、6 月の 5 時が「夜」になる。
 * どちらも実際とは逆で、これが「時間帯がリアルじゃない」の正体。
 *
 * 太陽高度は暦の計算で決まる値なので、創作ではない。
 *
 * 計算式の出典: NOAA Solar Calculator
 * （Astronomical Algorithms, Jean Meeus, 2nd ed. の簡略式）
 * 誤差は日の出・日の入りの時刻でおよそ 1 分。
 */

import type { LatLng } from './types';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** 太陽の位置 */
export interface SolarPosition {
  /** 地平線からの高度 (度)。負なら地平線の下 */
  elevationDeg: number;
  /** 方位角 (度)。真北 0・東回り */
  azimuthDeg: number;
}

/**
 * ユリウス世紀（J2000.0 からの経過）。
 * 暦の計算はすべてこの単位で書かれている。
 */
function julianCentury(date: Date): number {
  // Unix 時刻 → ユリウス日
  const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
  return (julianDay - 2_451_545) / 36_525;
}

/** 太陽の赤緯と均時差を求める */
function solarCoordinates(t: number): { declinationDeg: number; equationOfTimeMin: number } {
  // 幾何平均黄経
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  // 平均近点角
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  // 離心率
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  // 中心差
  const centre =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;

  const trueLongitude = meanLongitude + centre;
  // 見かけの黄経（章動と光行差の補正）
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  // 平均黄道傾斜角
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);

  const declinationDeg =
    Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) * DEG;

  // 均時差（真太陽時と平均太陽時の差、分）
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLongitude * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 * eccentricity * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLongitude * RAD) -
      0.5 * y * y * Math.sin(4 * meanLongitude * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  return { declinationDeg, equationOfTimeMin: equationOfTime };
}

/**
 * 指定の日時・地点における太陽の位置。
 *
 * @param date UTC として扱う時刻（JS の Date はそのまま UTC を持っている）
 */
export function solarPosition(date: Date, at: LatLng): SolarPosition {
  const t = julianCentury(date);
  const { declinationDeg, equationOfTimeMin } = solarCoordinates(t);

  // UTC の「その日の何分目か」
  const minutesUtc =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  // 真太陽時（分）。経度 1 度は 4 分
  const trueSolarMin = (minutesUtc + equationOfTimeMin + 4 * at.lng + 1440) % 1440;
  // 時角（度）。正午で 0
  const hourAngle = trueSolarMin / 4 - 180;

  const lat = at.lat * RAD;
  const dec = declinationDeg * RAD;
  const ha = hourAngle * RAD;

  const cosZenith =
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevationDeg = 90 - zenith * DEG;

  // 方位角（真北 0・東回り）
  let azimuthDeg = 0;
  const sinZenith = Math.sin(zenith);
  if (Math.abs(sinZenith) > 1e-9) {
    const cosAz = (Math.sin(dec) - Math.sin(lat) * cosZenith) / (Math.cos(lat) * sinZenith);
    azimuthDeg = Math.acos(Math.min(1, Math.max(-1, cosAz))) * DEG;
    if (hourAngle > 0) azimuthDeg = 360 - azimuthDeg;
  }

  return { elevationDeg, azimuthDeg };
}

/**
 * 空の状態。太陽高度から決まる。
 *
 * 境目の値は天文学の定義に従う:
 *   市民薄明  太陽高度 -6 度まで。屋外で新聞が読める明るさ
 *   航海薄明  -12 度まで。水平線が見分けられる
 *   天文薄明  -18 度まで。ここから先が本当の夜
 *
 * 見た目に効くのは市民薄明までなので、その 3 段階で分ける。
 */
export type SkyPhase = 'day' | 'golden' | 'twilight' | 'night';

/**
 * 太陽高度から空の状態を決める。
 *
 *   6 度より上   … 日中
 *   0〜6 度      … 朝焼け・夕焼け（光が赤く、影が長い）
 *   -6〜0 度     … 薄明（太陽は沈んでいるが空は明るい）
 *   -6 度より下  … 夜
 */
export function skyPhaseOf(elevationDeg: number): SkyPhase {
  if (!Number.isFinite(elevationDeg)) return 'day';
  if (elevationDeg > 6) return 'day';
  if (elevationDeg > 0) return 'golden';
  if (elevationDeg > -6) return 'twilight';
  return 'night';
}

/**
 * 日照の強さ (0〜1)。
 *
 * 大気の減衰を考えた近似。太陽高度が低いほど、光は厚い大気を通るので弱くなる。
 * 高度 0 度で 0、90 度で 1 に近づく。
 * 実際の直達日射は sin(高度) にほぼ比例する（快晴時）。
 */
export function daylightStrength(elevationDeg: number): number {
  if (!Number.isFinite(elevationDeg)) return 1;
  if (elevationDeg <= -6) return 0;
  if (elevationDeg <= 0) {
    // 薄明。太陽は沈んでいるが空は明るい
    return ((elevationDeg + 6) / 6) * 0.12;
  }
  return 0.12 + Math.sin(Math.min(90, elevationDeg) * RAD) * 0.88;
}

/**
 * 日の出・日の入りの時刻（その地点の地方時、時単位）。
 *
 * 大気差と太陽の視半径を見込んで、天頂角 90.833 度で交差する時刻を求める。
 * 白夜・極夜では null を返す（日本では起きないが、計算としては起こりうる）。
 */
export function sunTimes(
  date: Date,
  at: LatLng,
  /** 地方時への時差 (時)。日本標準時なら 9 */
  utcOffsetHours: number,
): { sunriseHour: number; sunsetHour: number } | null {
  const t = julianCentury(date);
  const { declinationDeg, equationOfTimeMin } = solarCoordinates(t);

  const lat = at.lat * RAD;
  const dec = declinationDeg * RAD;
  // 90.833 度 = 90 度 + 大気差 34 分 + 太陽の視半径 16 分
  const cosHourAngle =
    (Math.cos(90.833 * RAD) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;

  const hourAngle = Math.acos(cosHourAngle) * DEG;
  // 南中時刻（UTC の分）
  const solarNoonMin = 720 - 4 * at.lng - equationOfTimeMin;
  const toLocal = (minutesUtc: number) => (minutesUtc / 60 + utcOffsetHours + 24) % 24;

  return {
    sunriseHour: toLocal(solarNoonMin - hourAngle * 4),
    sunsetHour: toLocal(solarNoonMin + hourAngle * 4),
  };
}
