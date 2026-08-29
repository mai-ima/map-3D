/**
 * AIProvider のファクトリ。
 *
 * 「どのベンダーを使うか」はここだけが知っている。
 * アプリの他の場所にプロバイダ名は現れない（要件: ハードコード禁止）。
 */

import { envFirst, envNumber, envOptionalUrl } from '@ijm/shared';
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
  const provider = (envFirst(env.AI_PROVIDER) ?? '').toLowerCase();
  if (!provider) return false;
  switch (provider) {
    case 'openai':
      return Boolean(envFirst(env.OPENAI_API_KEY));
    case 'anthropic':
      return Boolean(envFirst(env.ANTHROPIC_API_KEY));
    case 'gemini':
      return Boolean(envFirst(env.GEMINI_API_KEY));
    case 'local':
      return Boolean(envOptionalUrl(env.LOCAL_LLM_BASE_URL));
    default:
      return false;
  }
}

export function createAIProvider(env: AIEnv = process.env as AIEnv): AIProvider {
  const provider = (envFirst(env.AI_PROVIDER) ?? '').toLowerCase();
  const timeoutMs = envNumber(env.AI_TIMEOUT_MS, 60000);
  const model = envFirst(env.AI_MODEL) ?? DEFAULT_MODELS[provider] ?? '';
  const apiKey = {
    openai: envFirst(env.OPENAI_API_KEY),
    anthropic: envFirst(env.ANTHROPIC_API_KEY),
    gemini: envFirst(env.GEMINI_API_KEY),
    local: envFirst(env.LOCAL_LLM_API_KEY),
  };

  switch (provider) {
    case 'openai':
      if (!apiKey.openai) {
        throw new AIProviderNotConfiguredError('OPENAI_API_KEY が設定されていません');
      }
      return new OpenAICompatibleProvider({
        apiKey: apiKey.openai,
        baseUrl: envOptionalUrl(env.OPENAI_BASE_URL),
        model,
        timeoutMs,
      });

    case 'anthropic':
      if (!apiKey.anthropic) {
        throw new AIProviderNotConfiguredError('ANTHROPIC_API_KEY が設定されていません');
      }
      return new AnthropicProvider({
        apiKey: apiKey.anthropic,
        baseUrl: envOptionalUrl(env.ANTHROPIC_BASE_URL),
        model,
        timeoutMs,
      });

    case 'gemini':
      if (!apiKey.gemini) {
        throw new AIProviderNotConfiguredError('GEMINI_API_KEY が設定されていません');
      }
      return new GeminiProvider({
        apiKey: apiKey.gemini,
        baseUrl: envOptionalUrl(env.GEMINI_BASE_URL),
        model,
        timeoutMs,
      });

    case 'local': {
      const localBaseUrl = envOptionalUrl(env.LOCAL_LLM_BASE_URL);
      if (!localBaseUrl) {
        throw new AIProviderNotConfiguredError('LOCAL_LLM_BASE_URL が設定されていません');
      }
      return new OpenAICompatibleProvider({
        apiKey: apiKey.local,
        baseUrl: localBaseUrl,
        model,
        timeoutMs,
        displayName: 'local',
      });
    }

    default:
      throw new AIProviderNotConfiguredError(
        'AI_PROVIDER が未設定です（openai / anthropic / gemini / local のいずれかを指定してください）',
      );
  }
}
