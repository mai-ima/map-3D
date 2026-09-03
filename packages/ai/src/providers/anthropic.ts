/**
 * Anthropic Messages API プロバイダ。
 *
 * 仕様: POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01
 *   tools:   [{ name, description, input_schema }]
 *   応答:    content ブロック配列（text / tool_use）、stop_reason === 'tool_use'
 *   ツール結果: user メッセージ内の { type: 'tool_result', tool_use_id, content }
 *
 * 本プロジェクトはマルチプロバイダ要件のため公式 SDK ではなく fetch で実装している
 * （依存を増やさず Edge ランタイムでも動かすため）。
 */

import type { AIProvider, ChatRequest, ChatResponse, ToolCall } from '../types';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  version?: string;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor(private readonly options: AnthropicOptions) {
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages: Record<string, unknown>[] = [];

    for (const m of request.messages) {
      if (m.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: m.content,
            },
          ],
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: Record<string, unknown>[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        messages.push({ role: 'assistant', content: blocks });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
    if (request.system) body.system = request.system;

    let res: Response;
    try {
      res = await fetch(`${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': this.options.version ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60000),
      });
    } catch (e) {
      // 通信の失敗は 'fetch failed' という英語の内部メッセージで来る
      throw new Error('AI サービスに接続できませんでした', { cause: e });
    }

    const json = (await res.json().catch(() => ({}))) as AnthropicResponse;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `LLM リクエストに失敗しました (HTTP ${res.status})`);
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text) content += block.text;
      if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id ?? `tool_${toolCalls.length}`,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    return { content, toolCalls, model: json.model ?? this.model };
  }
}
