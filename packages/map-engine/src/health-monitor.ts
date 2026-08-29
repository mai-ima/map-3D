/**
 * 実行時の異常を記録する。
 *
 * 3D 地図は「落ちる」「固まる」「読み込まれない」のどれが起きても
 * 利用者からは同じ「うまく動かない」に見える。原因を推測で潰していくのは
 * 効率が悪いので、実際に何が起きたかを記録して見られるようにする。
 *
 * 記録するもの:
 *   - タイルの読み込み失敗（どの階層で、何件）
 *   - 描画エラー（Cesium が握りつぶすもの）
 *   - WebGL コンテキストの喪失と復帰
 *   - メモリ逼迫による自動退避
 *   - 描画が長時間止まっている状態
 *
 * 収集した内容は端末の中だけに置く。外部に送信しない。
 */

export type HealthEventKind =
  | 'tile-failed'
  | 'render-error'
  | 'context-lost'
  | 'context-restored'
  | 'memory-pressure'
  | 'quality-degraded'
  | 'stall';

export interface HealthEvent {
  kind: HealthEventKind;
  at: number;
  detail: string;
}

/** 1 種類あたりの保持件数。古いものから捨てる */
const MAX_PER_KIND = 20;
/** 全体の保持件数 */
const MAX_TOTAL = 60;

/**
 * 描画がこの時間以上進まなければ「止まっている」とみなす。
 *
 * requestRenderMode が有効なときは静止中に描画しないのが正常なので、
 * カメラが動いている、またはナビ中のときだけ判定する。
 */
const STALL_THRESHOLD_MS = 4000;

export class HealthMonitor {
  private events: HealthEvent[] = [];
  private counts = new Map<HealthEventKind, number>();
  private lastFrameAt = 0;
  private stallReported = false;

  /** 種類ごとの累計（保持件数を超えた分も数える） */
  get summary(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  get recent(): HealthEvent[] {
    return [...this.events].reverse();
  }

  get hasProblems(): boolean {
    return this.counts.size > 0;
  }

  record(kind: HealthEventKind, detail: string): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);

    // 同じ種類が大量に出ても、直近のものだけ残す
    const sameKind = this.events.filter((e) => e.kind === kind);
    if (sameKind.length >= MAX_PER_KIND) {
      const oldest = sameKind[0];
      this.events = this.events.filter((e) => e !== oldest);
    }

    this.events.push({ kind, at: Date.now(), detail });
    if (this.events.length > MAX_TOTAL) this.events.shift();
  }

  /**
   * フレームが描画されたことを記録する。
   * 描画が続いている間は「止まっていない」とみなす。
   */
  frame(now = Date.now()): void {
    this.lastFrameAt = now;
    this.stallReported = false;
  }

  /**
   * 描画が止まっていないか調べる。
   * 動いているはずの状況（ナビ中やカメラ操作中）でのみ呼ぶ。
   */
  checkStall(now = Date.now()): boolean {
    if (this.lastFrameAt === 0) return false;
    const idle = now - this.lastFrameAt;
    if (idle < STALL_THRESHOLD_MS) return false;
    if (this.stallReported) return true;
    this.stallReported = true;
    this.record('stall', `描画が ${(idle / 1000).toFixed(1)} 秒進んでいません`);
    return true;
  }

  clear(): void {
    this.events = [];
    this.counts.clear();
    this.stallReported = false;
  }

  /** 利用者に見せる一行の要約 */
  describe(): string | null {
    if (this.counts.size === 0) return null;
    const labels: Record<HealthEventKind, string> = {
      'tile-failed': 'タイル取得失敗',
      'render-error': '描画エラー',
      'context-lost': '描画中断',
      'context-restored': '描画復帰',
      'memory-pressure': 'メモリ逼迫',
      'quality-degraded': '品質自動調整',
      stall: '描画停止',
    };
    return [...this.counts]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${labels[kind]} ${n}`)
      .join(' / ');
  }
}
