/**
 * テクスチャを持たない建物モデルの色。
 *
 * 描画エンジンに依存しない値と計算。Swift へもそのまま持っていける。
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

/**
 * 用途ごとの色。
 *
 * 日本の市街地を上から見たときの印象に寄せて、彩度は低めに揃えている。
 * 派手に塗り分けると用途図になってしまい、街の風景に見えなくなる。
 *
 * 並び順は浜松市旧中区の実測での出現頻度順。
 * 3D Tiles のスタイル式は上から順に評価され、最初に一致したところで止まるため、
 * 多い用途を先に置くと 1 棟あたりの評価回数が大きく減る
 * （住宅系だけで全体の 7 割を占めるので、平均 2〜3 回で決まる）。
 */
export const BUILDING_USAGE_COLOURS: [usage: string, hex: string][] = [
  // 住宅系。街の過半を占めるので、最も自然な色にする
  ['住宅', '#d6d0c6'],
  ['共同住宅', '#cdc7bd'],
  // 商業系。少し明るく、暖色寄りにして中心市街地が浮かび上がるようにする
  ['商業施設', '#dcd5c4'],
  // 業務・公共系。やや青みを入れて商業と区別する
  ['業務施設', '#c8ccd1'],
  ['店舗等併用住宅', '#d2cabd'],
  // 産業系。コンクリートと金属屋根の色
  ['運輸倉庫施設', '#c2c5c6'],
  ['工場', '#bfc3c5'],
  ['文教厚生施設', '#c9ccc9'],
  ['店舗等併用共同住宅', '#cec6b9'],
  ['商業系複合施設', '#d8d1c1'],
  ['官公庁施設', '#c4c8cd'],
  ['宿泊施設', '#d9d0c0'],
  ['供給処理施設', '#bcc0c2'],
  ['作業所併用住宅', '#cbc5ba'],
  ['農林漁業用施設', '#c7c8bf'],
  ['防衛施設', '#c0c2c0'],
];

/** 用途が入っていない建物の色 */
export const BUILDING_UNKNOWN_COLOUR = '#cbc7c0';

/**
 * 高さによる明度の係数。
 *
 * 実際の街では高い建物ほど空の光を受けて明るく、低い建物は隣家の影に沈む。
 * テクスチャが無いと全部が同じ明るさになってのっぺりするので、
 * 実データの高さでわずかな差を付ける。
 *
 * 0m で ×0.95、60m 以上で ×1.07。段ではなく連続で変えるので、
 * 同じ用途の建物が並んでも階数の違いが分かる。
 */
export function buildingShade(heightM: number): number {
  if (!Number.isFinite(heightM)) return 1;
  return 0.95 + Math.min(Math.max(heightM, 0), 60) / 500;
}

/** 遠景 LOD1 の色。高さだけで決める（用途を読まない軽い判定） */
export const BUILDING_HEIGHT_COLOURS: [minHeightM: number, hex: string][] = [
  [150, '#c4c0ba'],
  [80, '#c9c5bf'],
  [40, '#cecac4'],
  [0, '#d3cfc9'],
];

/** 高さが読めない建物の色（遠景） */
export const BUILDING_HEIGHT_UNKNOWN_COLOUR = '#cfcbc4';

/** 0〜1 の RGB */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` を 0〜1 の RGB に直す */
export function hexToRgb(hex: string): Rgb {
  const at = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: at(1), g: at(3), b: at(5) };
}

/**
 * 用途と高さから建物の色を決める。
 *
 * 3D Tiles のスタイル式は文字列なので、そちらは map-engine 側でこの表から
 * 組み立てる。この関数は Swift のように 1 棟ずつ色を引く実装のためのもの。
 * どちらも同じ表を見るので、見た目が食い違うことはない。
 */
export function buildingColour(usage: string | undefined, heightM?: number): Rgb {
  const hex =
    BUILDING_USAGE_COLOURS.find(([name]) => name === usage)?.[1] ?? BUILDING_UNKNOWN_COLOUR;
  const rgb = hexToRgb(hex);
  if (heightM === undefined || !Number.isFinite(heightM)) return rgb;
  const shade = buildingShade(heightM);
  return { r: rgb.r * shade, g: rgb.g * shade, b: rgb.b * shade };
}

/** 高さだけから遠景の建物の色を決める */
export function buildingHeightColour(heightM?: number): Rgb {
  if (heightM === undefined || !Number.isFinite(heightM)) {
    return hexToRgb(BUILDING_HEIGHT_UNKNOWN_COLOUR);
  }
  const hex =
    BUILDING_HEIGHT_COLOURS.find(([min]) => heightM >= min)?.[1] ??
    BUILDING_HEIGHT_UNKNOWN_COLOUR;
  return hexToRgb(hex);
}
