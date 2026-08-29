# data/

パイプラインが生成・取得するデータの置き場所です。**Git 管理外**（`.gitignore` 済み）。
すべて再取得できるため、リポジトリには含めません。

| ディレクトリ | 内容 | 取得元 |
| --- | --- | --- |
| `osm/` | OSM PBF、道路ネットワークの SQL/GeoJSON | Geofabrik / Overpass API（ODbL 1.0） |
| `plateau/` | PLATEAU の CityGML（自前変換する場合） | G空間情報センター（CC BY 4.0） |
| `terrain/` | 自前生成する地形タイル（既定では不要） | 国土地理院 標高タイル |
| `tiles/` | 自前変換した 3D Tiles | PLATEAU CityGML からの変換物 |

生成物には必ず `manifest.json`（入力・日時・件数・ハッシュ・ライセンス）が付きます。
再現手順は [docs/data-pipeline.md](../docs/data-pipeline.md) を参照してください。

**注意**: OSM 由来の派生データベースを配布する場合は ODbL の share-alike 条件が適用されます。
