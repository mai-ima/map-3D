/**
 * LLM プロバイダの応答解析と、鍵の渡し方。
 *
 * 鍵を URL のクエリに載せると、アクセスログ・プロキシ・エラー報告に
 * そのまま写る。ヘッダで渡していることをテストで固定しておく。
 *
 * 応答の解析は経路エンジンと同じで、必須のはずの項目が欠けて届く。
 * ローカルモデル（OpenAI 互換を名乗るもの）は特に形が揺れる。
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { OpenAICompatibleProvider } from '../providers/openai';
import type { ChatRequest } from '../types';

const REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: '浜松駅に移動して' }],
  tools: [
    {
      name: 'set_camera',
      description: '地図を移動する',
      parameters: { type: 'object', properties: { place: { type: 'string' } } },
    },
  ],
  system: 'あなたは地図のアシスタントです',
};

const SECRET = 'sk-test-do-not-log-12345';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** fetch を差し替え、送られた URL とヘッダを記録する */
function capture(payload: unknown, status = 200) {
  const seen = { url: '', headers: {} as Record<string, string> };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

describe('Gemini', () => {
  test('API キーを URL に載せない', async () => {
    const seen = capture({
      candidates: [{ content: { parts: [{ text: 'はい' }] } }],
      modelVersion: 'gemini-2.0-flash',
    });
    const provider = new GeminiProvider({ apiKey: SECRET, model: 'gemini-2.0-flash' });
    await provider.chat(REQUEST);

    assert.ok(!seen.url.includes(SECRET), `URL に鍵が入っている: ${seen.url}`);
    assert.ok(!seen.url.includes('key='), `URL にクエリの鍵が残っている: ${seen.url}`);
    assert.equal(seen.headers['x-goog-api-key'], SECRET, 'ヘッダで鍵を渡していない');
  });

  test('candidates が空でも落ちない', async () => {
    capture({});
    const provider = new GeminiProvider({ apiKey: SECRET, model: 'gemini-2.0-flash' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.content, '');
    assert.deepEqual(res.toolCalls, []);
  });

  test('関数呼び出しを読み取る', async () => {
    capture({
      candidates: [
        {
          content: {
            parts: [
              { text: '移動します' },
              { functionCall: { name: 'set_camera', args: { place: '浜松駅' } } },
            ],
          },
        },
      ],
    });
    const provider = new GeminiProvider({ apiKey: SECRET, model: 'gemini-2.0-flash' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.content, '移動します');
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].name, 'set_camera');
    assert.deepEqual(res.toolCalls[0].arguments, { place: '浜松駅' });
  });

  test('通信できないときは日本語で伝える', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new GeminiProvider({ apiKey: SECRET, model: 'gemini-2.0-flash' });
    await assert.rejects(
      () => provider.chat(REQUEST),
      (e: unknown) => e instanceof Error && /接続できません/.test(e.message),
    );
  });
});

describe('Anthropic', () => {
  test('鍵はヘッダで渡す', async () => {
    const seen = capture({ content: [{ type: 'text', text: 'はい' }] });
    const provider = new AnthropicProvider({ apiKey: SECRET, model: 'claude-opus-5' });
    await provider.chat(REQUEST);
    assert.ok(!seen.url.includes(SECRET), 'URL に鍵が入っている');
    assert.equal(seen.headers['x-api-key'], SECRET);
  });

  test('content が無くても落ちない', async () => {
    capture({});
    const provider = new AnthropicProvider({ apiKey: SECRET, model: 'claude-opus-5' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.content, '');
    assert.deepEqual(res.toolCalls, []);
  });

  test('tool_use ブロックを読み取る', async () => {
    capture({
      content: [
        { type: 'text', text: '探します' },
        { type: 'tool_use', id: 'tu_1', name: 'set_camera', input: { place: '浜松駅' } },
      ],
    });
    const provider = new AnthropicProvider({ apiKey: SECRET, model: 'claude-opus-5' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.toolCalls[0].id, 'tu_1');
    assert.deepEqual(res.toolCalls[0].arguments, { place: '浜松駅' });
  });
});

describe('OpenAI 互換', () => {
  test('鍵は Authorization ヘッダで渡す', async () => {
    const seen = capture({ choices: [{ message: { content: 'はい' } }] });
    const provider = new OpenAICompatibleProvider({ apiKey: SECRET, model: 'gpt-4o-mini' });
    await provider.chat(REQUEST);
    assert.ok(!seen.url.includes(SECRET), 'URL に鍵が入っている');
    assert.equal(seen.headers.Authorization, `Bearer ${SECRET}`);
  });

  test('function を欠いた tool_call は捨てる', async () => {
    // OpenAI 互換を名乗るローカルモデルが返すことがある。
    // そのまま tc.function.name を読むと TypeError になっていた
    capture({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'a', type: 'function' },
              { id: 'b', type: 'function', function: { name: 'set_camera', arguments: '{"place":"浜松駅"}' } },
            ],
          },
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({ apiKey: SECRET, model: 'llama3.1' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].name, 'set_camera');
  });

  test('引数が壊れた JSON でも空の引数として扱う', async () => {
    capture({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'a', function: { name: 'set_camera', arguments: '{壊れている' } }],
          },
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({ apiKey: SECRET, model: 'llama3.1' });
    const res = await provider.chat(REQUEST);
    assert.deepEqual(res.toolCalls[0].arguments, {});
  });

  test('choices が無くても落ちない', async () => {
    capture({});
    const provider = new OpenAICompatibleProvider({ apiKey: SECRET, model: 'llama3.1' });
    const res = await provider.chat(REQUEST);
    assert.equal(res.content, '');
    assert.deepEqual(res.toolCalls, []);
  });

  test('ローカル LLM が起動していないときは日本語で伝える', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      displayName: 'local',
    });
    await assert.rejects(
      () => provider.chat(REQUEST),
      (e: unknown) => e instanceof Error && /接続できません/.test(e.message),
    );
  });
});
