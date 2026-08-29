/**
 * `@spz-loader/core` のスタブ。
 *
 * CesiumJS は Gaussian Splat（.spz）読み込みのためにこのパッケージを静的 import する。
 * 本体は WASM をソース内にインライン化しており、バンドラがそれを文字列として取り込むと
 * 不正な JavaScript（テンプレート文字列中の 8 進エスケープ）になってビルド成果物が壊れる。
 *
 * 本アプリは PLATEAU の 3D Tiles（b3dm/glTF）しか読み込まず Gaussian Splat は使わないため、
 * ここでスタブに差し替えてバンドルから除外する（next.config.ts の resolveAlias で解決）。
 * 将来 Splat を使う場合は、このエイリアスを外し、Cesium の推奨する静的配信構成に切り替えること。
 */

export async function loadSpz(): Promise<never> {
  throw new Error(
    'Gaussian Splat (.spz) の読み込みはこのビルドでは無効化されています（@spz-loader/core をスタブ化）。',
  );
}

export default { loadSpz };
