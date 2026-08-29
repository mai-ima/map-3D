/**
 * OpenAI 互換プロバイダ（Chat Completions API）。
 *
 * ローカルモデル（Ollama / llama.cpp / vLLM など）も同じ形式を実装しているため、
 * baseUrl を差し替えるだけで再利用できる。
 */

import type { AIProvider, ChatRequest, ChatResponse, ToolCall } from '../types';

export interface OpenAICompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  /** プロバイダ表示名（local との区別用） */
  displayName?: string;
}

interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  }[];
  error?: { message?: string };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.displayName ?? 'openai';
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages: Record<string, unknown>[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });

    for (const m of request.messages) {
      if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.2,
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };

    const baseUrl = this.options.baseUrl ?? 'https://api.openai.com/v1';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60000),
    });

    const json = (await res.json().catch(() => ({}))) as OpenAIResponse;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `LLM リクエストに失敗しました (HTTP ${res.status})`);
    }

    const message = json.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParse(tc.function.arguments),
    }));

    return { content: message?.content ?? '', toolCalls, model: json.model ?? this.model };
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
