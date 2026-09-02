/**
 * 「新しいものが描けるようになってから古いものを消す」ための待ち合わせ。
 *
 * Cesium の Primitive は asynchronous: true のときワーカーで頂点を組むので、
 * scene.primitives.add() した直後はまだ何も出ていない。
 * ここで待たずに古いほうを消すと、その空白がそのままちらつきになる。
 *
 * 高架（ElevatedStructureLayer）と街路の設備（StreetFurnitureLayer）は
 * どちらも「地形の標高を取ってから組み立てる」ので、
 * 組み直しに数秒かかる。どちらも同じ待ち方をする。
 *
 * 描画エンジンに依存するのはここだけに閉じてある。Swift（SceneKit /
 * RealityKit）へ移すときは、この関数の中身を差し替えれば足りる。
 */

import * as Cesium from 'cesium';

/**
 * 描けるようになるまで待つ上限 (ms)。
 *
 * 過ぎたら待つのをやめる。待ち続けると、組み立てに失敗したときに
 * 古いものが永久に残ってしまう。
 */
export const PRIMITIVE_READY_TIMEOUT_MS = 8000;
/** 進み具合を見に行く間隔 (ms)。60fps で 2 フレームぶん */
const POLL_MS = 32;

/**
 * 待てるもの。
 *
 * Primitive・GroundPrimitive・GroundPolylinePrimitive は
 * 継承関係を持たないが、どれも ready と isDestroyed() を持つ。
 * 共通しているところだけを見る。
 */
export interface AwaitablePrimitive {
  readonly ready: boolean;
  isDestroyed(): boolean;
}

/**
 * まだ触ってよい scene を返す。破棄済みなら null。
 *
 * 組み立ては数秒かかるので、その間に画面を離れたり都市を切り替えたりして
 * viewer が破棄されることがある。破棄後の scene に触ると例外になり、
 * 「読み込み中に操作すると落ちる」という形で出る。
 * 非同期の待ち合わせをまたいだら、必ずこれで確かめてから使う。
 */
export function liveScene(viewer: Cesium.Viewer): Cesium.Scene | null {
  if (!viewer || viewer.isDestroyed()) return null;
  const scene = viewer.scene;
  if (!scene || scene.isDestroyed()) return null;
  return scene;
}

/** scene が生きていれば描画を要求する */
export function requestRenderIfAlive(viewer: Cesium.Viewer): void {
  liveScene(viewer)?.requestRender();
}

/**
 * プリミティブが描けるようになるまで待つ。
 *
 * requestRenderMode では描画が走らないと組み立ても進まないので、
 * 待っている間はこちらから描画を要求する。
 *
 * 待っている最中に scene が破棄されたら、そこで待つのをやめる。
 * 破棄済みの scene に requestRender すると例外になる。
 *
 * @returns 全部が ready になったら true、上限に達したか破棄されたら false
 */
export async function waitForPrimitives(
  scene: Cesium.Scene,
  primitives: readonly AwaitablePrimitive[],
  timeoutMs = PRIMITIVE_READY_TIMEOUT_MS,
): Promise<boolean> {
  if (primitives.length === 0) return true;
  const deadline = Date.now() + timeoutMs;

  const pending = () => primitives.some((p) => !p.isDestroyed() && !p.ready);

  while (pending()) {
    if (Date.now() >= deadline) return false;
    if (scene.isDestroyed()) return false;
    scene.requestRender();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}
