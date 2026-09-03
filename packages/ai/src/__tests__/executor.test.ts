/**
 * AI のツール実行。
 *
 * ここは「LLM が書いた値」が地図に入ってくる唯一の入口で、信用境界にあたる。
 * LLM は学習した別サービスの仕様をそのまま書いてくることがあり、
 * 未対応の移動手段、負の半径、上下反転する俯角のような値が普通に届く。
 * 座標を knownPoints で検証しているのと同じ理由で、数値も範囲を確かめる。
 *
 * 場所名の解決は 'current' を使えば地図の中心で済むので、
 * ここでは外部への問い合わせを一切せずに検証できる。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executeTool, type ToolExecutionContext } from '../executor';
import type { ToolCall, UICommand } from '../types';

/** 浜松駅前を地図の中心とした文脈 */
function context(): ToolExecutionContext {
  return {
    mapContext: { viewCenter: { lat: 34.7048, lng: 137.7345 }, cityName: '浜松市' },
    lastRoute: null,
    uiCommands: [],
    attribution: new Set<string>(),
    knownPoints: [],
  };
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 't1', name, arguments: args };
}

function cameraOf(commands: UICommand[]) {
  const cmd = commands.find((c) => c.type === 'setCamera');
  assert.ok(cmd, 'setCamera コマンドが無い');
  return (cmd as Extract<UICommand, { type: 'setCamera' }>).payload;
}

describe('カメラ操作の値を検証する', () => {
  test('指定が無ければ既定の高度と俯角になる', async () => {
    const ctx = context();
    const result = await executeTool(call('set_camera', { place: 'current' }), ctx);
    assert.equal(result.ok, true, result.error);
    const payload = cameraOf(ctx.uiCommands);
    assert.equal(payload.height, 500);
    assert.equal(payload.pitch, -40);
  });

  test('俯角が範囲外なら真下〜水平に収める', async () => {
    // -400 度をそのまま渡すと上下が反転して空が下に来る
    const ctx = context();
    await executeTool(call('set_camera', { place: 'current', pitch: -400 }), ctx);
    assert.equal(cameraOf(ctx.uiCommands).pitch, -90);

    const ctx2 = context();
    await executeTool(call('set_camera', { place: 'current', pitch: 75 }), ctx2);
    assert.equal(cameraOf(ctx2.uiCommands).pitch, 0);
  });

  test('高度 0 は地面の中なので下限まで持ち上げる', async () => {
    const ctx = context();
    await executeTool(call('set_camera', { place: 'current', height: 0 }), ctx);
    assert.equal(cameraOf(ctx.uiCommands).height, 30);
  });

  test('高度が極端に大きくても上限で止まる', async () => {
    const ctx = context();
    await executeTool(call('set_camera', { place: 'current', height: 1e9 }), ctx);
    assert.equal(cameraOf(ctx.uiCommands).height, 20000);
  });

  test('数値でない値は既定値として扱う', async () => {
    const ctx = context();
    await executeTool(call('set_camera', { place: 'current', height: '高いところ', pitch: null }), ctx);
    const payload = cameraOf(ctx.uiCommands);
    assert.equal(payload.height, 500);
    assert.equal(payload.pitch, -40);
  });
});

describe('周辺検索の引数を検証する', () => {
  test('負の半径・件数は通さない', async () => {
    // 半径が負だと Overpass に成立しない検索が飛び、
    // 件数が負だと slice(0, -n) になって結果が丸ごと消える。
    // 検索そのものは通信するので、ここでは値が正されることだけを見る
    const ctx = context();
    const original = globalThis.fetch;
    let seenUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(typeof input === 'string' ? input : (input as Request).url ?? input);
      const body = typeof init?.body === 'string' ? init.body : '';
      // Overpass への問い合わせ本文に半径が入る
      seenUrl += ` ${body}`;
      return new Response(JSON.stringify({ elements: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await executeTool(
        call('search_nearby', { place: 'current', radius: -500, limit: -3 }),
        ctx,
      );
    } finally {
      globalThis.fetch = original;
    }

    assert.ok(!/-500/.test(seenUrl), `負の半径が外に出ている: ${seenUrl.slice(0, 200)}`);
  });
});

describe('移動手段を検証する', () => {
  test('未対応の移動手段は通信する前に断る', async () => {
    // LLM は 'car' 'transit_bus' のような別サービスの語を書いてくる。
    // 通さずに弾かないと、経路エンジンの英語の内部エラーが利用者に出る
    const ctx = context();
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    let result;
    try {
      result = await executeTool(
        call('calculate_route', { from: 'current', to: 'current', mode: 'car' }),
        ctx,
      );
    } finally {
      globalThis.fetch = original;
    }

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /未対応の移動手段/);
    assert.equal(called, false, '通信してしまっている');
  });
});

describe('時刻と天候', () => {
  test('0〜23.99 の外は断る', async () => {
    const ctx = context();
    assert.equal((await executeTool(call('set_time_of_day', { hour: -1 }), ctx)).ok, false);
    assert.equal((await executeTool(call('set_time_of_day', { hour: 24 }), ctx)).ok, false);
    assert.equal((await executeTool(call('set_time_of_day', { hour: 0 }), ctx)).ok, true);
    assert.equal((await executeTool(call('set_time_of_day', { hour: 23.5 }), ctx)).ok, true);
  });

  test('未対応の天候は断る', async () => {
    const ctx = context();
    assert.equal((await executeTool(call('set_weather', { weather: 'typhoon' }), ctx)).ok, false);
    assert.equal((await executeTool(call('set_weather', { weather: 'rain' }), ctx)).ok, true);
  });
});

describe('経路が無いまま案内は始めない', () => {
  test('start_navigation は先に経路が要る', async () => {
    const ctx = context();
    const result = await executeTool(call('start_navigation'), ctx);
    assert.equal(result.ok, false);
    assert.equal(ctx.uiCommands.length, 0);
  });
});

describe('地図の中心が無いとき', () => {
  test('場所を特定できなければコマンドを出さない', async () => {
    // 起動直後など、まだ地図の中心が定まっていないことがある
    const ctx: ToolExecutionContext = { ...context(), mapContext: {} };
    const result = await executeTool(call('set_camera', { place: 'current' }), ctx);
    assert.equal(result.ok, false);
    assert.equal(ctx.uiCommands.length, 0);
  });
});
