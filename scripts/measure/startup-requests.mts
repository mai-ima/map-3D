/**
 * 起動直後の取得の集中を実機ブラウザで測る。
 *
 * 「起動時に取得が集中している」という宿題を、感覚ではなく数で扱うために作った。
 * 測るのは 3 つ。
 *
 *   1. 秒ごとに何本の要求が飛んでいるか（山がどこにあるか）
 *   2. 種類ごとの内訳（地形 / ベースマップ / 建物タイル / 自前 API）
 *   3. 最初の建物タイルが返るまでの時間
 *
 * 使い方（先に `npm run build && npm start` でサーバを立てておく）:
 *   npx tsx scripts/measure/startup-requests.mts [URL] [秒数]
 *
 * Chromium はこの環境に入っている（PLAYWRIGHT_BROWSERS_PATH）。
 * 取りに行かせない（playwright install は実行しない）。
 */

import { chromium } from 'playwright-core';

interface Entry {
  /** 開いてからの経過 (ms) */
  at: number;
  kind: string;
  url: string;
  /** 応答が返るまで (ms)。返らなかったものは undefined のまま */
  tookMs?: number;
}

/** URL から取得の種類を見分ける */
function classify(url: string): string {
  if (url.includes('/api/tileset')) return 'tileset.json';
  if (url.includes('/api/')) return '自前 API';
  if (/\.(b3dm|cmpt|glb|gltf)(\?|$)/.test(url)) return '建物タイル';
  if (url.includes('/terrain') || /\.terrain(\?|$)/.test(url)) return '地形';
  if (url.includes('cyberjapandata') || /\/\d+\/\d+\/\d+\.(png|jpg|webp)(\?|$)/.test(url)) {
    return 'ベースマップ';
  }
  if (url.includes('/cesium/')) return 'Cesium アセット';
  if (/\.(js|css|woff2?)(\?|$)/.test(url)) return 'アプリ本体';
  return 'その他';
}

async function main() {
  const target = process.argv[2] ?? 'http://localhost:3000/';
  const seconds = Number(process.argv[3] ?? 20);

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

  const entries: Entry[] = [];
  let start = Date.now();
  const pending = new Map<unknown, Entry>();
  page.on('request', (req) => {
    const entry: Entry = { at: Date.now() - start, kind: classify(req.url()), url: req.url() };
    entries.push(entry);
    pending.set(req, entry);
  });
  page.on('response', (res) => {
    const entry = pending.get(res.request());
    if (entry) entry.tookMs = Date.now() - start - entry.at;
  });

  start = Date.now();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(seconds * 1000);

  // 文字列で渡す。関数で渡すと tsx（esbuild）が付ける補助関数が
  // ブラウザ側に無く、ReferenceError になる
  const fps = (await page.evaluate(`new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames += 1;
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
      else resolve((frames / (performance.now() - t0)) * 1000);
    };
    requestAnimationFrame(tick);
  })`)) as number;

  await browser.close();

  const kinds = [...new Set(entries.map((e) => e.kind))];
  console.log(`## ${target}（${seconds} 秒間、iPhone 17 相当の画面）\n`);
  console.log(`要求は全部で ${entries.length} 本\n`);

  console.log('### 秒ごとの本数\n');
  console.log(`| 秒 | ${kinds.join(' | ')} | 計 |`);
  console.log(`|---|${kinds.map(() => '---:').join('|')}|---:|`);
  for (let s = 0; s < seconds; s += 1) {
    const inSecond = entries.filter((e) => e.at >= s * 1000 && e.at < (s + 1) * 1000);
    if (inSecond.length === 0) continue;
    const cells = kinds.map((k) => inSecond.filter((e) => e.kind === k).length);
    console.log(`| ${s}–${s + 1} | ${cells.join(' | ')} | ${inSecond.length} |`);
  }

  console.log('\n### 種類ごとの合計と、最初に出た時刻\n');
  console.log('| 種類 | 本数 | 最初 (ms) | 最後 (ms) |');
  console.log('|---|---:|---:|---:|');
  for (const kind of kinds) {
    const list = entries.filter((e) => e.kind === kind);
    console.log(`| ${kind} | ${list.length} | ${list[0].at} | ${list[list.length - 1].at} |`);
  }

  if (process.env.VERBOSE) {
    console.log('\n### 要求の全一覧\n');
    for (const e of entries) {
      const took = e.tookMs === undefined ? '  (応答なし)' : `${String(e.tookMs).padStart(6)}ms で応答`;
      console.log(`${String(e.at).padStart(6)}ms  ${took}  ${e.kind}  ${e.url}`);
    }
  }

  const firstTile = entries.find((e) => e.kind === '建物タイル');
  console.log(
    `\n最初の建物タイルの要求: ${firstTile ? `${firstTile.at}ms` : '（この時間内には出なかった）'}`,
  );
  console.log(`終盤の FPS: ${fps.toFixed(1)}`);
}

void main();
