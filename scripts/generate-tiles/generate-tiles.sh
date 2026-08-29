#!/usr/bin/env bash
#
# 自前ホストする 3D Tiles の最適化と配信準備。
#
#   ./scripts/generate-tiles/generate-tiles.sh 13101_chiyoda-ku
#
# 行うこと:
#   1. tileset.json の検証（root と geometricError の存在確認）
#   2. glTF の Draco 圧縮（gltf-transform がある場合）
#   3. gzip 事前圧縮（nginx の gzip_static 用）
#   4. マニフェスト更新
set -euo pipefail

DATASET="${1:-}"
if [ -z "${DATASET}" ]; then
  echo "使い方: $0 <データセット名>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${ROOT}/data/tiles/${DATASET}"

if [ ! -f "${DIR}/tileset.json" ]; then
  echo "[generate-tiles] tileset.json が見つかりません: ${DIR}" >&2
  exit 1
fi

echo "[generate-tiles] tileset.json を検証"
node -e "
const fs = require('fs');
const t = JSON.parse(fs.readFileSync('${DIR}/tileset.json', 'utf8'));
if (!t.root) { console.error('root がありません'); process.exit(1); }
if (typeof t.geometricError !== 'number') { console.error('geometricError がありません'); process.exit(1); }
const count = (node) => 1 + (node.children ?? []).reduce((s, c) => s + count(c), 0);
console.log('  タイル数:', count(t.root), '/ asset.version:', t.asset?.version);
"

if command -v gltf-transform >/dev/null 2>&1; then
  echo "[generate-tiles] glTF を Draco 圧縮"
  find "${DIR}" -name '*.glb' -print0 | while IFS= read -r -d '' f; do
    gltf-transform draco "$f" "$f" >/dev/null
  done
else
  echo "[generate-tiles] gltf-transform が無いため圧縮をスキップ（npm i -g @gltf-transform/cli）"
fi

echo "[generate-tiles] JSON を事前 gzip 圧縮"
find "${DIR}" -name '*.json' -print0 | while IFS= read -r -d '' f; do
  gzip -9 -k -f "$f"
done

TOTAL_SIZE=$(du -sh "${DIR}" | cut -f1)
echo "[generate-tiles] 完了。合計サイズ: ${TOTAL_SIZE}"
