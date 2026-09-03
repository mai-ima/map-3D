/**
 * プロジェクト全体で共有する型定義。
 * 座標はすべて WGS84 (EPSG:4326) の緯度経度・楕円体高で扱う。
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LatLngAlt extends LatLng {
  /** 楕円体高 (m)。省略時は地形にクランプする。 */
  alt?: number;
}

/** [minLng, minLat, maxLng, maxLat] */
export type BBox = [number, number, number, number];

export type TravelMode = 'walk' | 'drive' | 'bicycle' | 'transit' | 'multimodal';

/**
 * ナビゲーション用に正規化したマニューバ種別。
 * ルーティングエンジン固有の種別は routing パッケージ側でこの集合に写像する。
 */
export type ManeuverType =
  | 'start'
  | 'continue'
  | 'slight_left'
  | 'slight_right'
  | 'turn_left'
  | 'turn_right'
  | 'sharp_left'
  | 'sharp_right'
  | 'uturn'
  | 'ramp'
  | 'merge'
  | 'roundabout_enter'
  | 'roundabout_exit'
  | 'ferry'
  | 'transit'
  | 'stairs'
  | 'destination';

/**
 * 1 本の車線から進める方向。
 *
 * 出典は OSM の `turn:lanes`（例: `left|through|through;right`）。
 * 経路エンジンがそれを解釈して、車線ごとの矢印として返してくる。
 * **推測しない。** 経路エンジンが返さない交差点では車線案内を出さない。
 * 実在しない矢印を出すと、運転中にその車線へ寄ってしまう。
 */
export type LaneIndication =
  | 'left'
  | 'slight_left'
  | 'sharp_left'
  | 'through'
  | 'right'
  | 'slight_right'
  | 'sharp_right'
  | 'uturn'
  | 'merge_left'
  | 'merge_right'
  /** 矢印の指定が無い車線（`turn:lanes` に `none` と書かれている） */
  | 'none';

/** 交差点の 1 車線 */
export interface Lane {
  /** この車線から進める方向。1 本に複数の矢印が描かれることがある */
  indications: LaneIndication[];
  /** この分岐で通ってよい車線か */
  valid: boolean;
}

export interface Maneuver {
  type: ManeuverType;
  /** 案内文（可能なら日本語） */
  instruction: string;
  /**
   * 音声案内用の文言。
   *
   * 経路エンジンは距離に応じた 3 種類を返す。カーナビは近づくにつれて
   * 文言を切り替えるので、それに合わせて使い分ける。
   *   verbalAlert       … 曲がる直前の短い警告
   *   verbalInstruction … 通常の案内
   *   verbalPost        … 通過後（「300メートル直進です」など）
   */
  verbalInstruction?: string;
  verbalAlert?: string;
  verbalPost?: string;
  location: LatLng;
  /** 進入方位 (度, 0=北, 時計回り) */
  bearingBefore?: number;
  /** 退出方位 (度) */
  bearingAfter?: number;
  /** このマニューバから次のマニューバまでの距離 (m) */
  distanceToNext: number;
  /** このマニューバ区間の所要時間 (s) */
  durationToNext: number;
  streetName?: string;
  /** 次に進む道路名（案内表示用） */
  nextStreetName?: string;
  /** route.coordinates 上のインデックス */
  shapeIndex: number;
  /** 交差点の複雑さ（分岐数などから算出。カメラ演出の判断に使う） */
  intersectionComplexity?: number;
  /**
   * 車線案内。左の車線から順に並ぶ。
   *
   * 経路エンジンが返したときだけ入る。OSM に `turn:lanes` が無い交差点では
   * 省略される（**車線数から推測して作ってはいけない**）。
   */
  lanes?: Lane[];
  /**
   * 方面（案内標識に書かれている行き先）。
   *
   * 出典は OSM の `destination`。実データの例（2026-09, OSRM 経由）:
   *   「横浜・静岡」（東名高速への入口）
   *   「山中湖・箱根」（分岐）
   *   「三軒茶屋」（一般道）
   *
   * 日本の案内標識の慣習に合わせ、複数の行き先は「・」で並べる。
   */
  destination?: string;
  /**
   * 路線番号（国道番号・高速道路のナンバリング）。
   *
   * 出典は OSM の `ref` / `destination:ref`。実データの例:
   *   「406」（都道 406 号）「1・20」（国道 1 号と 20 号の重複）「E1」（東名）
   */
  routeRef?: string;
}

export interface RouteStep {
  index: number;
  distance: number;
  duration: number;
  streetName?: string;
  beginIndex: number;
  endIndex: number;
}

export interface Route {
  id: string;
  mode: TravelMode;
  /** polyline6 でエンコードされた形状 */
  geometry: string;
  /** 展開済み座標列 [lng, lat][] */
  coordinates: [number, number][];
  /** m */
  distance: number;
  /** s */
  duration: number;
  steps: RouteStep[];
  maneuvers: Maneuver[];
  bbox: BBox;
  attribution: string[];
  /** エンジン名 (valhalla / osrm など) */
  engine: string;
}

export interface RouteRequest {
  from: LatLng;
  to: LatLng;
  mode: TravelMode;
  /** 案内文の言語 */
  language?: string;
  /** 経由地 */
  via?: LatLng[];
}

export type PoiCategory =
  | 'convenience'
  | 'cafe'
  | 'restaurant'
  | 'hospital'
  | 'school'
  | 'park'
  | 'station'
  | 'parking'
  | 'shop'
  | 'toilets'
  | 'atm'
  | 'hotel'
  | 'other';

export interface Poi {
  id: string;
  name: string;
  category: PoiCategory;
  lat: number;
  lng: number;
  /** OSM の生タグ（表示・デバッグ用） */
  tags?: Record<string, string>;
  /** 検索地点からの距離 (m) */
  distance?: number;
}

export interface SearchResult {
  id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  category?: string;
  bbox?: BBox;
  source: string;
}

export interface BuildingInfo {
  id: string;
  name?: string;
  lat: number;
  lng: number;
  /** m */
  height?: number;
  levels?: number;
  buildingType?: string;
  address?: string;
  tags?: Record<string, string>;
  sources: string[];
}

/** ナビゲーションカメラが出力する姿勢（Cesium 非依存） */
export interface CameraPose {
  /** カメラが注視する地点 */
  target: LatLngAlt;
  /** 注視点からカメラまでの水平距離 (m) */
  range: number;
  /** 高さ (m) */
  height: number;
  /** 方位角 (度, 0=北) */
  heading: number;
  /** 俯角 (度, 負が下向き) */
  pitch: number;
  /** 垂直画角 (度) */
  fov: number;
}

export interface DataSource {
  id: string;
  /** UI に表示する名称 */
  label: string;
  /** 出典表示文字列（ライセンス上必須のもの） */
  attribution: string;
  license: string;
  url: string;
}

/** クライアントに送ってよい公開設定 */
export interface PublicConfig {
  defaultCityId: string;
  cities: CitySummary[];
  imagery: { id: string; label: string; urlTemplate: string; attribution: string }[];
  terrainUrl: string;
  features: {
    routing: boolean;
    poi: boolean;
    ai: boolean;
    weather: boolean;
  };
  attributions: DataSource[];
}

export interface CitySummary {
  id: string;
  name: string;
  nameEn: string;
  center: LatLng;
  bbox: BBox;
  /** 近景・中景用 3D Tiles の URL */
  buildingTilesetUrl: string;
  /** 遠景用（軽量）3D Tiles の URL */
  farBuildingTilesetUrl?: string;
  /** 初期カメラ高度 (m) */
  initialHeight: number;
}


/**
 * 高架・橋梁などの立体構造物。
 *
 * PLATEAU の橋梁モデルは整備自治体が限られるため、
 * OpenStreetMap の bridge / layer タグから組み立てる。
 * 位置・形状・幅・上下関係は実データ、桁の厚みや橋脚の間隔は
 * 種別ごとの標準的な寸法で補っている。
 */
export type StructureKind =
  | 'rail-elevated'
  | 'rail-bridge'
  | 'road-elevated'
  | 'road-bridge'
  | 'footbridge'
  /**
   * 高架下から上へ上がる階段。
   *
   * 歩道橋・ペデストリアンデッキは、必ずどこかで地表とつながっている。
   * その階段を作らないと、デッキだけが空中に浮いて上がる手段が無くなる。
   * 浜松駅周辺の実測では、階段 19 本のうち 5 本が高架のデッキに接している。
   */
  | 'stair'
  /**
   * 盛土・擁壁の区間、およびその取付部。
   *
   * OSM が `embankment=yes` と書いているのは「土を盛って持ち上げてある」
   * という意味で、柱の上に載っているという意味ではない。柱を並べると
   * 実在しない構造物になる。
   *
   * 普通の道から高架へ上がっていく取付部も同じ造りなので、ここに含める。
   * startHeight を地表に置けば、そのまま滑らかに上がる区間になる。
   */
  | 'embankment';

/**
 * 構造形式。見た目が大きく変わるので分けて扱う。
 *
 *   rigid-frame … ラーメン高架橋。柱と梁が一体で、短い径間が連続する。
 *                 都市部の鉄道高架はほぼこれ
 *   girder      … 桁橋。橋台・橋脚の上に桁を渡す。川や道路をまたぐ橋
 *   slab        … 床版橋。桁を持たない薄い板。歩道橋や小規模な橋
 *   stair       … 階段。斜めの段裏の上に段が並ぶ。地表から高架へ上がる
 *   ramp        … 盛土・擁壁。路面の下を壁で受ける。柱を持たない
 */
export type StructureForm = 'rigid-frame' | 'girder' | 'slab' | 'stair' | 'ramp';

export interface ElevatedStructure {
  id: string;
  kind: StructureKind;
  /** 構造形式。組み立て方が変わる */
  form: StructureForm;
  name?: string;
  /** 中心線（OSM の実データ） */
  path: LatLng[];
  /** 幅 (m)。車線数・線路数から求めるか、種別ごとの標準値 */
  width: number;
  /** OSM の layer。上下関係の目安 */
  layer: number;
  /** 床版の厚み (m) */
  deckThickness: number;
  /** 縦梁の高さ (m)。0 なら梁を持たない構造 */
  girderDepth: number;
  /**
   * 地表から路面（軌道面・車道面）までの高さ (m)。
   *
   * 高さの基準を「桁下」ではなく「路面」に取るのが要点。
   * 同じ路線でも、市街地はラーメン高架橋、川をまたぐ区間は桁橋と
   * 構造が変わり、桁の高さも違う。桁下を基準にすると接続部で
   * 路面が段差になってしまう（実際に 1.2m の段ができていた）。
   * 実物では路面が連続していて、その下の造りだけが変わる。
   */
  deckHeight: number;
  /**
   * 経路の起点における路面の高さ (m)。省略時は deckHeight（＝水平）。
   *
   * 階段や取付部のように、地表から高架へ上がっていく構造で使う。
   * 起点を低いほう、終点を高いほうに揃えて持つ。
   * これがあると、床版・高欄・柱の高さがそのまま勾配に追従する。
   */
  startHeight?: number;
  /** 柱・橋脚を立てる間隔 (m)。0 なら支柱なし */
  pierSpacing: number;
  /** 柱の断面の一辺 (m) */
  pierSize: number;
  /** 高欄・防音壁の高さ (m) */
  parapetHeight: number;
  lanes?: number;
  tracks?: number;
  /**
   * この構造物にまとめた OSM の way。
   *
   * OSM は線路を 1 本ずつ別の way にしているため、複線の高架は
   * 4m 間隔で並ぶ複数の way になる。そのまま 1 本ずつ橋を建てると
   * 床版が重なって積み上がるので、平行に走るものは 1 つの高架にまとめる。
   * 何をまとめた結果なのかを残しておく。
   */
  sourceIds?: string[];
}
