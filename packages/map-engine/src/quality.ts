/**
 * 端末性能に応じた描画品質の決定。
 *
 * 方針:
 *  - iPhone（A17/A18 世代以降を想定）は「品質を落とさない」。むしろ Retina 解像度を活かす。
 *  - 低性能端末は SSE を上げて描画対象を減らす。
 *  - 実測 FPS が低いときのみ 1 段階下げる（iOS は下げない）。
 */

export type QualityTier = 'high' | 'ios-high' | 'balanced' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  /** 3D Tiles の maximumScreenSpaceError（小さいほど高品質） */
  screenSpaceError: number;
  /**
   * 地形（globe）の maximumScreenSpaceError。Cesium 既定は 2。
   * 建物と違って地形は起伏がなだらかなので、少し上げても見た目はほぼ変わらず
   * 保持する地形タイル数＝メモリを確実に減らせる。
   */
  globeScreenSpaceError: number;
  /** 地形タイルのキャッシュ枚数 */
  globeTileCacheSize: number;
  /** 遠景タイルセットの SSE */
  farScreenSpaceError: number;
  /** タイルキャッシュ (byte) */
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  msaaSamples: number;
  /** devicePixelRatio に掛ける係数の上限 */
  resolutionScale: number;
  /**
   * 描画バッファの総ピクセル数の上限。
   * 画面が大きい端末で resolutionScale をそのまま掛けると描画バッファが巨大化し、
   * MSAA・HDR の中間バッファと合わせてメモリを食い潰すため、面積で頭打ちにする。
   */
  maxDrawPixels: number;
  shadows: boolean;
  shadowDistance: number;
  softShadows: boolean;
  ambientOcclusion: boolean;
  bloom: boolean;
  fxaa: boolean;
  hdr: boolean;
  /** 街路樹・街灯などの装飾を出すか */
  streetFurniture: boolean;
  /** 装飾の最大数 */
  maxFurniture: number;
  /** 遠景タイルセットを使うか */
  useFarTileset: boolean;
  /**
   * 描画する最大距離 (m)。
   *
   * Cesium の既定は事実上無制限で、地平線までの全タイルが読み込み対象になる。
   * cacheBytes は「現在の視界に不要なタイル」しか切り詰めないため、
   * 視界そのものを絞らないと読み込み量は減らせない。
   * 遠方は霧で自然に減衰させるので、見た目の違和感は出ない。
   */
  viewDistance: number;
  label: string;
}

/**
 * メモリ予算について（重要）
 *
 * PLATEAU LOD2 はテクスチャ付きで非常に重く、maximumScreenSpaceError を小さくすると
 * 読み込むタイル数が指数的に増える。ブラウザのタブには使用メモリの上限があり
 * （特に iOS Safari は 1GB 前後で強制終了される）、上限を超えるとページごとクラッシュする。
 *
 * そのため各プリセットは「見た目の精細さ」ではなく「タブが落ちないメモリ量」から逆算している。
 * Cesium 既定の maximumScreenSpaceError は 16 なので、下記はいずれも既定より高精細である。
 * 実際のキャッシュ量は resolveMemoryBudget() が端末の搭載メモリを見て更に絞る。
 */
const PRESETS: Record<QualityTier, QualitySettings> = {
  high: {
    tier: 'high',
    viewDistance: 16000,
    globeScreenSpaceError: 2.0,
    globeTileCacheSize: 260,
    // 建物のディテールを優先しつつ、タイル数が発散しない範囲に収める
    screenSpaceError: 10,
    farScreenSpaceError: 48,
    cacheBytes: 320 * 1024 * 1024,
    maximumCacheOverflowBytes: 96 * 1024 * 1024,
    // MSAA 4x は HDR の float バッファと掛け合わさってメモリを大きく食う。
    // 2x でも輪郭の粗さはほぼ気にならないので、安定側に振る。
    msaaSamples: 2,
    resolutionScale: 1.5,
    maxDrawPixels: 4_200_000,
    shadows: true,
    shadowDistance: 3000,
    softShadows: true,
    ambientOcclusion: true,
    bloom: true,
    fxaa: false,
    hdr: true,
    streetFurniture: true,
    maxFurniture: 2000,
    useFarTileset: true,
    label: '高品質（デスクトップ）',
  },
  'ios-high': {
    // iPhone 17 世代を想定。Retina の精細さは活かすが、iOS Safari のメモリ上限が
    // デスクトップよりずっと低いため、キャッシュと描画ピクセル数は明確に制限する。
    tier: 'ios-high',
    viewDistance: 12000,
    globeScreenSpaceError: 2.5,
    globeTileCacheSize: 160,
    screenSpaceError: 12,
    farScreenSpaceError: 56,
    cacheBytes: 160 * 1024 * 1024,
    maximumCacheOverflowBytes: 48 * 1024 * 1024,
    msaaSamples: 2,
    resolutionScale: 2.0,
    maxDrawPixels: 2_600_000,
    shadows: true,
    shadowDistance: 1500,
    softShadows: true,
    ambientOcclusion: true,
    bloom: true,
    fxaa: false,
    hdr: true,
    streetFurniture: true,
    maxFurniture: 1200,
    useFarTileset: true,
    label: '高品質（iPhone 最適化）',
  },
  balanced: {
    tier: 'balanced',
    viewDistance: 9000,
    globeScreenSpaceError: 3.0,
    globeTileCacheSize: 140,
    screenSpaceError: 18,
    farScreenSpaceError: 72,
    cacheBytes: 128 * 1024 * 1024,
    maximumCacheOverflowBytes: 32 * 1024 * 1024,
    msaaSamples: 2,
    resolutionScale: 1.25,
    maxDrawPixels: 2_200_000,
    shadows: true,
    shadowDistance: 1200,
    softShadows: false,
    ambientOcclusion: false,
    bloom: false,
    fxaa: true,
    hdr: false,
    streetFurniture: true,
    maxFurniture: 700,
    useFarTileset: true,
    label: 'バランス',
  },
  low: {
    tier: 'low',
    viewDistance: 6000,
    globeScreenSpaceError: 4.0,
    globeTileCacheSize: 100,
    screenSpaceError: 28,
    farScreenSpaceError: 110,
    cacheBytes: 64 * 1024 * 1024,
    maximumCacheOverflowBytes: 16 * 1024 * 1024,
    msaaSamples: 1,
    resolutionScale: 1.0,
    maxDrawPixels: 1_600_000,
    shadows: false,
    shadowDistance: 600,
    softShadows: false,
    ambientOcclusion: false,
    bloom: false,
    fxaa: true,
    hdr: false,
    streetFurniture: false,
    maxFurniture: 0,
    useFarTileset: false,
    label: '軽量',
  },
};

export interface DeviceInfo {
  isIOS: boolean;
  isMobile: boolean;
  deviceMemoryGb: number;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  renderer: string;
}

export function detectDevice(): DeviceInfo {
  if (typeof navigator === 'undefined') {
    return {
      isIOS: false,
      isMobile: false,
      deviceMemoryGb: 8,
      hardwareConcurrency: 8,
      devicePixelRatio: 1,
      renderer: 'unknown',
    };
  }

  const ua = navigator.userAgent;
  // iPadOS はデスクトップ Safari を名乗るため、タッチ有無で判定する
  const isIPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || isIPadOS;
  const isMobile = isIOS || /Android|Mobile/.test(ua);

  let renderer = 'unknown';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    }
  } catch {
    /* 取得できなくても判定は続行する */
  }

  return {
    isIOS,
    isMobile,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? (isMobile ? 4 : 8),
    hardwareConcurrency: navigator.hardwareConcurrency ?? 4,
    devicePixelRatio: window.devicePixelRatio ?? 1,
    renderer,
  };
}

export function selectQualityTier(device: DeviceInfo = detectDevice()): QualityTier {
  if (device.isIOS) return 'ios-high';
  if (!device.isMobile && device.hardwareConcurrency >= 8 && device.deviceMemoryGb >= 8) {
    return 'high';
  }
  if (device.isMobile && device.deviceMemoryGb <= 3) return 'low';
  return 'balanced';
}

/**
 * 端末の搭載メモリ・画面サイズを見て、プリセットのメモリ予算を更に絞る。
 *
 * navigator.deviceMemory は Safari では取得できないので、その場合は
 * 「iOS = 4GB 相当」という保守的な既定値で扱う（quality.ts の detectDevice を参照）。
 */
export function resolveMemoryBudget(
  settings: QualitySettings,
  device: DeviceInfo = detectDevice(),
): QualitySettings {
  const resolved = { ...settings };

  // 搭載メモリからタイルキャッシュの上限を決める。
  // タブが使えるのは搭載量のごく一部なので、控えめな係数を掛ける。
  const perGb = device.isIOS ? 40 : 56; // MB / GB
  const budgetMb = Math.round(device.deviceMemoryGb * perGb);
  const capMb = Math.max(64, Math.min(budgetMb, Math.round(settings.cacheBytes / (1024 * 1024))));
  resolved.cacheBytes = capMb * 1024 * 1024;
  resolved.maximumCacheOverflowBytes = Math.min(
    settings.maximumCacheOverflowBytes,
    Math.round(resolved.cacheBytes * 0.3),
  );

  // コア数が少ない端末はタイルの復号が追いつかないので、精細さを一段落とす
  if (device.hardwareConcurrency <= 4) {
    resolved.screenSpaceError = Math.max(resolved.screenSpaceError, 16);
    resolved.maxFurniture = Math.round(resolved.maxFurniture * 0.5);
  }

  return resolved;
}

/** 画面サイズと maxDrawPixels から、実際に使う resolutionScale を求める */
export function computeResolutionScale(
  settings: QualitySettings,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const scale = Math.min(devicePixelRatio || 1, settings.resolutionScale);
  const area = Math.max(1, cssWidth * cssHeight);
  const maxScale = Math.sqrt(settings.maxDrawPixels / area);
  // 4K など画素数の多いディスプレイでは等倍でもフレームバッファが数百 MB になる。
  // MSAA と HDR の中間バッファも同じ倍率で効くため、等倍より下も許す。
  // UI は React 側の DOM なので、ここを下げても文字がぼやけることはない。
  return Math.max(0.6, Math.min(scale, maxScale));
}

export function getQualitySettings(tier: QualityTier): QualitySettings {
  return { ...PRESETS[tier] };
}

/**
 * メモリ逼迫時に 1 段階下げたティア。
 * こちらは iOS も対象にする（タブが落ちるより品質を下げる方がましなため）。
 */
export function forceDegradeTier(tier: QualityTier): QualityTier {
  switch (tier) {
    case 'high':
    case 'ios-high':
      return 'balanced';
    case 'balanced':
      return 'low';
    default:
      return tier;
  }
}

/** 1 段階下げたティア（iOS は下げない） */
export function degradeTier(tier: QualityTier): QualityTier {
  switch (tier) {
    case 'high':
      return 'balanced';
    case 'balanced':
      return 'low';
    default:
      return tier;
  }
}

/**
 * FPS を監視して、必要なら品質を下げる。
 * iOS は要件により品質維持なので対象外。
 */
export class PerformanceWatchdog {
  private samples: number[] = [];
  private lastTime = 0;
  private triggered = false;

  constructor(
    private readonly onDegrade: () => void,
    private readonly minFps = 28,
    private readonly sampleCount = 180,
    private readonly enabled = true,
  ) {}

  frame(now: number): void {
    if (!this.enabled || this.triggered) return;
    if (this.lastTime > 0) {
      const dt = now - this.lastTime;
      if (dt > 0) this.samples.push(1000 / dt);
    }
    this.lastTime = now;

    if (this.samples.length >= this.sampleCount) {
      const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      this.samples = [];
      if (avg < this.minFps) {
        this.triggered = true;
        this.onDegrade();
      }
    }
  }
}


/**
 * メモリ使用量を監視して、危険域に入る前に自動で退避する。
 *
 * ページごとクラッシュする（タブが落ちる）のはメモリ超過が原因なので、
 * FPS ではなく実メモリを見る必要がある。判断材料は 2 つ:
 *  1. 3D Tiles の実使用量（Cesium が申告する。全ブラウザで取れる）
 *  2. JS ヒープ（performance.memory。Chromium 系のみ）
 *
 * 危険域では「タイルを解放 → 精細度を落とす」を段階的に行う。
 * iOS でも作動させる（要件の「品質を落とさない」より、落ちないことを優先する）。
 */
export interface MemoryPressureReport {
  tileBytes: number;
  heapBytes: number | null;
  heapLimitBytes: number | null;
  level: 'ok' | 'warn' | 'critical';
}

export class MemoryWatchdog {
  private lastActionAt: number | null = null;

  constructor(
    private readonly onPressure: (report: MemoryPressureReport) => void,
    /** 3D Tiles がこのバイト数を超えたら警告域 */
    private budgetBytes: number,
    /** 連続で作動しないための最小間隔 (ms) */
    private readonly cooldownMs = 5000,
  ) {}

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
  }

  static readHeap(): { used: number; limit: number } | null {
    if (typeof performance === 'undefined') return null;
    const mem = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;
    if (!mem || !Number.isFinite(mem.usedJSHeapSize)) return null;
    return { used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit };
  }

  check(tileBytes: number, now = Date.now()): MemoryPressureReport {
    const heap = MemoryWatchdog.readHeap();
    const heapRatio = heap && heap.limit > 0 ? heap.used / heap.limit : 0;
    const tileRatio = this.budgetBytes > 0 ? tileBytes / this.budgetBytes : 0;

    let level: MemoryPressureReport['level'] = 'ok';
    if (tileRatio >= 1.5 || heapRatio >= 0.9) level = 'critical';
    else if (tileRatio >= 1.1 || heapRatio >= 0.75) level = 'warn';

    const report: MemoryPressureReport = {
      tileBytes,
      heapBytes: heap?.used ?? null,
      heapLimitBytes: heap?.limit ?? null,
      level,
    };

    // 初回は必ず通知する（起動直後に逼迫した場合を取りこぼさない）
    const cooledDown = this.lastActionAt === null || now - this.lastActionAt >= this.cooldownMs;
    if (level !== 'ok' && cooledDown) {
      this.lastActionAt = now;
      this.onPressure(report);
    }
    return report;
  }
}


/**
 * カメラ高度に応じた「近景タイルセットの精細度」を返す。
 *
 * 上空から街全体を見ているときに地上と同じ精細度で建物を読み込むと、
 * 視界内のタイルが数千枚規模になりメモリを使い切る。
 * 高いところでは遠景タイルセット（LOD1）が街並みを担うので、
 * 近景（LOD2）の精細度は落として構わない。
 *
 * @param base 品質プリセットの screenSpaceError
 * @param heightMeters カメラの対地高度
 */
export function adaptiveScreenSpaceError(base: number, heightMeters: number): number {
  const factor =
    heightMeters < 300
      ? 1 // 街を歩く視点。ここが最高精細
      : heightMeters < 800
        ? 1.6
        : heightMeters < 2000
          ? 3
          : heightMeters < 6000
            ? 6
            : 10;
  return Math.min(96, Math.round(base * factor));
}
