/**
 * Google Gemini プロバイダ（generateContent API）。
 *
 * 仕様: POST {baseUrl}/v1beta/models/{model}:generateContent?key=...
 *   tools: [{ functionDeclarations: [{ name, description, parameters }] }]
 *   応答: candidates[0].content.parts[] に text または functionCall
 *   ツール結果: parts に { functionResponse: { name, response } }
 */

import type { AIProvider, ChatRequest, ChatResponse, ToolCall } from '../types';

export interface GeminiOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  error?: { message?: string };
  modelVersion?: string;
}

/** Gemini の function declaration は JSON Schema のサブセットのみ受け付ける */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== 'object' || schema === null) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // additionalProperties / $schema などは受け付けない
    if (key === 'additionalProperties' || key === '$schema') continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const contents: Record<string, unknown>[] = [];

    for (const m of request.messages) {
      if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: m.toolName ?? 'tool',
                response: { result: m.content },
              },
            },
          ],
        });
      } else if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      } else {
        contents.push({ role: 'user', parts: [{ text: m.content }] });
      }
    }

    const body: Record<string, unknown> = {
      contents,
      tools: [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeSchema(t.parameters),
          })),
        },
      ],
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? 1024,
      },
    };
    if (request.system) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }

    const baseUrl = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const res = await fetch(
      `${baseUrl}/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60000),
      },
    );

    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `LLM リクエストに失敗しました (HTTP ${res.status})`);
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    return { content, toolCalls, model: json.modelVersion ?? this.model };
  }
}
