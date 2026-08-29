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
  /** 遠景タイルセットの SSE */
  farScreenSpaceError: number;
  /** タイルキャッシュ (byte) */
  cacheBytes: number;
  maximumCacheOverflowBytes: number;
  msaaSamples: number;
  /** devicePixelRatio に掛ける係数の上限 */
  resolutionScale: number;
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
  label: string;
}

const PRESETS: Record<QualityTier, QualitySettings> = {
  high: {
    tier: 'high',
    // 建物のディテールを優先する（実写テクスチャの解像度を活かす）
    screenSpaceError: 6,
    farScreenSpaceError: 40,
    cacheBytes: 512 * 1024 * 1024,
    maximumCacheOverflowBytes: 256 * 1024 * 1024,
    msaaSamples: 4,
    resolutionScale: 1.5,
    shadows: true,
    shadowDistance: 3000,
    softShadows: true,
    ambientOcclusion: true,
    bloom: true,
    fxaa: false,
    hdr: true,
    streetFurniture: true,
    maxFurniture: 2500,
    useFarTileset: true,
    label: '高品質（デスクトップ）',
  },
  'ios-high': {
    // iPhone 17 世代を想定。Retina 解像度＋MSAA を維持し、影の距離だけ抑えて発熱を防ぐ。
    tier: 'ios-high',
    screenSpaceError: 8,
    farScreenSpaceError: 48,
    cacheBytes: 384 * 1024 * 1024,
    maximumCacheOverflowBytes: 128 * 1024 * 1024,
    msaaSamples: 4,
    resolutionScale: 2.0,
    shadows: true,
    shadowDistance: 1800,
    softShadows: true,
    ambientOcclusion: true,
    bloom: true,
    fxaa: false,
    hdr: true,
    streetFurniture: true,
    maxFurniture: 1500,
    useFarTileset: true,
    label: '高品質（iPhone 最適化）',
  },
  balanced: {
    tier: 'balanced',
    screenSpaceError: 16,
    farScreenSpaceError: 64,
    cacheBytes: 256 * 1024 * 1024,
    maximumCacheOverflowBytes: 64 * 1024 * 1024,
    msaaSamples: 2,
    resolutionScale: 1.25,
    shadows: true,
    shadowDistance: 1200,
    softShadows: false,
    ambientOcclusion: false,
    bloom: false,
    fxaa: true,
    hdr: false,
    streetFurniture: true,
    maxFurniture: 800,
    useFarTileset: true,
    label: 'バランス',
  },
  low: {
    tier: 'low',
    screenSpaceError: 24,
    farScreenSpaceError: 96,
    cacheBytes: 128 * 1024 * 1024,
    maximumCacheOverflowBytes: 32 * 1024 * 1024,
    msaaSamples: 1,
    resolutionScale: 1.0,
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

export function getQualitySettings(tier: QualityTier): QualitySettings {
  return { ...PRESETS[tier] };
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
