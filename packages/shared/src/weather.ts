/**
 * 天候ごとの見え方。
 *
 * 描画エンジンに依存しない純粋な値と計算。Swift へもそのまま持っていける。
 * `sun.ts`（時間帯）と対になる。
 *
 * **なぜ表にするのか。**
 * 以前は霧の濃さと空の彩度をわずかに動かすだけで、晴れと雨を選び分けても
 * 街の見え方がほとんど変わらなかった（「天候システムが意味ない」）。
 *
 * 天候で実際に変わるのは 3 つある。
 *
 *   1. 視程（どこまで見通せるか）
 *   2. 日射（雲がどれだけ光を遮るか）
 *   3. 影ができるかどうか
 *
 * 視程は気象庁の視程階級に対応させている:
 *
 *   快晴・晴れ   20km 以上
 *   曇り         10〜20km
 *   雨           4〜10km（並の雨）
 *   雪           1〜4km（並の雪）
 *   霧           1km 未満（これが霧の定義そのもの）
 *
 * 日射の割合は、全天日射量に対する雲量の影響の実測値による
 * （気象庁の日照率と全天日射量の関係。曇天で快晴の 3〜5 割、
 *  雨天で 2 割前後）。
 *
 * **影の有無が最も効く。** 曇りの日に建物の影が地面に落ちていると、
 * 空をどれだけ灰色にしても晴れにしか見えない。
 */

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog';

export interface WeatherLook {
  /** 視程 (m)。霧の濃さをここから決める */
  visibilityM: number;
  /** 直射日光の割合（快晴を 1 とする） */
  sunlight: number;
  /** 直射日光があるか（＝輪郭のある影ができるか） */
  directSun: boolean;
  /** 空の彩度の補正（-1〜1） */
  skySaturation: number;
  /** 空の明るさの補正（-1〜1） */
  skyBrightness: number;
}

export const WEATHER_LOOK: Record<WeatherKind, WeatherLook> = {
  clear: {
    visibilityM: 30_000,
    sunlight: 1,
    directSun: true,
    skySaturation: 0,
    skyBrightness: 0,
  },
  cloudy: {
    visibilityM: 14_000,
    sunlight: 0.45,
    directSun: false,
    skySaturation: -0.5,
    skyBrightness: -0.18,
  },
  rain: {
    visibilityM: 6_000,
    sunlight: 0.22,
    directSun: false,
    skySaturation: -0.6,
    skyBrightness: -0.3,
  },
  snow: {
    visibilityM: 2_500,
    sunlight: 0.3,
    directSun: false,
    skySaturation: -0.45,
    skyBrightness: 0.05,
  },
  fog: {
    visibilityM: 700,
    sunlight: 0.35,
    directSun: false,
    skySaturation: -0.7,
    skyBrightness: 0.02,
  },
};

/** 天候の選択肢（UI の並び順） */
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'cloudy', 'rain', 'snow', 'fog'];

/** 値が天候かどうか */
export function isWeatherKind(value: unknown): value is WeatherKind {
  return typeof value === 'string' && value in WEATHER_LOOK;
}

/**
 * 視程から霧の濃さを求める。
 *
 * Cesium の `fog.density` は「その距離で霧に沈む」という素直な単位ではないが、
 * 実測すると density × 視程 がおよそ 6 で一定になる
 * （density 0.0002 で 30km、0.002 で 3km あたりが霧に沈む）。
 * 視程を先に決めて、そこから density を逆算する。
 *
 * Swift（SceneKit / RealityKit）では霧の指定の仕方が違うので、
 * 「視程を先に決める」という考え方だけを持っていって、
 * 換算はそちらの実装に合わせて書き直す。
 */
export function fogDensityFor(visibilityM: number): number {
  // Math.max(100, NaN) は NaN になる。そのまま渡すと霧の濃さが NaN になり、
  // Cesium では霧が消える（＝どの天候でも見通しが同じになる）。
  // 数として読めない値は、最も濃い側へ倒しておくほうが安全側になる
  const metres = Number.isFinite(visibilityM) ? Math.max(100, visibilityM) : 100;
  return Math.min(0.02, Math.max(0.00005, 6 / metres));
}
