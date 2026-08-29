#!/usr/bin/env bash
#
# PLATEAU の CityGML を 3D Tiles に変換する（自前ホスト構成用）。
#
# 既定の構成では PLATEAU 配信サービスの 3D Tiles をそのまま使うため、この変換は不要。
# 配信サービスは「実験的」でサービス継続が保証されないため、
# 自前でホストしたい場合にこのスクリプトを使う。
#
# 使い方:
#   1. G空間情報センターから対象都市の CityGML (zip) を data/plateau/ にダウンロード
#      https://www.geospatial.jp/ckan/dataset/plateau
#   2. ./scripts/convert-plateau/convert-plateau.sh 13101_chiyoda-ku
#
# 変換には PLATEAU GIS Converter（MIT ライセンス）を使う:
#   https://github.com/MIERUNE/plateau-gis-converter
#   （Project PLATEAU の公式ミラー: https://github.com/Project-PLATEAU/PLATEAU-GIS-Converter）
#
# 出力される 3D Tiles のライセンスは元データに従う（CC BY 4.0 / 出典表示が必須）。
set -euo pipefail

DATASET="${1:-}"
if [ -z "${DATASET}" ]; then
  echo "使い方: $0 <データセット名（例: 13101_chiyoda-ku）>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="${ROOT}/data/plateau/${DATASET}"
OUT_DIR="${ROOT}/data/tiles/${DATASET}"
CONVERTER="${PLATEAU_CONVERTER_BIN:-plateau-gis-converter}"

if [ ! -d "${SRC_DIR}" ]; then
  echo "[convert-plateau] CityGML が見つかりません: ${SRC_DIR}" >&2
  echo "  G空間情報センターから取得して展開してください。" >&2
  exit 1
fi

if ! command -v "${CONVERTER}" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
[convert-plateau] plateau-gis-converter が見つかりません。

インストール方法のいずれか:
  * リリースからバイナリを取得: https://github.com/MIERUNE/plateau-gis-converter/releases
  * ソースからビルド (Rust):
      git clone https://github.com/MIERUNE/plateau-gis-converter
      cd plateau-gis-converter && cargo build --release -p nusamai
  取得したバイナリのパスを PLATEAU_CONVERTER_BIN に設定してください。
MSG
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "[convert-plateau] 変換: ${SRC_DIR} -> ${OUT_DIR}"
# CityGML → 3D Tiles 1.1（座標系は WGS84 に変換される）
"${CONVERTER}" \
  --input "${SRC_DIR}" \
  --output "${OUT_DIR}" \
  --filetype 3dtiles

cat > "${OUT_DIR}/manifest.json" <<JSON
{
  "dataset": "${DATASET}",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "Project PLATEAU CityGML (国土交通省)",
  "license": "CC BY 4.0",
  "attribution": "3D都市モデル Project PLATEAU（国土交通省）を加工して作成",
  "converter": "plateau-gis-converter (MIT)"
}
JSON

echo "[convert-plateau] 完了。配信するには:"
echo "  docker compose -f docker/docker-compose.yml --profile selfhost-tiles up -d tiles"
echo "  → http://localhost:8090/${DATASET}/tileset.json"
echo "  環境変数 PLATEAU_TILESET_BASE をその URL に向けてください。"
