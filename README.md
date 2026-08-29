# Immersive Japan Map

**オープンデータで、日本の実在都市をリアルタイム 3D 空間として再現し、その中を自然なカメラワークと AI でナビゲーションできるオープンソース地図。**

OpenStreetMap・国土交通省 PLATEAU・国土地理院の公開データを組み合わせ、
CesiumJS でリアルタイム 3D レンダリングし、Valhalla による経路探索と
独自の Immersive Navigation カメラを組み合わせています。

> **地理的正確性についての方針**
> 実在する建物・道路・地形は、必ず実測由来の GIS データ（PLATEAU / OSM / 国土地理院）を使います。
> 生成 AI に建物や道路を作らせることはありません。AI が担当するのは「自然言語の理解」と
> 「不足する装飾アセットの見た目」だけで、位置情報は常に実データです。

---

## 何ができるか

| 機能 | 内容 |
| --- | --- |
| 3D 都市 | PLATEAU の実測 3D 建物（LOD1/LOD2）と全国地形を CesiumJS で表示 |
| 探索 | マウス・タッチで自由に移動。東京駅・丸の内・皇居・銀座・渋谷・新宿などへワンタップ移動 |
| 経路探索 | 徒歩 / 自動車 / 自転車。Valhalla による日本語ターンバイターン案内 |
| Immersive Navigation | ルート追従カメラ、交差点の先読み、旋回演出、交差点ハイライト、遮蔽建物の透過、到着演出、音声案内 |
| AI 操作 | 「東京駅から皇居まで歩いて」のような自然言語を Tool Calling で地図操作に変換 |
| 時間帯・天候 | 06:00〜22:00 の太陽位置・影・空の変化。晴/曇/雨/雪/霧 |
| POI | コンビニ・カフェ・飲食店・駅・公園などを OSM から取得して 3D 上に表示 |
| 街路樹・街灯 | OSM に登録された**実在位置**にのみ配置（位置の捏造をしない） |

---

## クイックスタート

```bash
git clone https://github.com/mai-ima/map-3d.git
cd map-3d
npm install
cp .env.example .env.local     # そのままでも動作します（公開デモ API を使用）
npm run dev                    # http://localhost:3000
```

初期状態では次の公開データを直接利用します（APIキー不要）。

- 3D 建物: PLATEAU 配信サービス（3D Tiles）
- 地形: PLATEAU-Terrain（quantized-mesh）
- ベースマップ: 地理院タイル
- 経路探索: FOSSGIS の公開 Valhalla（1 req/秒の制限あり）
- 検索 / POI: Nominatim / Overpass API（公開インスタンス）

本番運用ではセルフホスト構成（後述）を使ってください。

### Vercel へのデプロイ

**インポートして Deploy するだけです。Root Directory は既定（リポジトリ直下）のまま変更しないでください。**

1. Vercel で本リポジトリをインポート
2. Framework Preset が Next.js になっていることを確認（自動）
3. Deploy（環境変数は AI 機能を使う場合のみ必要）

Next.js アプリはリポジトリ直下にあり、直下の `package.json` に `next` が入っているため、
Vercel のフレームワーク検出がそのまま通ります
（アプリをサブディレクトリに置くと Root Directory の設定が必須になり、
`No Next.js version detected` の原因になるため直下に置いています）。

ビルド設定は `vercel.json`:

- `buildCommand: npm run build` … `prebuild` で CesiumJS の静的アセットが `public/cesium` にコピーされる
- `functions` … 各 API のタイムアウト / `regions` … 東京 (`hnd1`)

手順・環境変数・トラブルシューティングは [docs/deploy-vercel.md](docs/deploy-vercel.md) を参照。

### iPhone での利用

iPhone（A17 世代以降を想定）では品質を落とさない設定を自動で選びます。

- `resolutionScale` を devicePixelRatio（最大 2.0）まで引き上げて Retina 解像度で描画
- MSAA 4x、影、アンビエントオクルージョン、ブルームを有効
- 発熱対策は「品質を下げる」ではなく、影の距離制限・遠景タイルセットの切り離し・
  静止時の再描画停止（`requestRenderMode`）で行う
- セーフエリア対応、ピンチ操作でページ全体がズームしないよう設定済み

---

## セルフホスト構成（Docker）

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
```

| サービス | 役割 |
| --- | --- |
| `web` | Next.js（3D 表示 + BFF、リポジトリ直下のアプリ） |
| `api` | スタンドアロン API（同じロジックを共有） |
| `postgres` | PostgreSQL 17 + PostGIS 3.5（道路ネットワーク / POI） |
| `valhalla` | ルーティングエンジン（初回起動時に OSM PBF からタイル構築） |
| `tiles` | 自前ホストの 3D Tiles 配信（`--profile selfhost-tiles`） |

> Valhalla の初回ビルドは関東規模でも数十分かかります。

---

## データパイプライン

```
PLATEAU 配信サービス (3D Tiles) ─────────────► CesiumJS   ← 既定はこの経路（変換不要）
PLATEAU-Terrain (quantized-mesh) ────────────► CesiumJS
地理院タイル (PNG/JPG) ───────────────────────► CesiumJS

CityGML ─► 検証 ─► 正規化 ─► 座標変換 ─► 3D Tiles ─► 自前配信 ─► CesiumJS   ← 任意
OSM PBF ─► osm2pgsql ─► 正規化 ─► PostGIS ─► API                              ← 任意
```

```bash
npm run validate:cities          # 都市レジストリの 3D Tiles が実在するか検証
npm run import:osm -- tokyo      # OSM の道路ネットワーク/POI を取得して SQL 生成
./scripts/import-osm/import-pbf.sh kanto            # 大規模データの取り込み
./scripts/convert-plateau/convert-plateau.sh 13101_chiyoda-ku   # CityGML → 3D Tiles
./scripts/generate-tiles/generate-tiles.sh 13101_chiyoda-ku     # 最適化と配信準備
```

詳細は [docs/data-pipeline.md](docs/data-pipeline.md) を参照。

---

## プロジェクト構成

```
immersive-japan-map/
├── app/               Next.js App Router（画面 + API）— Vercel のデプロイ対象
├── components/        画面固有の React コンポーネント
├── lib/               BFF クライアント
├── public/            Cesium の静的アセット（prebuild で生成、Git 管理外）
├── apps/
│   └── api/           セルフホスト用スタンドアロン API
├── packages/
│   ├── shared/        型・座標系変換・幾何・都市レジストリ・出典・アイコン形状
│   ├── gis/           Overpass / Nominatim / PLATEAU / 地理院タイル
│   ├── routing/       RouteProvider 抽象 + Valhalla / OSRM
│   ├── navigation/    ナビカメラ状態機械・ルート追従・音声案内（3D 非依存）
│   ├── map-engine/    CesiumJS ラッパ（シーン・品質・環境・建物・ルート描画）
│   ├── ai/            AIProvider 抽象 + 地図ツール（Tool Calling）
│   └── ui/            共有 UI プリミティブ・SVG アイコン
├── data/              osm / plateau / terrain / tiles（Git 管理外）
├── scripts/           import-osm / convert-plateau / generate-tiles / preprocessing
├── docker/            Docker Compose / Dockerfile / PostGIS スキーマ
└── docs/              research.md / architecture.md / data-pipeline.md /
                       deploy-vercel.md / licenses.md
```

依存の向きは `shared → gis → routing`、`navigation` と `map-engine` はその上に載ります。
**CesiumJS に依存するのは `map-engine` だけ**で、ナビゲーションのロジックは 3D エンジンから独立しており、
単体テストできます。

---

## 開発コマンド

```bash
npm run dev          # 開発サーバ
npm run build        # 本番ビルド
npm run typecheck    # 型チェック
npm test             # ナビゲーション・座標変換の単体テスト
npm run validate:cities   # PLATEAU 配信の実在確認
npm run preview:icons     # アイコン一覧を data/icon-preview.html に出力
```

### アイコン（絵文字は使わない）

UI・3D マーカーとも**絵文字を使わず、すべて SVG** で描画しています。
絵文字は環境ごとに字形・色・サイズが変わり、特に 3D シーン上のラベルでは
余白や大きさを制御できないためです。

形状データは `packages/shared/src/icons.ts` に一元化され、2 か所から描画されます。

| 用途 | 実装 |
| --- | --- |
| UI（React） | `packages/ui/src/icons.tsx` の `<Icon name="..." />` |
| 3D マーカー（Cesium） | `packages/map-engine/src/marker-icons.ts` が SVG データ URI を生成しビルボードに使用 |

同じ形状データを共有しているため、パネル上のアイコンと 3D 空間上のマーカーの絵柄が一致します。
アイコンを追加・変更したら `npm run preview:icons` で実寸を確認してください。

### 都市を追加する

`packages/shared/src/cities.ts` にエントリを 1 つ追加し、`npm run validate:cities` を実行するだけです。

```ts
{
  id: 'sendai',
  name: '仙台',
  nameEn: 'Sendai',
  prefectureCode: '04',
  cityCodes: ['04100'],
  center: { lat: 38.2606, lng: 140.8819 },
  bbox: [140.8, 38.2, 140.95, 38.32],
  near: { area: '04100', lod: 'maxlod2' },
  far: { area: '04', lod: 'maxlod1' },
  initialHeight: 1600,
  districts: [{ id: 'sendai-station', name: '仙台駅', center: {...}, height: 800 }],
}
```

3D Tiles は都市の bbox に入ったときだけ読み込まれ、離れると破棄されます。
**起動時に日本全国のデータを読み込むことはありません。**

---

## AI 機能の設定

AI はプロバイダ非依存です。環境変数だけで切り替わり、コードにベンダー名は現れません。

```bash
AI_PROVIDER=openai      # openai | anthropic | gemini | local
AI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

AI が地図を直接操作することはありません。必ず以下のツール呼び出しを経由します。

`search_place` / `search_nearby` / `calculate_route` / `get_building_info` /
`get_map_context` / `set_camera` / `highlight_location` / `start_navigation` /
`set_time_of_day` / `set_weather`

さらに、UI コマンドに載せられる座標は**ツール実行で実際に得られた座標のみ**に制限しています
（LLM が座標を捏造しても地図には反映されません）。

---

## データ出典とライセンス

| データ | ライセンス | 表示 |
| --- | --- | --- |
| Project PLATEAU 3D 都市モデル | CC BY 4.0 | 3D都市モデル Project PLATEAU（国土交通省） |
| PLATEAU-Terrain | 上記に準拠 | PLATEAU / Mapterhorn / 国土地理院 |
| OpenStreetMap | ODbL 1.0 | © OpenStreetMap contributors |
| 地理院タイル | 国土地理院コンテンツ利用規約 | 出典：国土地理院（地理院タイル） |
| Valhalla | MIT（データは ODbL） | Routing by Valhalla |
| CesiumJS | Apache-2.0 | — |

出典はアプリ内の「データ出典」パネルから常時確認できます。
詳細は [docs/licenses.md](docs/licenses.md) を参照してください。

**本プロジェクトは Google Maps のコード・データ・UI を一切使用していません。**

## ライセンス

本リポジトリのソースコードは MIT ライセンスです。データのライセンスは上表のとおり、各提供元の条件に従います。
