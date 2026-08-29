/**
 * AIProvider のファクトリ。
 *
 * 「どのベンダーを使うか」はここだけが知っている。
 * アプリの他の場所にプロバイダ名は現れない（要件: ハードコード禁止）。
 */

import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAICompatibleProvider } from './providers/openai';
import type { AIProvider } from './types';

export interface AIEnv {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;

  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;

  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;

  GEMINI_API_KEY?: string;
  GEMINI_BASE_URL?: string;

  /** ローカル LLM（OpenAI 互換エンドポイント） */
  LOCAL_LLM_BASE_URL?: string;
  LOCAL_LLM_API_KEY?: string;
}

/** プロバイダ未設定時の既定モデル */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-opus-5',
  gemini: 'gemini-2.0-flash',
  local: 'llama3.1',
};

export class AIProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderNotConfiguredError';
  }
}

export function isAIConfigured(env: AIEnv = process.env as AIEnv): boolean {
  const provider = (env.AI_PROVIDER ?? '').toLowerCase();
  if (!provider) return false;
  switch (provider) {
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    case 'anthropic':
      return Boolean(env.ANTHROPIC_API_KEY);
    case 'gemini':
      return Boolean(env.GEMINI_API_KEY);
    case 'local':
      return Boolean(env.LOCAL_LLM_BASE_URL);
    default:
      return false;
  }
}

export function createAIProvider(env: AIEnv = process.env as AIEnv): AIProvider {
  const provider = (env.AI_PROVIDER ?? '').toLowerCase();
  const timeoutMs = Number(env.AI_TIMEOUT_MS ?? 60000);
  const model = env.AI_MODEL ?? DEFAULT_MODELS[provider] ?? '';

  switch (provider) {
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new AIProviderNotConfiguredError('OPENAI_API_KEY が設定されていません');
      }
      return new OpenAICompatibleProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model,
        timeoutMs,
      });

    case 'anthropic':
      if (!env.ANTHROPIC_API_KEY) {
        throw new AIProviderNotConfiguredError('ANTHROPIC_API_KEY が設定されていません');
      }
      return new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
        model,
        timeoutMs,
      });

    case 'gemini':
      if (!env.GEMINI_API_KEY) {
        throw new AIProviderNotConfiguredError('GEMINI_API_KEY が設定されていません');
      }
      return new GeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        baseUrl: env.GEMINI_BASE_URL,
        model,
        timeoutMs,
      });

    case 'local':
      if (!env.LOCAL_LLM_BASE_URL) {
        throw new AIProviderNotConfiguredError('LOCAL_LLM_BASE_URL が設定されていません');
      }
      return new OpenAICompatibleProvider({
        apiKey: env.LOCAL_LLM_API_KEY,
        baseUrl: env.LOCAL_LLM_BASE_URL,
        model,
        timeoutMs,
        displayName: 'local',
      });

    default:
      throw new AIProviderNotConfiguredError(
        'AI_PROVIDER が未設定です（openai / anthropic / gemini / local のいずれかを指定してください）',
      );
  }
}
