/**
 * 街路樹・街灯・ベンチ・信号を「形の記述」(SceneShape) として組み立てる。
 *
 * ここは描画エンジンに触れない純粋な変換で、Cesium を import しない。
 * 以前はこの寸法決めが map-engine（Cesium）の中にあり、
 * Swift へ移すときにそのまま持っていけなかった。
 *
 * 実データと補完の切り分け:
 *   位置           … OSM の node（natural=tree / highway=street_lamp ほか）
 *   樹高・樹冠幅   … OSM に height / diameter_crown があればそれ
 *   葉の付き方     … OSM に leaf_type / genus があればそれ
 *   それ以外の寸法 … 日本の基準・標準品の実寸（下記の出典）
 *
 * **無い木は生やさない。** OSM に点が無ければ何も作らない。
 * 「街路樹がありそうだから並べる」ことはしない。
 */

import type { LatLng, LatLngAlt, SceneShape } from '@ijm/shared';

// ---- 街路樹 ------------------------------------------------------------

/**
 * 街路樹の寸法。
 *
 * 出典: 道路緑化技術基準（国土交通省）および「街路樹の樹種と規格」。
 *   高木の樹高      4〜12m（植栽時 3〜4m、成木で 8〜12m）
 *   枝下高          歩道上は 2.5m 以上（車道上は 4.5m 以上）
 *   樹冠幅          3〜6m
 *   幹の直径        成木で 0.3〜0.5m（根元）
 *
 * OSM に height / diameter_crown があるときはそちらを使う。
 */
const TREE = {
  minHeight: 4,
  maxHeight: 14,
  defaultHeight: 8,
  /** 枝下高は樹高に対するおよその比。歩道上の 2.5m を下回らないようにする */
  clearanceRatio: 0.32,
  minClearance: 2.5,
  /** 樹冠幅は樹高のおよそ 0.5〜0.6 倍 */
  crownRatio: 0.55,
  /** 根元の幹径は樹高のおよそ 1/25 */
  trunkRatio: 0.04,
} as const;

/**
 * 葉の付き方による樹形。
 *
 * OSM の leaf_type（broadleaved / needleleaved）と genus から選ぶ。
 * 日本の街路樹で最も多いのはイチョウ・ケヤキ・サクラ・トウカエデで、
 * イチョウは細く直立、ケヤキは扇形に開く、という違いが遠目にも分かる。
 */
export type TreeForm = 'broadleaf' | 'needleleaf' | 'columnar' | 'vase';

/** 幹と葉の色。実際の色は季節と樹種で変わるので、一般的な緑と樹皮の色に留める */
const TRUNK_COLOR = '#6b5844';
const LEAF_COLORS: Record<TreeForm, string[]> = {
  broadleaf: ['#4b7f3f', '#568c46', '#42733a'],
  needleleaf: ['#2f5c39', '#356640', '#2a5133'],
  columnar: ['#5a8a3e', '#4f7f38', '#638f45'],
  vase: ['#4b7f3f', '#557f42', '#456f3a'],
};

/**
 * OSM のタグから樹形を決める。
 *
 * 分からないときは広葉樹にする。日本の街路樹は 9 割以上が広葉樹で、
 * 針葉樹の樹形（円錐）を当てると明らかに違って見えるため。
 */
export function treeFormOf(tags: Record<string, string> = {}): TreeForm {
  const genus = (tags.genus ?? tags['genus:en'] ?? '').toLowerCase();
  const species = (tags.species ?? tags['species:en'] ?? '').toLowerCase();
  const text = `${genus} ${species}`;

  // イチョウ（Ginkgo）とポプラは細く直立する
  if (/ginkgo|populus/.test(text)) return 'columnar';
  // ケヤキ（Zelkova）は扇形に開く
  if (/zelkova/.test(text)) return 'vase';
  if (tags.leaf_type === 'needleleaved') return 'needleleaf';
  if (/pinus|cryptomeria|chamaecyparis|abies|picea/.test(text)) return 'needleleaf';
  return 'broadleaf';
}

/** 位置に対して決まる擬似乱数。同じ木は何度組み立てても同じ形になる */
export function jitter(lat: number, lng: number, salt = 0): number {
  const x = Math.sin(lat * 12.9898 + lng * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 数値タグを読む。読めない値は undefined */
function numberTag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface TreeOptions {
  /** OSM のタグ。height / diameter_crown / leaf_type / genus を見る */
  tags?: Record<string, string>;
  /** 地表の標高 (m) */
  ground: number;
  /**
   * 枝葉のかたまりをいくつ作るか。
   *
   * 1 つだと棒付きキャンディにしか見えない。近くでは 4〜5 個、
   * 遠くでは 1 個にして、輪郭だけ残す。
   */
  blobs?: number;
}

/**
 * 街路樹 1 本。
 *
 * 幹（根元が太い円錐台）＋ ずらして重ねた樹冠のかたまり。
 * 樹形ごとに、かたまりの積み方を変える:
 *
 *   broadleaf … 横に広い球を重ねる（ケヤキ以外の一般的な広葉樹）
 *   vase      … 上へ行くほど広がる（ケヤキ）
 *   columnar  … 縦に細長く積む（イチョウ・ポプラ）
 *   needleleaf… 円錐 1 つ（マツ・スギ）
 */
export function treeShapes(point: LatLng, options: TreeOptions): SceneShape[] {
  const tags = options.tags ?? {};
  const form = treeFormOf(tags);
  const r1 = jitter(point.lat, point.lng, 1);
  const r2 = jitter(point.lat, point.lng, 2);

  // 樹高は OSM にあればそれ。無ければ標準の範囲でばらつかせる
  const height = clamp(
    numberTag(tags.height) ?? TREE.defaultHeight + (r1 - 0.5) * 4,
    TREE.minHeight,
    TREE.maxHeight,
  );
  // 樹冠幅も OSM にあればそれ
  const crownWidth = clamp(
    numberTag(tags.diameter_crown) ?? height * TREE.crownRatio * (0.85 + r2 * 0.3),
    1.5,
    12,
  );
  const crownRadius = crownWidth / 2;
  // 枝下高。歩道上は 2.5m 以上（道路緑化技術基準）
  const clearance = Math.max(TREE.minClearance, height * TREE.clearanceRatio);
  const trunkRadius = clamp(height * TREE.trunkRatio, 0.08, 0.35) / 2;

  const base: LatLngAlt = { ...point, alt: options.ground };
  const id = `tree@${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  const leaves = LEAF_COLORS[form];

  const out: SceneShape[] = [
    {
      kind: 'revolved',
      id: `${id}#trunk`,
      base,
      // 幹は樹冠の中まで伸びている
      height: clearance + (height - clearance) * 0.35,
      bottomRadius: trunkRadius * 1.35,
      topRadius: trunkRadius * 0.8,
      color: TRUNK_COLOR,
    },
  ];

  if (form === 'needleleaf') {
    // 針葉樹は 1 本の円錐。枝下は低い
    out.push({
      kind: 'revolved',
      id: `${id}#crown`,
      base: { ...point, alt: options.ground + clearance * 0.5 },
      height: height - clearance * 0.5,
      bottomRadius: crownRadius,
      topRadius: 0,
      color: leaves[0],
    });
    return out;
  }

  const crownHeight = height - clearance;
  const blobs = Math.max(1, Math.min(6, options.blobs ?? 4));

  for (let i = 0; i < blobs; i += 1) {
    // 0（下）〜1（上）
    const t = blobs === 1 ? 0.5 : i / (blobs - 1);
    const spread = crownSpread(form, t);
    const radius = crownRadius * spread * (0.8 + jitter(point.lat, point.lng, 10 + i) * 0.4);
    // かたまりを水平にずらして、輪郭を不揃いにする
    const offset = crownRadius * 0.28 * (jitter(point.lat, point.lng, 20 + i) - 0.5);
    const angle = jitter(point.lat, point.lng, 30 + i) * Math.PI * 2;
    const cos = Math.cos((point.lat * Math.PI) / 180) || 1;

    out.push({
      kind: 'spheroid',
      id: `${id}#leaf${i}`,
      centre: {
        lat: point.lat + (Math.cos(angle) * offset) / 111_320,
        lng: point.lng + (Math.sin(angle) * offset) / (111_320 * cos),
        alt: options.ground + clearance + crownHeight * (0.18 + t * 0.72),
      },
      radius,
      // 上のほうのかたまりは平たくして、天辺が尖らないようにする
      heightRadius: radius * (form === 'columnar' ? 1.35 : 0.72),
      color: leaves[i % leaves.length],
    });
  }

  return out;
}

/** 樹冠の広がり（0 = 枝下、1 = 天辺）。樹形ごとの輪郭を決める */
function crownSpread(form: TreeForm, t: number): number {
  switch (form) {
    case 'vase':
      // ケヤキ。上へ行くほど広がる扇形
      return 0.5 + t * 0.5;
    case 'columnar':
      // イチョウ・ポプラ。細く、上下で幅が変わらない
      return 0.55 + Math.sin(t * Math.PI) * 0.15;
    default:
      // 一般的な広葉樹。中ほどが最も広い
      return 0.55 + Math.sin(t * Math.PI) * 0.45;
  }
}

// ---- 街灯 --------------------------------------------------------------

/**
 * 道路照明灯の寸法。
 *
 * 出典: 道路照明施設設置基準・同解説（日本道路協会）。
 *   灯具の取付高さ  8〜12m（車道用）、4〜6m（歩道用）
 *   オーバーハング  車道側へ 1〜2m 張り出す
 *   ポール          根元 φ140〜165mm、先端 φ60〜90mm
 */
const LAMP = {
  defaultHeight: 5.2,
  minHeight: 3,
  maxHeight: 12,
  overhang: 1.2,
} as const;

export interface LampOptions {
  tags?: Record<string, string>;
  ground: number;
  /** 灯具を張り出す向き（真北 0・東回りの度）。道路の向きから決める */
  headingDeg?: number;
}

/** 街灯 1 基。ポール + 車道側へ張り出したアーム + 灯具 */
export function lampShapes(point: LatLng, options: LampOptions): SceneShape[] {
  const tags = options.tags ?? {};
  const height = clamp(
    numberTag(tags.height) ?? LAMP.defaultHeight + jitter(point.lat, point.lng, 3) * 1.5,
    LAMP.minHeight,
    LAMP.maxHeight,
  );
  const id = `lamp@${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  const heading = options.headingDeg ?? 0;
  const arm = LAMP.overhang * (height / LAMP.defaultHeight);
  const tip = offsetPoint(point, arm, heading);

  return [
    {
      kind: 'revolved',
      id: `${id}#pole`,
      base: { ...point, alt: options.ground },
      height,
      bottomRadius: 0.082, // φ165mm
      topRadius: 0.045, // φ90mm
      color: '#8d949c',
    },
    // アーム。車道側へ張り出す
    {
      kind: 'box',
      id: `${id}#arm`,
      centre: {
        ...offsetPoint(point, arm / 2, heading),
        alt: options.ground + height - 0.1,
      },
      headingDeg: heading,
      size: { x: 0.07, y: arm, z: 0.07 },
      color: '#8d949c',
    },
    // 灯具。長辺が道路の向きに沿う
    {
      kind: 'box',
      id: `${id}#head`,
      centre: { ...tip, alt: options.ground + height - 0.16 },
      headingDeg: heading,
      size: { x: 0.28, y: 0.62, z: 0.14 },
      color: '#ffe9b0',
    },
  ];
}

// ---- ベンチ ------------------------------------------------------------

/** ベンチ 1 台。座面と背もたれ。JIS の公園用ベンチは 座高 0.40m・奥行 0.45m */
export function benchShapes(
  point: LatLng,
  options: { ground: number; headingDeg?: number },
): SceneShape[] {
  const id = `bench@${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  const heading = options.headingDeg ?? jitter(point.lat, point.lng, 4) * 180;
  return [
    {
      kind: 'box',
      id: `${id}#seat`,
      centre: { ...point, alt: options.ground + 0.4 },
      headingDeg: heading,
      size: { x: 0.45, y: 1.8, z: 0.06 },
      color: '#8a6f4e',
    },
    {
      kind: 'box',
      id: `${id}#back`,
      centre: {
        ...offsetPoint(point, -0.2, heading + 90),
        alt: options.ground + 0.66,
      },
      headingDeg: heading,
      size: { x: 0.05, y: 1.8, z: 0.42 },
      color: '#8a6f4e',
    },
  ];
}

// ---- 信号 --------------------------------------------------------------

/**
 * 車両用交通信号機の寸法。
 *
 * 出典: 交通信号灯器の設置基準（警察庁）および
 *      「交通信号機の設計要領」。
 *   灯器（車両用 3 位・300mm 灯）  幅 0.94m × 高さ 0.35m × 奥行 0.28m
 *   灯器下端の高さ                 車道上は 5.0m 以上
 *   歩行者用灯器                   幅 0.30m × 高さ 0.55m、下端 2.5m
 *   柱                             根元 φ165.2mm、上部 φ139.8mm
 *   アーム                         車道上へ 2〜6m 張り出す
 *
 * **向きは道路の向きから決める。** 以前はすべて真北を向いていて、
 * 交差点のどの方向を制御しているのか分からなかった。
 */
const SIGNAL = {
  headHeight: 5.35, // 灯器の中心。下端 5.0m + 高さ 0.35m の半分
  headSize: { w: 0.94, h: 0.35, d: 0.28 },
  poleHeight: 5.9,
  armLength: 3.2,
  pedestrianHeight: 2.85,
} as const;

export interface SignalOptions {
  ground: number;
  /**
   * 灯器が向く方位（真北 0・東回りの度）。
   * 信号が制御している道路の向きから決める。分からなければ省略。
   */
  headingDeg?: number;
  /**
   * 柱を車道の中心線からどれだけ路肩側へ寄せるか (m)。
   *
   * OSM の `highway=traffic_signals` は**車道の中心線上のノード**に付く。
   * そのまま柱を立てると、車道の真ん中に柱が生えることになる。
   * 実物は路肩（歩道の縁）に立っていて、そこからアームで車道の上へ
   * 灯器を張り出している。道路の半分の幅 + 路肩ぶんを渡す。
   *
   * 日本は左側通行なので、進行方向に向かって左の路肩へ寄せる。
   */
  kerbOffsetM?: number;
  /** 歩行者用灯器も付けるか（交差点の角にあるもの） */
  pedestrian?: boolean;
}

/**
 * 信号機 1 基。柱 + 車道上へ張り出すアーム + 灯器。
 *
 * アームが無いと、遠目には細い棒が立っているだけに見えて信号と分からない。
 * 実物は必ず車道の上に灯器を張り出している。
 */
export function trafficSignalShapes(point: LatLng, options: SignalOptions): SceneShape[] {
  const id = `signal@${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  const ground = options.ground;
  // 灯器は道路の向きに正対する（進んでくる車から見える向き）
  const facing = options.headingDeg ?? 0;
  // 柱は左の路肩に立てる（日本は左側通行）。
  // OSM のノードは車道の中心線上にあるので、寄せないと道の真ん中に柱が立つ
  const kerbOffset = Math.max(0, options.kerbOffsetM ?? 0);
  const base = kerbOffset > 0 ? offsetPoint(point, kerbOffset, facing - 90) : point;
  // アームは路肩から車道の上へ張り出す
  const armHeading = facing + 90;
  const armLength = Math.max(1.5, Math.min(SIGNAL.armLength, kerbOffset + 1.2));
  const tip = offsetPoint(base, armLength, armHeading);

  const out: SceneShape[] = [
    {
      kind: 'revolved',
      id: `${id}#pole`,
      base: { ...base, alt: ground },
      height: SIGNAL.poleHeight,
      bottomRadius: 0.0826, // φ165.2mm
      topRadius: 0.0699, // φ139.8mm
      color: '#5a5f63',
    },
    {
      kind: 'box',
      id: `${id}#arm`,
      centre: {
        ...offsetPoint(base, armLength / 2, armHeading),
        alt: ground + SIGNAL.headHeight + SIGNAL.headSize.h / 2 + 0.12,
      },
      headingDeg: armHeading,
      size: { x: 0.09, y: armLength, z: 0.09 },
      color: '#5a5f63',
    },
    {
      kind: 'box',
      id: `${id}#head`,
      centre: { ...tip, alt: ground + SIGNAL.headHeight },
      // 灯器の長辺（3 灯の並び）は道路を横切る向き
      headingDeg: armHeading,
      size: { x: SIGNAL.headSize.d, y: SIGNAL.headSize.w, z: SIGNAL.headSize.h },
      color: '#33383b',
    },
    // 庇（ひさし）。実物は各灯に付いていて、横から見ると灯器が厚く見える
    {
      kind: 'box',
      id: `${id}#visor`,
      centre: {
        ...offsetPoint(tip, -0.16, facing),
        alt: ground + SIGNAL.headHeight + 0.08,
      },
      headingDeg: armHeading,
      size: { x: 0.2, y: SIGNAL.headSize.w, z: 0.12 },
      color: '#2b2f31',
    },
  ];

  if (options.pedestrian) {
    out.push({
      kind: 'box',
      id: `${id}#ped`,
      centre: { ...base, alt: ground + SIGNAL.pedestrianHeight },
      headingDeg: facing,
      size: { x: 0.16, y: 0.3, z: 0.55 },
      color: '#33383b',
    });
  }

  return out;
}

/** 方位 headingDeg の向きへ offsetM だけ進んだ地点 */
function offsetPoint(point: LatLng, offsetM: number, headingDeg: number): LatLng {
  const rad = (headingDeg * Math.PI) / 180;
  const cos = Math.cos((point.lat * Math.PI) / 180) || 1;
  return {
    lat: point.lat + (Math.cos(rad) * offsetM) / 111_320,
    lng: point.lng + (Math.sin(rad) * offsetM) / (111_320 * cos),
  };
}
