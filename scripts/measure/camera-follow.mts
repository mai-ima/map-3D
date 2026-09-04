/**
 * 「移動しても表示されない」を実機ブラウザで測る。
 *
 * 周辺のデータ（道路・線路・信号 / 高架・橋 / 周辺施設 / 街路樹）は
 * どれも「カメラの周りぶん」しか読んでいない。街を移動したら
 * 読み直さなければ、移動先には何も出ない。
 *
 * ここで測るのは 1 つだけ:
 *
 *   **地図を動かし終えたあと、追加の操作をしないままで、
 *     周辺のデータを取り直す要求が飛ぶか。**
 *
 * 以前はカメラの移動を `LEFT_DOWN`・`WHEEL`・`PINCH_START` で
 * 代用していた。どれも**操作の始まり**に発火するので、
 * 「指を置く（まだ動いていない）→ 1km ドラッグ → 指を離す」では
 * 一度も取り直しが走らなかった。次にもう一度触るまで、
 * 移動先の道も高架も出てこない。
 *
 * いまは Cesium の `camera.moveEnd` と `camera.changed` を見ている。
 * この計測はその差をそのまま数字にする。
 *
 * 使い方（先に `npm run build && npx next start -p 3100` を立てておく）:
 *   npx tsx scripts/measure/camera-follow.mts [URL]
 *
 * この環境のブラウザは外部へ出られないので、地形・ベースマップ・
 * 建物タイルは応答なしになる。**自前 API への要求は出る**ので、
 * 「取り直そうとしたか」は測れる。
 */

import { chromium } from 'playwright-core';

/** 追従の対象。カメラ周辺ぶんしか読んでいないもの */
const FOLLOWED = ['/api/roads', '/api/structures', '/api/poi', '/api/furniture'];

interface Hit {
  /** 開いてからの経過 (ms) */
  at: number;
  path: string;
  bbox: string;
}

/** 要求 URL から、追従対象の種類と範囲を取り出す */
function readHit(url: string, at: number): Hit | null {
  const path = FOLLOWED.find((p) => url.includes(p));
  if (!path) return null;
  const params = new URL(url).searchParams;
  // 道路と高架は bbox、周辺施設は中心座標で要求する
  const bbox = params.get('bbox') ?? `${params.get('lat') ?? ''},${params.get('lng') ?? ''}`;
  return { at, path, bbox };
}

async function main() {
  const target = process.argv[2] ?? 'http://localhost:3100/';

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  // iPhone 17 相当。実機に近い画面で測る
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const hits: Hit[] = [];
  let start = Date.now();
  page.on('request', (req) => {
    const hit = readHit(req.url(), Date.now() - start);
    if (hit) hits.push(hit);
  });

  start = Date.now();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // 地図が組み上がるまで待つ
  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForTimeout(8_000);

  /**
   * 追従の対象を出す。
   *
   * 起動時の都市（東京都心）では、道路も高架も既定では出していない。
   * 出していないものは追従しないので、まず「表示する」を押しておく。
   */
  await page.getByRole('button', { name: '表示', exact: true }).first().click();
  await page.waitForTimeout(1_000);
  for (const label of ['車道・信号・線路', '高架・橋']) {
    const chip = page.getByRole('button', { name: label, exact: true }).first();
    if ((await chip.count()) === 0) {
      console.log(`（「${label}」の切り替えが見つからない）`);
      continue;
    }
    await chip.click();
    // 取り寄せに時間がかかる（Overpass 経由）
    await page.waitForTimeout(15_000);
  }
  const beforeDrag = hits.length;

  /**
   * 地図をドラッグして動かす。
   *
   * 画面の高さのぶんだけ引くと、俯角 45 度・高度 600m の視点では
   * 数百メートルから 1km ほど進む。**離したあとは一切触らない。**
   */
  // 下シートが開いているので、画面の上のほうでなぞる。
  // canvas の外接矩形は取りに行かない（描画が重いと取得が詰まる）
  const view = page.viewportSize() ?? { width: 402, height: 874 };
  const cx = view.width / 2;
  const from = 300;

  await page.mouse.move(cx, from);
  await page.mouse.down();
  const pressedAt = Date.now() - start;
  // 一気に動かすと Cesium が 1 フレームで処理してしまう。
  // 指でなぞるのと同じように刻む
  for (let i = 1; i <= 20; i += 1) {
    await page.mouse.move(cx, from - i * 12);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  const releasedAt = Date.now() - start;

  // ここから先は触らない。追従だけを見る
  await page.waitForTimeout(20_000);
  await browser.close();

  /**
   * 画面に触れたのは `mousedown` の一度だけ。
   *
   * そのとき地図はまだ動いていないので、**操作の始まりを見る古いやり方では
   * ここで何も起こらない**。以降に飛んだ要求は、すべてカメラの移動そのものを
   * 見て飛んだものになる。
   */
  const duringDrag = hits.filter((h) => h.at > pressedAt && h.at <= releasedAt);
  const afterRelease = hits.filter((h) => h.at > releasedAt);
  const followed = duringDrag.length + afterRelease.length;

  console.log(`## ${target}（iPhone 17 相当の画面）\n`);
  console.log(`| 区間 | 本数 |`);
  console.log(`|---|---:|`);
  console.log(`| 起動〜指を置くまで（起動時の読み込み） | ${beforeDrag} |`);
  console.log(`| なぞっている間（camera.changed） | ${duringDrag.length} |`);
  console.log(`| 離したあと（camera.moveEnd） | ${afterRelease.length} |`);
  console.log(
    `\n画面に触れたのは指を置いた 1 回だけ。そのとき地図はまだ動いていないので、` +
      `\n**操作の始まりだけを見ていた頃はここが 0 本**だった。今回は ${followed} 本。\n`,
  );

  if (followed === 0) {
    console.log('（1 本も飛んでいない。移動先のデータは読み込まれない）');
  } else {
    console.log('| 経過 (ms) | 種類 | 範囲 |');
    console.log('|---:|---|---|');
    for (const h of [...duringDrag, ...afterRelease]) {
      console.log(`| ${h.at} | ${h.path} | ${h.bbox} |`);
    }
  }

  // 範囲が本当に動いたかも見る。同じ範囲を要求し直しているだけなら意味がない
  console.log('');
  for (const path of FOLLOWED) {
    const list = hits.filter((h) => h.path === path);
    if (list.length === 0) continue;
    const ranges = new Set(list.map((h) => h.bbox));
    console.log(`${path}: ${list.length} 本 / 異なる範囲 ${ranges.size} 通り`);
  }

  if (followed === 0) process.exitCode = 1;
}

void main();
