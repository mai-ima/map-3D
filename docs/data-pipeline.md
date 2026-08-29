# データパイプライン

生データから 3D 表示までを再現可能にするための手順。すべてスクリプト化してあります。

```
Raw Data → 検証 → 正規化 → 座標系変換 → 変換 → 最適化 → 3D Tiles → タイル配信 → CesiumJS
```

MVP の既定構成では **[A] 配信利用ルート** を使い、変換は行いません。
自前ホストしたい場合に [B] [C] を使います。

---

## [A] 配信利用ルート（既定・変換不要）

| データ | エンドポイント |
| --- | --- |
| 3D 建物 | `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{spec}/tileset.json` |
| 地形 | `https://tile.plateauview.mlit.go.jp/terrain/` |
| ベースマップ | `https://cyberjapandata.gsi.go.jp/xyz/{style}/{z}/{x}/{y}.{ext}` |

`{spec}` の形式は `<area>-<type>-<lod>[-notexture]-<year>` です。

- `area`: 都道府県コード（2 桁）/ 市区町村コード（5 桁）/ `all`
- `type`: `bldg`（建築物）など
- `lod`: `lod1` / `lod2` / `maxlod1` / `maxlod2`
- `year`: 西暦 または `latest`

例:

```
13-bldg-maxlod2-latest      東京都・LOD2 まで（テクスチャあり）
13-bldg-maxlod1-latest      東京都・LOD1（遠景用の軽量モデル）
13101-bldg-maxlod2-latest   千代田区
```

> 注意: `lod1` に `notexture` を付けた spec（例 `13-bldg-lod1-notexture-latest`）は
> HTTP 200 を返しますが**中身が空**です。LOD1 はもともとテクスチャを持たないためです。
> このような「200 だが空」を検出するために検証スクリプトを用意しています。

```bash
npm run validate:cities            # 全都市
npm run validate:cities tokyo      # 都市を指定
```

出力例:

```
[OK] tokyo (東京都心)
      近景 .../13-bldg-maxlod2-latest/tileset.json → OK children=62
      遠景 .../13-bldg-maxlod1-latest/tileset.json → OK children=62
```

---

## [B] CityGML → 3D Tiles（自前ホスト）

PLATEAU 配信サービスは実験的サービスのため、停止・仕様変更に備えた経路です。

### 1. 取得

G空間情報センターから対象都市の CityGML をダウンロードし、`data/plateau/{データセット名}/` に展開します。

- https://www.geospatial.jp/ckan/dataset/plateau

### 2. 検証

CityGML の構造・必須属性・座標系を確認します。**不正なデータは変換せず記録します**
（誤った位置のまま 3D にしないため）。

### 3. 正規化と座標系変換

CityGML は平面直角座標系（JGD2011, EPSG:6669〜6687）で記述されている場合があります。
`packages/shared/src/coords.ts` が国土地理院の計算式（Gauss-Krüger 級数展開）を実装しており、
往復変換の誤差は 1cm 未満であることを単体テストで検証しています。

```
JGD2011 平面直角座標 (X, Y) ─► JGD2011 緯度経度 ─► WGS84（本アプリの内部標準）
```

JGD2011 と WGS84 の差は数 cm 未満のため、都市可視化の用途では同一として扱います
（この方針はコード内に明記しています）。

### 4. 変換

[PLATEAU GIS Converter](https://github.com/MIERUNE/plateau-gis-converter)（MIT）を使います。

```bash
./scripts/convert-plateau/convert-plateau.sh 13101_chiyoda-ku
```

### 5. 最適化

```bash
./scripts/generate-tiles/generate-tiles.sh 13101_chiyoda-ku
```

- `tileset.json` の検証（root / geometricError / タイル数）
- glTF の Draco 圧縮（`gltf-transform` がある場合）
- JSON の事前 gzip（nginx の `gzip_static` 用）

### 6. 配信

```bash
docker compose -f docker/docker-compose.yml --profile selfhost-tiles up -d tiles
# → http://localhost:8090/13101_chiyoda-ku/tileset.json
```

環境変数 `PLATEAU_TILESET_BASE` をこの URL に向けると、アプリが自前タイルを読むようになります。
CORS ヘッダは `docker/nginx/tiles.conf` で設定済みです（CesiumJS はブラウザから直接取得するため必須）。

---

## [C] OSM → PostGIS（道路ネットワーク・POI）

### 小規模（範囲を絞った確認用）

Overpass API から取得し、構造化した道路ネットワークを SQL / GeoJSON として出力します。

```bash
npm run import:osm -- tokyo
npm run import:osm -- tokyo --bbox 139.75,35.67,139.78,35.69
```

生成物:

```
data/osm/tokyo-network.sql       PostGIS 投入用
data/osm/tokyo-network.json      確認用 GeoJSON
data/osm/tokyo-manifest.json     再現性の記録（bbox / 件数 / SHA-256）
```

### 大規模（本番）

```bash
./scripts/import-osm/import-pbf.sh kanto
psql "$DATABASE_URL" -f scripts/import-osm/normalize.sql
```

Geofabrik の PBF を osm2pgsql で取り込み、`normalize.sql` で本アプリのスキーマへ正規化します。

### 道路ネットワークの構造

道路を単なる線として持たず、ナビゲーションに使える構造にしています。

**ノード**

| kind | 意味 |
| --- | --- |
| `intersection` | 交差点（接続エッジ 3 本以上） |
| `crossing` | 横断歩道 |
| `traffic_signal` | 信号 |
| `stop` | 停止線 |
| `entrance` | 建物などの出入口 |
| `endpoint` | 端点 |

**エッジ**

| kind | 意味 |
| --- | --- |
| `road` | 車道 |
| `sidewalk` | 歩道 |
| `crosswalk` | 横断歩道 |
| `cycleway` | 自転車道 |
| `footway` | 歩行者道 |
| `stairs` | 階段 |
| `service` | 構内道路 |

この構造から交差点の複雑さ（分岐数・信号・横断歩道の数）を算出し、
ナビゲーションカメラが `INTERSECTION` 演出に入るかどうかの判断に使います。

---

## 再現性

各スクリプトは冪等で、生成物と一緒にマニフェスト（入力・日時・件数・ハッシュ）を出力します。

- `data/osm/{city}-manifest.json`
- `data/tiles/{dataset}/manifest.json`
- PostGIS の `import_runs` テーブル

`data/` は Git 管理外です（サイズが大きく、すべて再取得可能なため）。
