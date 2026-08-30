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
 * 属性の参照。
 *
 * PLATEAU のバッチテーブルの属性名にはコロンが入っている（実データで確認済み:
 * bldg:usage / bldg:measuredHeight）。3D Tiles のスタイル式では、
 * コロンを含む名前は `${feature['名前']}` の形でしか参照できない。
 *
 * `${bldg:usage}` と直接書くと式のパースに失敗して例外になり、
 * `${['bldg:usage']}` はパースこそ通るが常に undefined になる（黙って壊れる）。
 * どちらも実際に踏んだので、参照はここに集約して書き間違いを防ぐ。
 */
const USAGE = "${feature['bldg:usage']}";
const HEIGHT = "${feature['bldg:measuredHeight']}";

/**
 * 用途ごとの色。
 *
 * 日本の市街地を上から見たときの印象に寄せて、彩度は低めに揃えている。
 * 派手に塗り分けると用途図になってしまい、街の風景に見えなくなる。
 *
 * 並び順は浜松市旧中区の実測での出現頻度順にしている。
 * スタイルの条件は上から順に評価され、最初に一致したところで止まるため、
 * 多い用途を先に置くと 1 棟あたりの評価回数が大きく減る
 * （住宅系だけで全体の 7 割を占めるので、平均 2〜3 回で決まる）。
 */
const USAGE_COLORS: [usage: string, color: string][] = [
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
const UNKNOWN_COLOR = '#cbc7c0';

/**
 * 実測高さによる明度の補正。
 *
 * 実際の街では高い建物ほど空の光を受けて明るく、低い建物は隣家の影に沈む。
 * テクスチャが無いと全部が同じ明るさになってのっぺりするので、
 * 実データの高さでわずかな差を付ける。
 *
 * 0m で ×0.95、60m 以上で ×1.07。段ではなく連続で変えるので、
 * 同じ用途の建物が並んでも階数の違いが分かる。
 */
const SHADE = `(0.95 + min(${HEIGHT}, 60.0) / 500.0)`;

/**
 * 高さが入っているか。
 *
 * スタイル式に defined() は無い（Cesium が用意しているのは isNaN と isFinite）。
 * 高さが未定義のまま min() に渡すと評価時に例外になり、そのタイルが描けなくなる。
 */
const HAS_HEIGHT = `!isNaN(${HEIGHT})`;

/**
 * 高さ補正を掛けた色。
 *
 * `color(...) * 係数` と書くとアルファまで掛かってしまい、
 * 建物がわずかに半透明になる（＝不透明で描けるはずのものが
 * 半透明パスに回り、描画が重くなる）。
 * 成分ごとに掛けて、アルファは 1.0 に固定する。
 */
function shaded(hex: string): string {
  const channel = (at: number) =>
    (Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4);
  return `vec4(${channel(1)} * ${SHADE}, ${channel(3)} * ${SHADE}, ${channel(5)} * ${SHADE}, 1.0)`;
}

/**
 * テクスチャを持たない建物モデル向けのスタイル。
 *
 * 用途で塗り分けたうえで、実測高さに応じて明度を変える。
 * 高さが入っていない建物には補正を掛けられないので、
 * 用途ごとに「高さあり」「高さなし」の 2 条件を並べている。
 */
export function untexturedBuildingStyle(): Cesium.Cesium3DTileStyle {
  const conditions: [string, string][] = [];
  for (const [usage, color] of USAGE_COLORS) {
    conditions.push([`${USAGE} === '${usage}' && ${HAS_HEIGHT}`, shaded(color)]);
    conditions.push([`${USAGE} === '${usage}'`, `color('${color}')`]);
  }
  conditions.push([HAS_HEIGHT, shaded(UNKNOWN_COLOR)]);
  conditions.push(['true', `color('${UNKNOWN_COLOR}')`]);

  return new Cesium.Cesium3DTileStyle({ color: { conditions } });
}

