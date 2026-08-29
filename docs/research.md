# 事前技術調査 (research.md)

本ドキュメントは、実装に着手する前に行った技術・データ・ライセンス調査の結果である。
調査日: **2026-08-28**（各サービスの仕様は変わりうるため、URL を必ず一次情報として参照すること）

検証方法: 実際に HTTP リクエストを送り、レスポンスを確認したものは「実測」と明記する。

---

## 1. CesiumJS

| 項目 | 内容 |
| --- | --- |
| 技術名 | CesiumJS (`cesium` / `@cesium/engine`) |
| 公式 URL | https://cesium.com/platform/cesiumjs/ / https://cesium.com/learn/cesiumjs/ref-doc/ |
| ライセンス | Apache License 2.0 |
| 現在のバージョン | **1.144.0**（2026-08 リリース。`@cesium/engine` は 26.1.0） |
| 用途 | 地球規模の 3D 地理空間レンダリング、3D Tiles / quantized-mesh terrain / glTF の描画、カメラ制御 |
| メリット | 3D Tiles のリファレンス実装。WGS84 楕円体・地形・大気散乱・日照計算が標準搭載。日本の PLATEAU が公式に 3D Tiles を配信しており相性が良い。Cesium ion に依存せず自前タイル/自前地形のみで動作可能 |
| デメリット | バンドルが大きい（Workers/Assets を静的配信する必要がある）。React/Next.js と組み合わせる際に SSR を無効化する必要がある。マテリアル表現は Three.js ほど自由ではない |

実装上の重要点（公式リファレンスで確認済み）:

- `Viewer` オプション: `baseLayer: ImageryLayer | false`, `terrainProvider: TerrainProvider`, `terrain: Terrain`,
  `geocoder: boolean|…`, `baseLayerPicker: boolean`, `animation`, `timeline`, `sceneModePicker`,
  `requestRenderMode: boolean`, `contextOptions: ContextOptions`, `msaaSamples: number`(既定 4),
  `shadows: boolean`, `useBrowserRecommendedResolution: boolean`(既定 true)。
- **`baseLayer` と `terrain` を明示指定すれば Cesium ion のトークンは不要**。本プロジェクトは既定で ion を使わない
  （ion トークンは任意の環境変数で、指定時のみ World Imagery 等を有効化）。
- `Cesium3DTileset.fromUrl(url, options)` が現行 API（コンストラクタ直呼びは非推奨）。
- `maximumMemoryUsage` は 1.107 で非推奨・1.110 で削除。**`cacheBytes` / `maximumCacheOverflowBytes` を使う**。
- LOD 制御は `maximumScreenSpaceError`（SSE）。モバイルでは大きめの値にする。

参考: https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html , https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html

---

## 2. 3D Tiles

| 項目 | 内容 |
| --- | --- |
| 技術名 | OGC 3D Tiles 1.0 / 1.1 |
| 公式 URL | https://www.ogc.org/standard/3dtiles/ , https://github.com/CesiumGS/3d-tiles |
| ライセンス | 仕様は OGC 標準（オープン仕様）、実装は Apache-2.0 |
| 現在のバージョン | 1.1（1.0 も広く流通。PLATEAU は原則 1.0、2025 年度以降調査分の一部が 1.1） |
| 用途 | 大規模 3D 都市モデルの階層的ストリーミング配信 |
| メリット | 階層 LOD + geometricError による SSE 駆動の描画で「東京全体を一度にロードしない」を仕組みとして保証できる。b3dm/glTF ベースで PBR マテリアルが使える |
| デメリット | CityGML からの変換パイプラインが必要（PLATEAU 配信サービスを使えば回避できる）。タイル境界での見た目のポップが起きうる |

---

## 3. Project PLATEAU（国土交通省 3D 都市モデル）

| 項目 | 内容 |
| --- | --- |
| 技術名 | Project PLATEAU / PLATEAU 配信サービス |
| 公式 URL | https://www.mlit.go.jp/plateau/ , 配信サービス: https://docs.plateauview.mlit.go.jp/ |
| ライセンス | **CC BY 4.0**（政府標準利用規約と互換。ODC BY / ODbL での利用も妨げない）。出典表示が必須。編集・加工した場合はその旨の明記が必要で、国土交通省が作成したかのような表示は禁止 |
| 現在の状況 | 2021 年度 56 都市から拡大し、2025 年度末で約 300 都市規模。東京 23 区は整備済み |
| 用途 | 実在建物の 3D 形状（LOD1 / LOD2）、地形 |
| メリット | 実測ベースの実在建物形状。3D Tiles で直接配信されており変換不要で使える。LOD 指定が URL の spec で可能 |
| デメリット | 配信サービスは「実験的」で SLA なし・予告なく更新される。テクスチャ付き LOD2 は重い。屋内・詳細度は地域差が大きい |

### 実測した配信エンドポイント

- データカタログ API: `GET https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`
- 3D Tiles: `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{spec}/tileset.json`
  - spec 形式: `<area>-<type>-lod<N>[-notexture]-<year>`（`maxlod<N>` と `latest` も可）
  - **実測 200 OK**:
    - `all-bldg-maxlod2-latest`（全国コンポジット）
    - `13-bldg-maxlod2-latest`（東京都）
    - `13101-bldg-maxlod2-latest`（千代田区）/ `13103-bldg-maxlod2-latest`(港区) / `13101-bldg-maxlod1-latest`
  - `13101-bldg-lod1`（年指定なし）は 400 エラー。**spec の年 or `latest` は必須**
  - CORS: `access-control-allow-origin: *`（実測）
- MVT: `https://api.plateauview.mlit.go.jp/datacatalog/mvt/{spec}/tilejson.json`
- 地形 (**PLATEAU-Terrain**): `https://tile.plateauview.mlit.go.jp/terrain/layer.json`
  - 形式 quantized-mesh-1.0 + `octvertexnormals`、全国、楕円体高、maxzoom 18（**実測 200 OK**）
  - `layer.json` の `attribution` に `PLATEAU | Mapterhorn | 国土地理院` が入っている → そのまま UI に表示する

→ **結論**: CityGML → 3D Tiles の自前変換は「必須ではない」。MVP は公式配信をそのまま使い、
自前変換パイプライン（PLATEAU CityGML → 3D Tiles）は `scripts/convert-plateau` にオプションとして用意する
（配信サービスが実験的である以上、自前ホスティング経路を残すのは妥当）。

---

## 4. OpenStreetMap

| 項目 | 内容 |
| --- | --- |
| 技術名 | OpenStreetMap データ / Overpass API / Nominatim |
| 公式 URL | https://www.openstreetmap.org/copyright , https://wiki.openstreetmap.org/wiki/Overpass_API , https://nominatim.org/ |
| ライセンス | **ODbL 1.0**（データ）。表示は `© OpenStreetMap contributors` が必須。派生 DB を公開する場合は share-alike 義務 |
| 用途 | 道路ネットワーク、歩道、横断歩道、信号、POI、駅、施設 |
| メリット | 日本国内のカバレッジが良好。Overpass で範囲・タグ指定の取得ができる。Valhalla の入力そのもの |
| デメリット | 公開 Overpass / Nominatim は fair use（Nominatim は 1 req/s・User-Agent 必須）。本番はセルフホストが前提 |

実測:
- Nominatim: `https://nominatim.openstreetmap.org/search?q=東京駅&format=jsonv2&accept-language=ja` → **200 OK**（`licence` に ODbL 表記あり）
- Overpass: 本開発サンドボックスのネットワークからは `overpass-api.de` / `kumi.systems` / `private.coffee` いずれも到達不可
  （プロキシ制限とみられる）。**アプリ側はエンドポイントを環境変数で差し替え可能にし、失敗時は POI 機能のみ
  グレースフルに劣化させる設計とする**。Vercel 等の通常のネットワークからは到達できる想定。

---

## 5. 国土地理院（GSI）

| 項目 | 内容 |
| --- | --- |
| 技術名 | 地理院タイル |
| 公式 URL | https://maps.gsi.go.jp/development/ichiran.html , 規約 https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html |
| ライセンス | 国土地理院コンテンツ利用規約。**ウェブ地図としてリアルタイム読み込みする場合は出典明示のみで申請不要**。出典は「国土地理院」または「地理院タイル」 |
| 用途 | ベースマップ（`std` / `pale` / `seamlessphoto`）、標高タイル `dem_png` |
| メリット | 日本国内で最も信頼できる公的地図。CORS 許可あり（実測 `access-control-allow-origin: *`）。無料・申請不要 |
| デメリット | 世界カバレッジなし。標高タイルを terrain にするには変換 or 専用 Provider が必要 |

実測: `https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png` 200 OK / CORS `*`、`dem_png` も 200 OK。

地形については **PLATEAU-Terrain（quantized-mesh、内部で GSI 由来）** を第一候補とし、
GSI `dem_png` からの自前 terrain 生成（`cesium-gsi-terrain` 相当）は代替案として記録する。

---

## 6. Valhalla（ルーティング）

| 項目 | 内容 |
| --- | --- |
| 技術名 | Valhalla |
| 公式 URL | https://valhalla.github.io/valhalla/ , https://github.com/valhalla/valhalla |
| ライセンス | MIT |
| 現在のバージョン | 3.x 系（Docker: `ghcr.io/valhalla/valhalla`, ビルド済み配布 `ghcr.io/nilsnolde/docker-valhalla/valhalla`） |
| 用途 | 自動車・徒歩・自転車・マルチモーダルの経路探索、ターンバイターン案内、Map Matching、Isochrone |
| メリット | タイル方式で軽量、`costing` 切替が容易、`auto/pedestrian/bicycle/multimodal` を単一 API で扱える。**案内文の日本語（`language: ja-JP`）に対応**。maneuver に `type` / `bearing_after` / `street_names` があり 3D ナビカメラ制御に必要な情報が揃う |
| デメリット | 自前構築には OSM PBF からのタイルビルド（東京圏でも数十分〜）が必要。公開デモサーバは 1 req/user/sec の制限あり |

実測: `https://valhalla1.openstreetmap.de/route`（FOSSGIS デモ）に
`costing=pedestrian`, `language=ja-JP` でリクエスト → **200 OK**、日本語の `instruction` を含む JSON を取得。
デモサーバ利用時は `X-Client-Id` ヘッダの付与が求められている（実装済み）。

比較検討:

| エンジン | 長所 | 短所 | 判断 |
| --- | --- | --- | --- |
| **Valhalla** | 動的コスティング、マルチモーダル、日本語案内、Map Matching | セットアップやや重い | **第一候補（採用）** |
| OSRM | 極めて高速、実績多数 | プロファイルが静的、モード毎に別プロセス、案内の多言語が弱い | フォールバックとして実装 |
| GraphHopper | 公共交通(GTFS)、柔軟 | JVM 前提、無料 API 制限 | 将来の公共交通拡張時に再評価 |

---

## 7. PostgreSQL / PostGIS

| 項目 | 内容 |
| --- | --- |
| 技術名 | PostgreSQL + PostGIS |
| 公式 URL | https://postgis.net/ |
| ライセンス | PostgreSQL License / GPL-2.0（PostGIS） |
| 現在のバージョン | PostgreSQL 17、PostGIS 3.5 系（Docker: `postgis/postgis:17-3.5`） |
| 用途 | OSM 由来の道路ネットワーク・POI・交差点の永続化と空間検索、`ST_Transform` による座標系変換 |
| メリット | 空間インデックス(GiST)、`ST_DWithin` による近傍検索、`ST_Transform` が EPSG:6668/6669-6687（JGD2011 平面直角座標系）を標準サポート |
| デメリット | Vercel 単体では動かない（外部マネージド or 自前ホストが必要）。MVP のデモ経路では必須ではない |

→ **設計判断**: PostGIS は「セルフホスト構成（Docker Compose / apps/api）」で使用し、
Vercel デモは PostGIS 非依存（Overpass / Nominatim / Valhalla への委譲）で動作するようにする。

---

## 8. WebGL / WebGPU の現状

| 項目 | 内容 |
| --- | --- |
| WebGL2 | 全主要ブラウザで利用可能。iOS Safari も対応済み。**本プロジェクトの実行基盤** |
| WebGPU | Chrome/Edge は安定、Safari も 26 系以降で提供。ただし **CesiumJS のレンダラは WebGL2 ベース**で、WebGPU バックエンドは未完 |
| 判断 | WebGL2 前提で実装。`contextOptions.requestWebgl2: true`。将来 Cesium が WebGPU に対応したら差し替えられるよう、レンダラ設定は `map-engine` の 1 箇所に集約する |

iOS（iPhone 17 想定）についての方針:
- 画質は落とさない。`useBrowserRecommendedResolution: false` + `resolutionScale` を devicePixelRatio 由来で最大 2.0 まで許容。
- MSAA は 4x（A シリーズ GPU は十分処理できる）。ただし発熱・電力を考慮し FXAA と併用しない。
- テクスチャメモリは `cacheBytes` を端末メモリ推定から決定する。
- iOS Safari 固有: `preserveDrawingBuffer` は使わない（メモリ増）、`WebGL context lost` のハンドラを必ず入れる。

---

## 9. AI（LLM）プロバイダ

| 項目 | 内容 |
| --- | --- |
| 対象 | OpenAI (Responses/Chat Completions), Anthropic (Messages API), Google Gemini (generateContent), ローカル (Ollama / llama.cpp などの OpenAI 互換 `/v1/chat/completions`) |
| ライセンス | 各社の利用規約に従う。ローカルモデルはモデルごとのライセンスに従う |
| 用途 | 自然言語 → **Tool Calling** による地図操作（AI が直接 Cesium を触ることはしない） |
| メリット | 抽象化すればプロバイダ差し替えが可能。tool calling は 4 系統とも同等の概念を持つ |
| デメリット | tool calling の JSON スキーマ形式が各社で微妙に異なる → アダプタで吸収する必要がある |
| 判断 | **`AIProvider` インタフェース**を自前定義し、`OpenAIProvider` / `AnthropicProvider` / `GeminiProvider` / `LocalProvider` を実装。SDK に依存せず `fetch` のみで実装し、依存とバンドルを最小化する。プロバイダ名は環境変数 `AI_PROVIDER` で決定し、コードにハードコードしない |

---

## 10. AI による 3D アセット生成

| 項目 | 内容 |
| --- | --- |
| 対象 | テキスト/画像 → 3D 生成（例: Meshy, Tripo, Luma, Stable Fast 3D 等）、および手続き生成 |
| 出力形式 | **glTF 2.0 / GLB**、PBR マテリアル（metallic-roughness） |
| 用途（許可） | 街路樹、街灯、標識、ベンチ、車両、自転車、小物などの**視覚的補完アセット** |
| 用途（禁止） | 実在建物の位置・形状の捏造。実在建物は必ず PLATEAU/OSM の実データを使う |
| ライセンス上の注意 | 生成サービスの出力ライセンス、学習データ由来の権利、商用可否をアセット単位で `data/assets/LICENSES.md` に記録する。**ライセンス不明のモデルは同梱しない** |
| MVP での判断 | 外部生成物を同梱せず、**OSM の実データ（`natural=tree`, `highway=street_lamp` 等）が示す実在位置に、手続き生成した軽量プレースホルダを instancing で配置**する。位置は実データ、見た目のみ合成、という切り分けにする |

---

## 11. 大量 3D Tiles をブラウザで表示する最適化

| 手法 | 実装方針 |
| --- | --- |
| 3D Tiles + SSE | `maximumScreenSpaceError` を端末ティア別に設定（desktop 8 / iOS 12 / low 24） |
| LOD 戦略 | 遠景: LOD1 テクスチャ無し / 中景: `maxlod2` / 近景: LOD2。距離ではなく**タイルセットを 2 系統読み込み、SSE と表示距離で切り替える** |
| frustum culling | Cesium 標準。`cullWithChildrenBounds`, `cullRequestsWhileMoving` を有効化 |
| メモリ | `cacheBytes` / `maximumCacheOverflowBytes` を端末ティア別に設定 |
| lazy / progressive | `preloadWhenHidden: false`, `preferLeaves: true`, `progressiveResolutionHeightFraction` |
| 地理的範囲制限 | **都市レジストリ**（`packages/shared/cities.ts`）で bbox を持ち、`clippingPolygons` / bbox 外はロードしない。初回に日本全国をロードしない |
| instancing | 街路樹・街灯は `ModelInstanceCollection` 相当（`Cesium3DTileset` の i3dm もしくは `PointPrimitiveCollection`/`Model` インスタンス）で描画 |
| texture compression | 3D Tiles 側が KTX2/Basis を含む場合は `Cesium` が自動対応。自前変換時は KTX2 出力を推奨 |
| 描画負荷制御 | `requestRenderMode: true`（ナビ中は解除）、`targetFrameRate`、`maximumRenderTimeChange` |

---

## 12. 参照した一次情報

- CesiumJS リリース: https://cesium.com/blog/2026/08/04/cesium-releases-in-august-2026/
- CesiumJS API: https://cesium.com/learn/cesiumjs/ref-doc/
- PLATEAU 配信サービス: https://docs.plateauview.mlit.go.jp/
- PLATEAU-Terrain: https://docs.plateauview.mlit.go.jp/datasets/terrain/
- PLATEAU サイトポリシー: https://www.mlit.go.jp/plateau/site-policy/
- OSM 著作権: https://www.openstreetmap.org/copyright
- OSMF API 利用ポリシー: https://operations.osmfoundation.org/policies/api/
- 国土地理院コンテンツ利用規約: https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
- 地理院タイル一覧: https://maps.gsi.go.jp/development/ichiran.html
- Valhalla Docs: https://valhalla.github.io/valhalla/
- FOSSGIS Valhalla デモ: https://valhalla.openstreetmap.de/
- PostGIS: https://postgis.net/

---

## 13. 調査から確定した設計上の結論

1. **Cesium ion に依存しない**構成が可能（地図=地理院タイル、地形=PLATEAU-Terrain、建物=PLATEAU 3D Tiles）。
2. CityGML → 3D Tiles の自前変換は MVP では不要。ただし配信サービスは実験的なので、**自前変換・自前ホスト経路をスクリプトとして用意**する。
3. ルーティングは Valhalla を採用。Vercel デモでは FOSSGIS 公開デモ、セルフホストでは Docker の Valhalla を使い、**同じ `RouteProvider` インタフェース**で切り替える。
4. PostGIS は必須ではなく、セルフホスト時の道路ネットワーク/POI 永続層として使う。**Vercel デモは PostGIS 無しで完動**させる。
5. Overpass は公開エンドポイントの可用性が読めないため、**エンドポイント差し替え + 失敗時のグレースフルデグレード**を必ず入れる。
6. すべてのデータ表示に**出典表示 UI を実装**する（OSM / PLATEAU / 国土地理院 / Mapterhorn / Valhalla）。

---

## 14. 追加調査（2026-08-29 実施）— デプロイと最新動向

### Vercel のフレームワーク検出と Root Directory

| 項目 | 内容 |
| --- | --- |
| 公式 URL | https://vercel.com/docs/builds/configure-a-build |
| 検出方法 | **Root Directory にある `package.json` の `dependencies` / `devDependencies` に `next` があるか**で判定する |
| Build Command | 既定で `package.json` の `build` スクリプトが使われる（無ければ `next build`）。→ `prebuild` フックも実行される |
| Install Command | `devDependencies` を含めてインストールする。インストール先は Root Directory |

**設計に直結した重要な制約**（公式ドキュメントの原文）:

> Your app will not be able to access files outside of that directory.
> You also cannot use `..` to move up a level.

Root Directory を `apps/web` のようなサブディレクトリに設定すると、
**その外にある `packages/*` や `scripts/` を参照できず、`cd ../..` による回避もできない。**

→ npm workspaces のモノレポでアプリをサブディレクトリに置く構成は、
   この制約と正面衝突する。本プロジェクトが **Next.js アプリをリポジトリ直下に置き、
   `packages/*` を `file:` 依存で参照する**構成にした理由がこれ。

### Vercel の Node.js バージョン

| 項目 | 内容 |
| --- | --- |
| 公式 URL | https://vercel.com/docs/functions/runtimes/node-js/node-js-versions |
| サポート | 24.x / 22.x / 20.x |
| 既定 | 新規プロジェクトは利用可能な最新 LTS |
| 注意 | **Node.js 20 は 2026-10-01 に非推奨化**（Node 20 の EOL 2026-04-30 の 5 か月後） |

→ `engines.node` を `>=22` に、`.nvmrc` を `22` にして 20 系が選ばれないようにした。

### Vercel Functions の実行時間上限

| プラン | Fluid compute 有効時の上限 |
| --- | --- |
| Hobby | 300 秒 |
| Pro / Enterprise | 800 秒（1800 秒はベータ） |

公式 URL: https://vercel.com/docs/functions/limitations

→ 本アプリの設定は最大 60 秒（AI）なので、どのプランでも上限に触れない。

### CesiumJS の最新版

2026-08-29 時点の最新は **1.144.0**（本プロジェクトが固定しているバージョン）。
1.143 で `KHR_meshopt_compression` glTF 拡張に対応。1.145 は未リリース。

公式 URL: https://github.com/CesiumGS/cesium/releases

### Next.js の最新動向

- **Next.js 16 から Turbopack が既定のバンドラ**（本プロジェクトもそのまま使用）
- 16.3 系では開発時のメモリ使用量削減とビルド高速化、Instant Navigations が追加
- 16 で Build Adapters API が追加され、ホスティング事業者側の統合が容易に

公式 URL: https://nextjs.org/blog

### PLATEAU の整備状況（PLATEAU ビジョン 2026）

| 項目 | 内容 |
| --- | --- |
| 2025 年度末時点 | **329 都市**の 3D 都市モデルを整備済み |
| 2027 年度末目標 | 500 都市 |
| 2032 年度末目標 | 更新率 100%、デジタルツイン実装都市 100% |
| 技術動向 | 衛星データ・スマホ画像と AI による「3D 都市モデル自動作成」「テクスチャ自動付与」の開発が進行 |

出典: 国土交通省 PLATEAU（https://www.mlit.go.jp/plateau/）、PLATEAU ビジョン 2026 の報道

→ 都市レジストリ（`packages/shared/src/cities.ts`）にエントリを足すだけで拡張できる設計にしてあるため、
   整備都市の増加にはそのまま追随できる。追加時は `npm run validate:cities` で
   実際に配信されているか（HTTP 200 かつタイルセットが空でないか）を確認すること。


---

## iOS / WebKit の WebGL 制約（2026-08-29 調査）

iPhone でページを開いた直後に落ちる件を調べた結果、CesiumJS 側ではなく
**WebKit（iOS Safari）の WebGL 実装に起因する既知の問題**が確認できた。
iOS 版の Chrome・Firefox も中身は WebKit なので、同じ制約を受ける。

### 症状と原因

| 項目 | 内容 |
| --- | --- |
| 症状 | 3D シーンの初期化直後に WebGL コンテキストが失われ、ページが落ちる |
| 原因 | 1 フレームで GPU に大量の描画コマンドを投入すると、Metal 側で `kIOGPUCommandBufferCallbackErrorHang` が発生する |
| 経緯 | 以前はこのカーネルエラーが無視されていた。WebKit の修正（r257584）以降は正しくコンテキスト喪失として扱われるため、表面化した |
| 影響 | iOS 18.2 以降。iPad 9th/Pro、iPhone SE/11/12/XR など広範囲で報告。iOS 26 では改善が報告されている |
| WebKit の回答 | 「`WebGLRenderingContext.flush()` を呼んでコマンドバッファを分割せよ」。WebKit/ANGLE は作業量を判断できないため自動分割はしない |

- WebKit Bug 290752: https://bugs.webkit.org/show_bug.cgi?id=290752
- Cesium Community「Crashing on iOS 18.2 and 18.3 on specific devices」: https://community.cesium.com/t/crashing-on-ios-18-2-and-18-3-on-specific-devices/39615
- Cesium Community「WebGL issue constructing CesiumWidget - iOS 18.6」: https://community.cesium.com/t/webgl-issue-constructing-cesiumwidget-ios-18-6/43520
  （`aliasedLineWidthRange[0]` で初期化に失敗する事例。OS 更新で解消）

### 本アプリでの対応

1. **毎フレーム `gl.flush()`**（iOS のみ）。WebKit 推奨の回避策そのもの
2. **iOS 既定でポストプロセスを外す**。MSAA・HDR・環境光遮蔽・ブルームは
   1 パスごとに描画コマンドを積み増すため、この上限に直接効く。
   Retina では 1 画素が小さく寄与も見えにくいので、失うものが少ない
3. **Retina 解像度（`resolutionScale` 2.0）は維持**。見た目の精細さはここが効くので、
   品質の要は落としていない。ポストプロセスは「表示設定 → 描画品質 → 高品質」で有効にできる
4. **コンテキスト喪失時は自動でセーフモードに開き直す**（`sessionStorage` で 1 回に制限）


---

## PLATEAU の実データ監査（2026-08-29）

「浜松が東京ほどきれいに見えない」原因を切り分けるため、
タイルを実際にダウンロードして中身を解析した。推測ではなく実測値。

### 建物モデルの比較

| | 東京（中央区・2025年度） | 浜松（旧中区・2023年度） |
| --- | --- | --- |
| テクスチャ | WebP を埋め込み（1 タイル約 969KB） | **なし**（images: 0 / textures: 0） |
| 圧縮 | Draco | Draco |
| geometricError 最小 | 88.4 | **49.4**（浜松の方が細かい） |
| 1 タイル平均 | 1,505 KB | 1,014 KB |
| 最大深度 | 4 | 4 |

配布 ZIP（1.4GB）の中身も HTTP Range で中央ディレクトリだけ読んで確認した。
`.b3dm` 64,823 件 / `.mvt` 22,900 件 / `.json` 75 件で、**画像ファイルは 1 枚も無い**。
静岡市（同じ 2023 年度）も同様。つまり浜松に実写テクスチャ付きモデルは存在しない。

一方、浜松が優れている点もある。

| | 東京 | 浜松 |
| --- | --- | --- |
| 地形（PLATEAU Terrain） | z14 まで | **z18 まで** |
| 航空写真（地理院） | z18 | z18 |

### 建物の属性

浜松の b3dm には 27 個の属性が入っている。主なもの:

```
bldg:usage            用途区分
bldg:measuredHeight   実測高さ
uro:BuildingDetailAttribute_uro:buildingRoofEdgeArea  屋根面積
uro:BuildingIDAttribute_uro:buildingID                建物 ID
```

旧中区 1,292 棟の用途分布:
住宅 56.4% / 共同住宅 13.0% / 不明 9.1% / 商業施設 7.9% / 業務施設 3.1% /
店舗等併用住宅 2.9% / 運輸倉庫施設 2.4% / 店舗等併用共同住宅 1.7% /
文教厚生施設 1.7% / 工場 1.2%

テクスチャが無い都市では、この用途と実測高さで塗り分けている
（実在の色を推測するのではなく、実データの用途を色で示す位置づけ）。

### OSM の補完データ（浜松駅周辺 1.2km 四方）

PLATEAU に無いものを OSM で補える。

```
建物 2,989（階数あり 253 / 高さあり 3 / 色あり 4）
道路 994（橋 26 / 高架 23 / トンネル 24 / 車線数あり 71）
鉄道 59（橋 50 / 高架 46）   ← 東海道新幹線・東海道本線・遠州鉄道
信号 85 / 横断歩道 223 / 街路樹 35
```

鉄道の高架が街の骨格になっているため、これを立体化しないと
道路が地面に張り付いたままの見た目になる。

### タイリング方式の注意点

quantized-mesh（地形）は Web メルカトルではなく**地理座標系の 2×1 タイリング**を使う。
z レベルで x は 2^(z+1) 分割、y は 2^z 分割。
Web メルカトルの座標で問い合わせると全て 404 になり、
「地形が配信されていない」と誤診する。
