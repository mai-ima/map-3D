/**
 * 範囲内の地表の高さを、格子でまとめて取って補間する。
 *
 * 線路の道床や信号の柱は地表に接していないと浮いて見えるが、
 * 点ごとに標高を問い合わせると要求が数千件になる。
 *
 * 地形は 100m の間隔で見ればほぼ滑らかなので、
 * 格子で取って双線形補間すれば十分な精度が出る。
 * 浜松の 1.5km 四方なら 16×16 = 256 点で済む。
 *
 * 最近傍ではなく双線形にするのは、道床のような連続した構造で
 * 段差が出ないようにするため。最近傍だと 100m ごとに
 * 階段状の継ぎ目ができる。
 */

import * as Cesium from 'cesium';
import type { BBox, LatLng } from '@ijm/shared';

/** 格子の間隔 (m) */
export const TERRAIN_CELL_M = 100;
/** 一度に問い合わせる点の上限。これを超えるときは格子を粗くする */
const MAX_SAMPLES = 2048;

const M_PER_DEG_LAT = 111_320;

/**
 * 格子状に取った標高。
 *
 * 地形が無い（EllipsoidTerrainProvider）ときや取得に失敗したときは、
 * すべて 0 を返す。平地では実害が小さく、道が消えるよりはよい。
 */
export class TerrainHeights {
  private constructor(
    private readonly minLng: number,
    private readonly minLat: number,
    private readonly stepLng: number,
    private readonly stepLat: number,
    private readonly cols: number,
    private readonly rows: number,
    private readonly values: Float64Array,
  ) {}

  /** すべて 0 を返すもの（地形が無いとき） */
  static flat(): TerrainHeights {
    return new TerrainHeights(0, 0, 1, 1, 0, 0, new Float64Array(0));
  }

  static async sample(
    terrain: Cesium.TerrainProvider | undefined,
    bbox: BBox,
    cellMeters = TERRAIN_CELL_M,
  ): Promise<TerrainHeights> {
    if (!terrain || terrain instanceof Cesium.EllipsoidTerrainProvider) {
      return TerrainHeights.flat();
    }

    const [minLng, minLat, maxLng, maxLat] = bbox;
    const midLat = (minLat + maxLat) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;

    let stepLat = cellMeters / M_PER_DEG_LAT;
    let stepLng = cellMeters / (M_PER_DEG_LAT * cosLat);

    // 点数が多くなりすぎるときは格子を粗くする。
    // 細かくしても地形が滑らかなら結果はほとんど変わらない
    let cols = Math.ceil((maxLng - minLng) / stepLng) + 1;
    let rows = Math.ceil((maxLat - minLat) / stepLat) + 1;
    if (cols * rows > MAX_SAMPLES) {
      const scale = Math.sqrt((cols * rows) / MAX_SAMPLES);
      stepLat *= scale;
      stepLng *= scale;
      cols = Math.ceil((maxLng - minLng) / stepLng) + 1;
      rows = Math.ceil((maxLat - minLat) / stepLat) + 1;
    }
    if (cols < 2 || rows < 2) return TerrainHeights.flat();

    const requests: Cesium.Cartographic[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        requests.push(Cesium.Cartographic.fromDegrees(minLng + c * stepLng, minLat + r * stepLat));
      }
    }

    try {
      const sampled = await Cesium.sampleTerrainMostDetailed(terrain, requests);
      const values = new Float64Array(cols * rows);
      for (let i = 0; i < values.length; i += 1) values[i] = sampled[i]?.height ?? 0;
      return new TerrainHeights(minLng, minLat, stepLng, stepLat, cols, rows, values);
    } catch {
      return TerrainHeights.flat();
    }
  }

  /** その位置の標高 (m)。格子の 4 点から双線形補間する */
  at(p: LatLng): number {
    if (this.cols < 2 || this.rows < 2) return 0;

    const fx = (p.lng - this.minLng) / this.stepLng;
    const fy = (p.lat - this.minLat) / this.stepLat;
    // 範囲の外は端の値を使う
    const cx = Math.min(this.cols - 2, Math.max(0, Math.floor(fx)));
    const cy = Math.min(this.rows - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - cx));
    const ty = Math.min(1, Math.max(0, fy - cy));

    const v = (col: number, row: number) => this.values[row * this.cols + col];
    const bottom = v(cx, cy) * (1 - tx) + v(cx + 1, cy) * tx;
    const top = v(cx, cy + 1) * (1 - tx) + v(cx + 1, cy + 1) * tx;
    return bottom * (1 - ty) + top * ty;
  }

  /** `at` を関数として渡すためのもの */
  get lookup(): (p: LatLng) => number {
    return (p) => this.at(p);
  }
}
