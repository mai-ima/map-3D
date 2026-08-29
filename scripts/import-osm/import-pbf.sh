#!/usr/bin/env bash
#
# 大規模データ用: Geofabrik の OSM PBF を osm2pgsql で PostGIS に取り込む。
# Overpass 版（import-osm.ts）は小さな範囲の確認用、こちらが本番用。
#
#   ./scripts/import-osm/import-pbf.sh kanto
#   ./scripts/import-osm/import-pbf.sh kanto https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf
#
# データは ODbL 1.0（© OpenStreetMap contributors）。派生 DB を配布する場合は
# share-alike 条件を確認すること。
set -euo pipefail

REGION="${1:-kanto}"
PBF_URL="${2:-https://download.geofabrik.de/asia/japan/${REGION}-latest.osm.pbf}"
DATA_DIR="$(cd "$(dirname "$0")/../.." && pwd)/data/osm"
PBF_PATH="${DATA_DIR}/${REGION}-latest.osm.pbf"
DATABASE_URL="${DATABASE_URL:-postgres://ijm:ijm@localhost:5432/ijm}"

mkdir -p "${DATA_DIR}"

if [ ! -f "${PBF_PATH}" ]; then
  echo "[import-pbf] ダウンロード: ${PBF_URL}"
  curl -L --fail --progress-bar -o "${PBF_PATH}" "${PBF_URL}"
else
  echo "[import-pbf] 既存ファイルを使用: ${PBF_PATH}"
fi

echo "[import-pbf] チェックサムを記録"
sha256sum "${PBF_PATH}" > "${PBF_PATH}.sha256"

if ! command -v osm2pgsql >/dev/null 2>&1; then
  echo "[import-pbf] osm2pgsql が見つかりません。Docker で実行します。"
  docker run --rm --network host \
    -v "${DATA_DIR}:/data" \
    iboates/osm2pgsql:latest \
    osm2pgsql --create --slim --drop \
      --hstore \
      --database "${DATABASE_URL}" \
      "/data/${REGION}-latest.osm.pbf"
else
  osm2pgsql --create --slim --drop --hstore \
    --database "${DATABASE_URL}" \
    "${PBF_PATH}"
fi

echo "[import-pbf] 完了。road_nodes / road_edges への正規化は次のコマンドで行います:"
echo "  psql \"\${DATABASE_URL}\" -f scripts/import-osm/normalize.sql"
