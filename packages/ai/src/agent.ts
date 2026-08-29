/**
 * 地図エージェント。
 *
 *   User → LLM → Tool Selection → Geo Tools → GIS/Routing
 *        → Result → LLM → UI Command → Cesium
 *
 * ツール実行回数には上限を設け、暴走とコスト超過を防ぐ。
 */

import type { Route } from '@ijm/shared';
import { attributionStrings } from '@ijm/shared';
import { executeTool, type ToolExecutionContext } from './executor';
import { buildSystemPrompt } from './prompt';
import { GEO_TOOLS } from './tools';
import type { AIProvider, AgentResult, ChatMessage, MapContext } from './types';

export interface RunAgentOptions {
  provider: AIProvider;
  messages: ChatMessage[];
  mapContext: MapContext;
  /** 1 リクエストあたりのツール実行上限 */
  maxToolCalls?: number;
  /** LLM への往復回数の上限 */
  maxIterations?: number;
}

export async function runMapAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { provider, mapContext } = options;
  const maxToolCalls = options.maxToolCalls ?? 5;
  const maxIterations = options.maxIterations ?? 4;

  const ctx: ToolExecutionContext = {
    mapContext,
    lastRoute: null as Route | null,
    uiCommands: [],
    attribution: new Set<string>(),
    knownPoints: [],
  };

  const messages: ChatMessage[] = [...options.messages];
  const executed: AgentResult['toolCalls'] = [];
  let reply = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await provider.chat({
      messages,
      tools: GEO_TOOLS,
      system: buildSystemPrompt(mapContext),
      maxTokens: 1024,
    });

    if (response.content) reply = response.content;

    if (response.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      if (executed.length >= maxToolCalls) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({ error: 'ツール実行回数の上限に達しました' }),
        });
        continue;
      }

      const result = await executeTool(call, ctx);
      executed.push({
        name: call.name,
        arguments: call.arguments,
        ok: result.ok,
        error: result.error,
      });

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: result.ok ? result.content : JSON.stringify({ error: result.error }),
      });
    }
  }

  if (!reply) {
    reply = executed.some((e) => e.ok)
      ? '地図を更新しました。'
      : '要求を処理できませんでした。もう少し具体的に指定してください。';
  }

  return {
    reply,
    toolCalls: executed,
    uiCommands: ctx.uiCommands,
    attribution: attributionStrings([...ctx.attribution]),
  };
}
