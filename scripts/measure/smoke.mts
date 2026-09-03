/**
 * 実機ブラウザでの通し確認。
 *
 * 型検査とテストでは見つからないものを拾う。
 *
 *   - 画面を開いたときのコンソールエラー・未処理の例外
 *   - パネルを開いたときに壊れる React の描画
 *   - API が 500 を返していないか
 *
 * この環境のブラウザは外部へ出られないので、地形とベースマップは
 * 「応答なし」になる。**それでも画面が壊れないこと**を見るのが主目的。
 * 見た目の良し悪しは判定しない（スクリーンショットは人が見る）。
 *
 * 使い方（先に `npm run build && npx next start -p 3100` を立てておく）:
 *   npx tsx scripts/measure/smoke.mts [URL]
 */

import { chromium } from 'playwright-core';

/** 外部へ出られないことに由来するもの。ここでは失敗にしない */
const EXPECTED = [
  /net::ERR/i,
  /Failed to load resource/i,
  /tile\.plateauview/i,
  /cyberjapandata/i,
  /assets\.cms\.plateau/i,
  /WebGL/i,
  /Failed to fetch/i,
];

function expected(text: string): boolean {
  return EXPECTED.some((re) => re.test(text));
}

async function main() {
  const target = process.argv[2] ?? 'http://localhost:3100/';

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!expected(text)) problems.push(`コンソール: ${text}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`未処理の例外: ${error.message}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    if (res.status() >= 500) problems.push(`API が ${res.status()}: ${url}`);
  });

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(12_000);

  // 下シートのタブを一通り開く。描画が壊れていればここで例外が出る
  const tabs = ['ルート', '表示', 'AI'];
  for (const label of tabs) {
    const tab = page.getByRole('button', { name: label }).first();
    if ((await tab.count()) === 0) continue;
    try {
      await tab.click({ timeout: 5_000 });
      await page.waitForTimeout(1_500);
    } catch {
      // タブが無い構成もある。開けないこと自体は失敗にしない
    }
  }

  // 画面に何か描かれているか（真っ白でないか）
  const hasCanvas = (await page.locator('canvas').count()) > 0;
  if (!hasCanvas) problems.push('canvas が 1 つも無い（地図が作られていない）');

  await browser.close();

  if (problems.length === 0) {
    console.log('問題は見つからなかった。');
    return;
  }
  console.log(`${problems.length} 件の問題:`);
  for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
  process.exitCode = 1;
}

void main();
