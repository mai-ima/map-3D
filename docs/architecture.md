# Immersive Japan Map — アーキテクチャ設計書

実装開始前の設計。要求された 13 項目に対応する。
前提となる調査結果は [research.md](./research.md) を参照。

---

## 1. システム全体のアーキテクチャ

```
                        ┌──────────────────────────────────────────┐
                        │  Browser (PC / iPhone Safari)            │
                        │                                          │
  ユーザー操作 ───────► │  Next.js App Router（リポジトリ直下）      │
                        │   ├─ UI Layer (React / Tailwind)         │
                        │   │    SearchBar / NextTurnPanel /       │
                        │   │    TimeOfDay / AttributionPanel      │
                        │   ├─ packages/ui                         │
                        │   ├─ packages/navigation                 │
                        │   │    NavigationCamera (状態機械)        │
                        │   │    RouteFollower / ManeuverPlanner   │
                        │   └─ packages/map-engine                 │
                        │        CesiumJS 1.144 (WebGL2)           │
                        └───────────┬──────────────────────────────┘
                                    │ HTTPS (自ドメインのみ)
                        ┌───────────▼──────────────────────────────┐
                        │  Next.js Route Handlers (= BFF)          │
                        │   /api/route      /api/search            │
                        │   /api/poi        /api/building          │
                        │   /api/ai/chat    /api/config            │
                        │   * APIキーはここだけに存在               │
                        └───┬─────────┬──────────┬─────────────────┘
                            │         │          │
              ┌─────────────▼──┐ ┌────▼──────┐ ┌─▼────────────────┐
              │ packages/      │ │ packages/ │ │ packages/ai      │
              │ routing        │ │ gis       │ │ AIProvider抽象   │
              │ Valhalla/OSRM  │ │ Overpass  │ │ + GeoToolRegistry│
              └───────┬────────┘ │ Nominatim │ └─┬────────────────┘
                      │          │ PLATEAU   │   │
                      │          │ GSI       │   │
                      │          └────┬──────┘   │
        ┌─────────────▼───┐  ┌────────▼──────┐ ┌─▼──────────────┐
        │ Valhalla        │  │ OSM / PLATEAU │ │ LLM API        │
        │ (Docker or      │  │ / 国土地理院  │ │ OpenAI/Anthropic│
        │  FOSSGIS demo)  │  │ 配信サービス  │ │ /Gemini/Local  │
        └─────────────────┘  └───────────────┘ └────────────────┘

        （セルフホスト時のみ）
        apps/api (Node)         ──► PostgreSQL + PostGIS
            道路ネットワーク / POI / 交差点の永続化
```

**3D データの流れ（ブラウザ直結、BFF を通さない）**

```
地理院タイル (imagery)      ──► UrlTemplateImageryProvider ──┐
PLATEAU-Terrain (地形)      ──► CesiumTerrainProvider      ──┼──► Cesium Scene
PLATEAU 3D Tiles (建物)     ──► Cesium3DTileset            ──┘
```
これらは CORS 許可済みの公開配信であり、BFF を挟むとキャッシュ効率・レイテンシが悪化するため直結する。
一方、**APIキーを要するもの・レート制限のあるもの（LLM / Overpass / Nominatim / Valhalla）は必ず BFF 経由**。

**2 つの動作モード**

| モード | 用途 | ルーティング | POI/検索 | DB |
| --- | --- | --- | --- | --- |
| `demo`（Vercel 既定） | 公開デモ | FOSSGIS Valhalla | 公開 Overpass / Nominatim | なし |
| `selfhost`（Docker） | 本番・研究 | 自前 Valhalla | 自前 Overpass or PostGIS | PostGIS |

切り替えは環境変数のみ。コードは同一。

---

## 2. 技術選定理由

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 3D エンジン | **CesiumJS 1.144** | 3D Tiles のリファレンス実装であり、PLATEAU が 3D Tiles を公式配信している。WGS84 楕円体・地形・大気散乱・太陽位置が標準搭載で「実在都市」を正確に描ける。Three.js だと測地系・地形・タイルストリーミングを全部自作することになる |
| フレームワーク | **Next.js 16 (App Router) + TypeScript** | Route Handlers が BFF になり、APIキーをサーバ側に閉じ込められる。Vercel にそのままデプロイできる |
| スタイル | **Tailwind CSS v4** | 3D キャンバス上のオーバーレイ UI を高速に組める。ビルド成果物が小さい |
| ルーティング | **Valhalla**（OSRM をフォールバック） | 動的コスティング / マルチモーダル / **日本語案内** / maneuver に `bearing_after` があり 3D カメラ制御に直結する（[research.md §6](./research.md)） |
| 地形 | **PLATEAU-Terrain** | quantized-mesh を全国配信済み。GSI DEM からの自前生成が不要で、PLATEAU 建物と同じ高さ基準（楕円体高）で整合する |
| ベースマップ | **地理院タイル** | 出典明示のみで商用利用可、CORS 許可、日本国内で最も信頼できる |
| 建物 | **PLATEAU 3D Tiles** | 実在建物の実測形状。AI 生成は使わない |
| DB | **PostgreSQL 17 + PostGIS 3.5** | `ST_Transform` が JGD2011 平面直角座標系を標準サポート。道路ネットワークのグラフ構造を保持できる |
| AI | **自前 `AIProvider` 抽象（fetch のみ）** | ベンダーロックインを避ける。SDK を入れないので Edge/Node どちらでも動き、バンドルも増えない |
| 共有ロジックの分割 | **`file:` 依存 + `transpilePackages`** | ビルドステップ無しで TS ソースを直接共有できる。npm workspaces を使わないことで、Vercel から見て「ごく普通の単一 Next.js プロジェクト」になり、フレームワーク検出が確実になる |

---

## 3. ディレクトリ構成

```
immersive-japan-map/
├── app/                         Next.js App Router（Vercel のデプロイ対象）
│   ├── page.tsx                         メイン画面
│   ├── layout.tsx
│   └── api/
│       ├── route/route.ts               経路探索
│       ├── search/route.ts              地名検索
│       ├── poi/route.ts                 周辺検索
│       ├── building/route.ts            建物情報
│       ├── furniture/route.ts           街路樹・街灯の実在位置
│       ├── config/route.ts              公開設定の配信
│       └── ai/chat/route.ts             AI Tool Calling
├── components/                  画面固有 React コンポーネント
├── lib/                         BFF クライアント・スタブ
├── public/                      Cesium の静的アセット（prebuild で生成）
├── apps/
│   └── api/                     セルフホスト用スタンドアロン API (node:http)
├── packages/
│   ├── shared/                  型・座標系・幾何・都市レジストリ・アイコン形状
│   ├── gis/                     Overpass / Nominatim / PLATEAU / GSI クライアント
│   ├── routing/                 RouteProvider 抽象 + Valhalla / OSRM 実装
│   ├── navigation/              NavigationCamera 状態機械・RouteFollower（Cesium 非依存）
│   ├── map-engine/              Cesium ラッパ（シーン構築・レイヤ・品質・時間・天候）
│   ├── ai/                      AIProvider 抽象 + GeoTool 定義・実行器
│   └── ui/                      共有 UI プリミティブ・SVG アイコン
├── data/                        osm/ plateau/ terrain/ tiles/（.gitignore）
├── scripts/                     import-osm / convert-plateau / generate-tiles / preprocessing
├── docker/                      Dockerfile 群 + docker-compose.yml
├── docs/                        research.md / architecture.md / data-pipeline.md /
│                                deploy-vercel.md / licenses.md
├── next.config.ts / vercel.json / tsconfig.json
└── README.md
```

**依存の向き（循環禁止）**

```
shared ← gis ← routing
   ↑       ↑      ↑
   └── navigation ┘
   ↑
map-engine (Cesium はここだけ) ,  ai ,  ui
                      ↑
                  app/ (Next.js)
```

`navigation` は **Cesium に依存しない**（純粋な数学と状態機械）。
Cesium への適用は `map-engine` 側のアダプタが行う。これによりナビロジックを単体テストできる。

---

## 4. 必要な外部データ

| データ | 提供元 | 形式 | 取得方法 | MVP |
| --- | --- | --- | --- | --- |
| 3D 建物 | PLATEAU 配信サービス | 3D Tiles 1.0/1.1 | `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/{spec}/tileset.json` | 必須 |
| 地形 | PLATEAU-Terrain | quantized-mesh 1.0 | `https://tile.plateauview.mlit.go.jp/terrain/` | 必須 |
| ベースマップ | 国土地理院 | ラスタタイル PNG | `https://cyberjapandata.gsi.go.jp/xyz/{style}/{z}/{x}/{y}.png` | 必須 |
| 標高（代替） | 国土地理院 | `dem_png` | 同上 `dem_png` | ー |
| 道路網・POI | OpenStreetMap | Overpass JSON / PBF | Overpass API / Geofabrik | 必須 |
| ジオコーディング | Nominatim (OSM) | JSON | `nominatim.openstreetmap.org` | 必須 |
| 経路 | Valhalla (OSM 由来) | JSON | FOSSGIS デモ or 自前 | 必須 |
| CityGML 原本 | PLATEAU / G空間情報センター | CityGML 2.0 | 手動 DL → `data/plateau/` | 任意 |

---

## 5. 各データのライセンス

| データ | ライセンス | 表示義務 | 備考 |
| --- | --- | --- | --- |
| PLATEAU 3D 都市モデル | **CC BY 4.0**（政府標準利用規約互換、ODC BY/ODbL 可） | 「3D都市モデル Project PLATEAU（国土交通省）」 | 加工した場合は加工した旨の明記が必要。国交省が作成したかのような表示は禁止 |
| PLATEAU-Terrain | 上記に準拠 | `PLATEAU / Mapterhorn / 国土地理院`（layer.json の attribution をそのまま表示） | |
| OpenStreetMap | **ODbL 1.0** | 「© OpenStreetMap contributors」 | 派生 DB を配布する場合 share-alike |
| Nominatim / Overpass 経由の OSM 派生物 | ODbL 1.0 | 同上 | 公開インスタンスは fair use |
| 地理院タイル | 国土地理院コンテンツ利用規約 | 「国土地理院」または「地理院タイル」 | Web でのリアルタイム読込は申請不要 |
| Valhalla（ソフト） | MIT | ー | 経路結果は OSM 由来 → ODbL 表示が必要 |
| CesiumJS | Apache-2.0 | ー | |
| 生成 3D アセット | アセット毎に確認し `data/assets/LICENSES.md` に記録 | 必要に応じ | **ライセンス不明なものは使用しない** |

UI 実装: 画面右下に常時「データ出典」ボタン、タップで全ライセンスを列挙するパネルを開く。

---

## 6. データ変換パイプライン

```
[A] 配信利用ルート（MVP 既定・変換なし）
  PLATEAU 配信サービス (3D Tiles) ─────────────► CesiumJS
  PLATEAU-Terrain (quantized-mesh) ────────────► CesiumJS
  地理院タイル (PNG) ──────────────────────────► CesiumJS

[B] 自前変換ルート（scripts/、セルフホスト用）
  Raw CityGML (PLATEAU)
      ↓ scripts/preprocessing/validate.ts        構造・必須属性の検証
      ↓                                          （不正データは変換せず記録）
      ↓ 正規化                                   属性名・LOD・都市コードの正規化
      ↓ 座標系                                   JGD2011(平面直角) → EPSG:6668 → WGS84
      ↓ scripts/convert-plateau                  CityGML → 3D Tiles (plateau-3dtiles-converter / py3dtiles)
      ↓ 最適化                                   Draco 圧縮 / KTX2 テクスチャ / geometricError 調整
      ↓ scripts/generate-tiles                   tileset.json の階層生成
  data/tiles/{city}/bldg/{lod}/tileset.json
      ↓ 静的配信 (nginx / S3 / R2)
  CesiumJS

[C] OSM ルート
  Geofabrik PBF (kanto-latest.osm.pbf)
      ↓ scripts/import-osm                        osm2pgsql or osmium + 自前パーサ
      ↓ 検証・正規化                              tag → 内部スキーマ
      ↓ 道路ネットワーク化                        way → edge / node → intersection|crossing|signal
  PostGIS (roads / nodes / pois)
      ↓                                           Valhalla は同じ PBF からタイル生成
  apps/api ──► /api/poi, /api/building
```

**再現性**: 各スクリプトは冪等で、入力ハッシュと出力を `data/**/manifest.json` に記録する。

---

## 7. API 設計

すべて `app/api/**`（Vercel）と `apps/api`（セルフホスト）で**同一のハンドラ実装を共有**する。

### `GET /api/route`
```jsonc
// 入力（query or POST body）
{ "from": {"lat":35.6812,"lng":139.7671}, "to": {"lat":35.6895,"lng":139.6917}, "mode": "walk" }
// mode: "walk" | "drive" | "bicycle" | "transit"(将来) | "multimodal"(将来)
```
```jsonc
// 出力
{
  "geometry": "polyline6 encoded string",
  "coordinates": [[139.7671,35.6812], ...],   // 描画用に展開済み
  "distance": 1234,          // m
  "duration": 900,           // s
  "mode": "walk",
  "steps": [ { "index":0, "distance":120, "duration":90, "streetName":"丸の内仲通り",
               "beginIndex":0, "endIndex":12 } ],
  "maneuvers": [ { "type":"turn_right", "instruction":"右折して丸の内仲通りに入ります",
                   "location":{"lat":..,"lng":..}, "bearingBefore":10, "bearingAfter":100,
                   "distanceToNext":80, "streetName":"丸の内仲通り", "shapeIndex":12 } ],
  "bbox": [minLng,minLat,maxLng,maxLat],
  "attribution": ["© OpenStreetMap contributors", "Powered by Valhalla"]
}
```

### `GET /api/search?q=東京駅&near=35.68,139.76&limit=8`
→ `{ results: [{ name, address, lat, lng, category, source }], attribution: [...] }`

### `GET /api/poi?lat=&lng=&radius=&categories=cafe,convenience`
→ `{ pois: [{ id, name, category, lat, lng, tags }], attribution: [...] }`

### `GET /api/building?lat=&lng=` / `?osmId=`
→ OSM の建物タグ + PLATEAU 属性（取得できる範囲）

### `GET /api/config`
→ クライアントに渡してよい公開設定のみ（タイル URL、既定都市、有効機能フラグ）。**秘密情報は返さない**。

### `POST /api/ai/chat`
```jsonc
{ "messages":[{"role":"user","content":"東京駅から皇居まで歩いて"}],
  "mapContext": { "camera": {...}, "center": {...}, "activeRoute": {...} } }
```
→ `{ "reply": "...", "toolCalls":[...], "uiCommands":[ {"type":"showRoute","payload":{...}} ] }`

---

## 8. Cesium の 3D 表示設計

```ts
createViewer({
  baseLayer: ImageryLayer(UrlTemplateImageryProvider(地理院タイル pale/std)),
  terrainProvider: await CesiumTerrainProvider.fromUrl(PLATEAU_TERRAIN, {requestVertexNormals:true}),
  geocoder:false, baseLayerPicker:false, animation:false, timeline:false, sceneModePicker:false,
  homeButton:false, navigationHelpButton:false, infoBox:false, selectionIndicator:false,
  msaaSamples: tier.msaa,                 // desktop 4 / iOS 4 / low 1
  requestRenderMode: true,                // ナビ中は false に切替
  useBrowserRecommendedResolution: false, // iPhone で resolutionScale を自前制御
  contextOptions: { requestWebgl2: true, webgl: { powerPreference: "high-performance",
                                                  alpha:false, antialias:false } }
})
```

- **建物**: `Cesium3DTileset.fromUrl` を LOD 別に 2 レイヤ
  - 近中景: `{cityCode}-bldg-maxlod2-latest`（SSE 小、`cacheBytes` 大）
  - 遠景: `{prefCode}-bldg-maxlod1-latest`（SSE 大、テクスチャ無し、薄い自己発光マテリアル）
  - 距離で `show` を切り替え、二重描画を避ける
- **スタイル**: `Cesium3DTileStyle` で高さ別の色付け（LOD1 の見栄え改善）。ナビ時は遮蔽建物のみ `color: color("white", 0.25)` に切替
- **ライティング**: `scene.globe.enableLighting = true`, `scene.light = new SunLight()`, `viewer.clock.currentTime` で時刻制御
- **大気/空**: `scene.skyAtmosphere.show`, `scene.fog.enabled`, `globe.atmosphereLightIntensity`, `scene.highDynamicRange`（対応環境のみ）
- **影**: `viewer.shadows = true`, `shadowMap.softShadows = true`, `maximumDistance` を端末ティア別に
- **ルート**: 地面追従の `GroundPolylinePrimitive`（`clampToGround`）+ 発光マテリアル。加えて路面から 0.3m 浮かせた矢印テクスチャのコリドーで進行方向を表現
- **座標**: 内部はすべて WGS84 (lon/lat/height)。表示用の変換は `packages/shared/coords.ts` に集約
- **アイコン**: 絵文字は使わない。形状データを `packages/shared/icons.ts` に一元化し、
  UI は React の SVG（`packages/ui/icons.tsx`）、3D マーカーは SVG データ URI をビルボード化
  （`packages/map-engine/marker-icons.ts`）して描く。両者の絵柄が常に一致する

---

## 9. Navigation Camera 設計

`packages/navigation/NavigationCamera.ts`（Cesium 非依存。**カメラ姿勢を計算して返すだけ**）

```
状態: FOLLOW → APPROACH_TURN → TURN → (INTERSECTION) → FOLLOW → ARRIVAL
      いつでも FREE_LOOK（ユーザー操作）へ、一定時間で復帰

遷移条件:
  FOLLOW        --- 次マニューバまで 120m 以内 ---> APPROACH_TURN
  APPROACH_TURN --- 次マニューバまで  25m 以内 ---> TURN
  TURN          --- マニューバ通過 & 方位差 < 15° ---> FOLLOW
  APPROACH_TURN --- 交差点が複雑(分岐>=4 or 横断歩道あり) ---> INTERSECTION
  FOLLOW        --- 残距離 < 60m ---> ARRIVAL
  * --- ユーザーがドラッグ ---> FREE_LOOK --- 6 秒無操作 ---> 直前状態
```

状態ごとの目標カメラ（現在地を原点とする追従座標系）:

| 状態 | 距離(後方) | 高さ | pitch | heading | FOV | 補間の時定数 |
| --- | --- | --- | --- | --- | --- | --- |
| FOLLOW | 55 m | 28 m | -32° | 進行方位 | 60° | 0.45 s |
| APPROACH_TURN | 40→28 m | 34 m | -42° | 進行方位と曲がる先の**中間方位**へ徐々に | 55° | 0.6 s |
| TURN | 22 m | 20 m | -28° | 曲がる先の方位 | 65° | 0.35 s |
| INTERSECTION | 30 m | 55 m | -60° | 進行方位 | 50° | 0.7 s |
| ARRIVAL | 45 m | 60 m | -55° | 目的地方向 | 60° | 1.0 s |
| FREE_LOOK | ユーザー操作 | | | | | ー |

- 補間は**臨界減衰スプリング**（`smoothDamp`）を位置・高さ・pitch・heading・FOV の各次元に適用。
  heading は必ず ±180° に正規化してから補間し、360°/0° 境界で回転しないようにする。
- 「次の曲がり角の予測」は `ManeuverPlanner` が担当。現在の `shapeIndex` から先読みして
  `nextManeuver`, `distanceToManeuver`, `secondNextManeuver` を毎フレーム返す。
- **建物透過**: 現在地→次マニューバ地点の視線に沿って `scene.drillPick` / `clampToHeightMostDetailed` で
  遮蔽候補を判定し、その建物 ID だけを `Cesium3DTileStyle` の条件でフェード。**全建物を透明にはしない**。
- スピードに応じて FOLLOW の距離・高さを 0.8〜1.6 倍でスケール（自動車 vs 徒歩）。

---

## 10. AI Tool Calling 設計

```
User ──► /api/ai/chat ──► AIProvider(選択可) ──► LLM
                                ▲                 │ tool_call
                                │                 ▼
                          結果を返す ◄── GeoToolRegistry.execute()
                                                  │
                                        routing / gis パッケージ
                                                  │
                                                  ▼
                                        UICommand[] をクライアントへ
                                                  │
                                        map-engine が Cesium に適用
```

**AI は Cesium を直接触らない。** LLM の出力は必ず「ツール呼び出し」か「UI コマンド」に落ちる。

ツール一覧（`packages/ai/tools/`）:

| tool | 引数 | 実装 |
| --- | --- | --- |
| `search_place` | `query`, `near?` | Nominatim |
| `search_nearby` | `center|place`, `category`, `radius`, `limit` | Overpass |
| `calculate_route` | `from`, `to`, `mode` | ジオコーディング→Valhalla |
| `get_building_info` | `lat`,`lng` | OSM + PLATEAU 属性 |
| `get_map_context` | ー | クライアントが送ったカメラ状態 |
| `set_camera` | `lat`,`lng`,`heading`,`pitch`,`range` | UICommand |
| `highlight_location` | `lat`,`lng`,`label` | UICommand |
| `start_navigation` | `routeId` | UICommand |
| `set_time_of_day` | `hour` | UICommand |

`AIProvider` インタフェース:
```ts
interface AIProvider {
  readonly name: string;
  chat(req: { messages: ChatMessage[]; tools: ToolDefinition[]; system?: string })
    : Promise<{ content: string; toolCalls: ToolCall[] }>;
}
```
`createAIProvider(env)` が `AI_PROVIDER` に応じて `openai|anthropic|gemini|local` を返す。
**どのプロバイダ名もアプリコードに現れない**（ファクトリ内のみ）。

安全策:
- ツール引数は zod 相当の自前バリデータで検証してから実行。
- 1 リクエストあたりのツール実行回数を上限 5 に制限（暴走防止）。
- LLM に緯度経度を「創作」させない。地名は必ず `search_place` を経由させる（system プロンプトで強制）。

---

## 11. パフォーマンス戦略

**端末ティア判定**（`packages/map-engine/quality.ts`）
```
iOS (iPhone 15/16/17 世代)     → tier "ios-high" : SSE 10, msaa 4, resolutionScale min(dpr,2.0),
                                                    shadows on, cacheBytes 384MB
デスクトップ (dGPU 相当)        → tier "high"     : SSE 8,  msaa 4, dpr 1.5, shadows on, 512MB
その他モバイル / 低性能         → tier "low"      : SSE 24, msaa 1, dpr 1.0, shadows off, 128MB
```
判定は `navigator.userAgent`(iOS 判定) + `deviceMemory` + `WEBGL_debug_renderer_info` + 実測 FPS。
起動後 5 秒の平均 FPS が 30 を下回ったら 1 段自動で下げる（**iOS は下げない**＝要件どおり品質維持）。

- 3D Tiles: `maximumScreenSpaceError`, `cacheBytes`, `maximumCacheOverflowBytes`,
  `cullWithChildrenBounds:true`, `cullRequestsWhileMoving:true`, `preloadWhenHidden:false`,
  `preferLeaves:true`, `skipLevelOfDetail`（ナビ中のみ有効化してポップを抑制）
- **地理的オンデマンド**: 都市レジストリの bbox 単位でタイルセットを attach/detach。カメラが都市 bbox から
  一定距離離れたら `destroy()` して GPU メモリを解放する。**起動時に日本全国は読まない**
- `requestRenderMode: true`（静止時）。ナビ中・アニメーション中のみ連続描画
- POI/Overpass 結果は BFF 側で bbox+category キーの LRU キャッシュ + `s-maxage` 付きレスポンス
- ルート形状は polyline6 のまま転送し、クライアントで展開

---

## 12. MVP の実装手順

| Phase | 内容 | 完了条件 |
| --- | --- | --- |
| 1 | Cesium で東京の 3D 都市 | 地球表示 → 東京へ移動 → 地形 → 建物(PLATEAU) → 地理院ベースマップ → カメラ操作。出典表示あり |
| 2 | ルーティング | 2 点指定 → `/api/route` → 3D 道路上にルート描画。徒歩/車/自転車 |
| 3 | Immersive Navigation | Follow Camera / Next Turn / Turn Animation / Intersection Highlight / Route Highlight / Building Transparency / Arrival |
| 4 | AI | 「東京駅から渋谷まで歩いて」→ tool calling → Valhalla → Cesium |
| 5 | 3D 品質 | PBR/ライティング/影/大気/時間帯/天候/街路樹・街灯 |
| 6 | 全国展開 | 都市レジストリに 1 エントリ追加するだけで新都市が動く |

各 Phase の終わりに **ビルド + 型チェック + 実機動作確認** を行ってから次へ進む。

---

## 13. リスクと代替案

| # | リスク | 影響 | 対策 / 代替案 |
| --- | --- | --- | --- |
| R1 | PLATEAU 配信サービスが「実験的」で停止・変更されうる | 建物・地形が表示されない | タイルセット URL を設定化。`scripts/convert-plateau` による自前変換・自前ホスト経路を用意。地形は GSI `dem_png` からの生成に切替可能 |
| R2 | FOSSGIS Valhalla デモのレート制限（1 req/user/s） | 公開デモで経路が失敗 | `X-Client-Id` 付与 + BFF 側でキャッシュ・レート制御。セルフホスト Valhalla を Docker で同梱。OSRM フォールバック実装済み |
| R3 | 公開 Overpass の可用性（調査環境からは到達不可だった） | POI 検索が動かない | エンドポイントを環境変数化、複数候補をフェイルオーバ、失敗時は POI 機能のみ無効化して地図とナビは動かす |
| R4 | Nominatim の利用規約（1 req/s・User-Agent 必須） | 検索がブロックされる | BFF で User-Agent 付与 + キャッシュ + デバウンス。将来は自前 Nominatim / PostGIS 検索へ |
| R5 | iPhone の熱・電力による性能低下 | ナビ中のカクつき | 品質は落とさない方針のため、代わりに `requestRenderMode` の徹底、遠景タイルセットの detach、影の距離制限で対処 |
| R6 | LOD2 テクスチャ付きタイルの重さ | 初回表示が遅い | LOD1 を先に出して LOD2 を追いロード（progressive）。`notexture` バリアントを遠景に使用 |
| R7 | Vercel の実行時間・サイズ制限 | AI/ルート API のタイムアウト | Route Handler は軽量（外部委譲のみ）。`maxDuration` を設定。重い処理は `apps/api` 側へ |
| R11 | モノレポと Vercel のフレームワーク検出 | `No Next.js version detected` でデプロイ不能 | Vercel は Root Directory の package.json を見るため、**Next.js アプリをリポジトリ直下に置く**ことで既定設定のままデプロイできるようにした。共有ロジックは `packages/*` を `file:` 依存で参照し、`transpilePackages` で TS のまま取り込む（workspaces を使わないので検出ロジックに影響しない）。詳細は [deploy-vercel.md](./deploy-vercel.md) |
| R8 | Cesium のバンドルサイズ | 初期ロードが遅い | `dynamic(() => …, {ssr:false})` で分割、Cesium 静的アセットは `public/cesium` から配信、`CESIUM_BASE_URL` を明示 |
| R9 | LLM が座標を捏造する | 誤った場所を表示 | 座標は必ずツール経由。system プロンプトで禁止し、ツール結果に無い座標を含む UI コマンドは BFF 側で破棄 |
| R10 | ライセンス表示漏れ | 規約違反 | 出典はデータソース定義に属性として持たせ、UI が**自動列挙**する（追加時に書き忘れない構造） |
