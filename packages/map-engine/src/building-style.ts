/**
 * テクスチャを持たない建物モデルの見せ方。
 *
 * PLATEAU の LOD2 は自治体・年度によってテクスチャの有無が違う。
 * 東京都（2025 年度）は実写テクスチャを埋め込んでいるが、
 * 浜松市（2023 年度）はジオメトリのみで、配布 ZIP にも画像が 1 枚も無い。
 * テクスチャが無いモデルを素のまま出すと、街全体が同じ灰色の塊になり、
 * どこが駅でどこが住宅地なのか分からなくなる。
 *
 * そこで、建物が実際に持っている属性で塗り分ける。
 *
 *   bldg:usage           … 用途区分（住宅 / 商業施設 / 工場 など）
 *   bldg:measuredHeight  … 実測高さ
 *
 * これは「実在する建物の色を推測して塗る」のではなく、
 * 「実データとして与えられている用途を色で示す」という位置づけ。
 * 実写テクスチャがある地域には一切適用しない（そちらが事実の色そのものだから）。
 *
 * 浜松市旧中区の実測（1,292 棟）:
 *   住宅 56.4% / 共同住宅 13.0% / 不明 9.1% / 商業施設 7.9% /
 *   業務施設 3.1% / 店舗等併用住宅 2.9% / 運輸倉庫施設 2.4% ...
 */

import * as Cesium from 'cesium';

/**
 * 用途ごとの色。
 *
 * 日本の市街地を上から見たときの印象に寄せて、彩度は低めに揃えている。
 * 派手に塗り分けると用途図になってしまい、街の風景に見えなくなる。
 */
const USAGE_COLORS: [usage: string, color: string][] = [
  // 住宅系。街の過半を占めるので、最も自然な色にする
  ['住宅', '#d6d0c6'],
  ['共同住宅', '#cdc7bd'],
  ['店舗等併用住宅', '#d2cabd'],
  ['店舗等併用共同住宅', '#cec6b9'],
  ['作業所併用住宅', '#cbc5ba'],
  // 商業系。少し明るく、暖色寄りにして中心市街地が浮かび上がるようにする
  ['商業施設', '#dcd5c4'],
  ['商業系複合施設', '#d8d1c1'],
  ['宿泊施設', '#d9d0c0'],
  // 業務・公共系。やや青みを入れて商業と区別する
  ['業務施設', '#c8ccd1'],
  ['官公庁施設', '#c4c8cd'],
  ['文教厚生施設', '#c9ccc9'],
  // 産業系。コンクリートと金属屋根の色
  ['工場', '#bfc3c5'],
  ['運輸倉庫施設', '#c2c5c6'],
  ['供給処理施設', '#bcc0c2'],
  ['農林漁業用施設', '#c7c8bf'],
  ['防衛施設', '#c0c2c0'],
];

/** 用途が入っていない建物の色 */
const UNKNOWN_COLOR = '#cbc7c0';

/**
 * テクスチャを持たない建物モデル向けのスタイル。
 *
 * 用途で塗り分けたうえで、実測高さに応じて明度を変える。
 * 実際の街では高い建物ほど空の光を受けて明るく、低い建物は
 * 隣家の影に沈む。テクスチャが無いと全部が同じ明るさになって
 * のっぺりするので、実データの高さでわずかな差を付ける。
 *
 * 3D Tiles のスタイル式は色の演算に制限があるため、
 * 用途ごとに高さ補正済みの色を条件として並べる形で実現している。
 */
export function untexturedBuildingStyle(): Cesium.Cesium3DTileStyle {
  const shade = (hex: string, factor: number): string => {
    const r = Math.round(Number.parseInt(hex.slice(1, 3), 16) * factor);
    const g = Math.round(Number.parseInt(hex.slice(3, 5), 16) * factor);
    const b = Math.round(Number.parseInt(hex.slice(5, 7), 16) * factor);
    const clamp = (n: number): string => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0');
    return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
  };

  const conditions: [string, string][] = [];
  for (const [usage, color] of USAGE_COLORS) {
    // 高い建物ほど明るく。境界は日本の市街地の階数分布に合わせている
    conditions.push([
      `\${bldg:usage} === '${usage}' && \${bldg:measuredHeight} >= 45`,
      `color('${shade(color, 1.07)}')`,
    ]);
    conditions.push([
      `\${bldg:usage} === '${usage}' && \${bldg:measuredHeight} >= 20`,
      `color('${shade(color, 1.03)}')`,
    ]);
    conditions.push([
      `\${bldg:usage} === '${usage}' && \${bldg:measuredHeight} < 8`,
      `color('${shade(color, 0.95)}')`,
    ]);
    conditions.push([`\${bldg:usage} === '${usage}'`, `color('${color}')`]);
  }
  conditions.push([`\${bldg:measuredHeight} >= 45`, `color('${shade(UNKNOWN_COLOR, 1.07)}')`]);
  conditions.push([`\${bldg:measuredHeight} < 8`, `color('${shade(UNKNOWN_COLOR, 0.95)}')`]);
  conditions.push(['true', `color('${UNKNOWN_COLOR}')`]);

  return new Cesium.Cesium3DTileStyle({ color: { conditions } });
}

