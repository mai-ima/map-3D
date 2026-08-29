/**
 * AI レイヤの共通型。
 *
 * 特定ベンダーの SDK には依存しない。各プロバイダは fetch でこの型に写像する。
 */

import type { LatLng, Poi, Route, SearchResult, TravelMode } from '@ijm/shared';

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** role === 'tool' のとき、対応する tool_call の ID */
  toolCallId?: string;
  /** role === 'tool' のとき、ツール名 */
  toolName?: string;
  /** role === 'assistant' がツールを呼んだ場合 */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** JSON Schema（各プロバイダの形式へ変換される） */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  /** 使用したモデル名（デバッグ表示用） */
  model?: string;
}

/**
 * LLM プロバイダの抽象。
 * OpenAI / Anthropic / Gemini / ローカルモデルをこの裏に隠す。
 */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

// ---- 地図操作コマンド ---------------------------------------------------

/**
 * AI が「地図に何をさせたいか」を表す UI コマンド。
 * AI は Cesium を直接触らず、必ずこのコマンドを経由する。
 */
export type UICommand =
  | { type: 'setCamera'; payload: { position: LatLng; height?: number; heading?: number; pitch?: number } }
  | { type: 'highlightLocation'; payload: { position: LatLng; label: string } }
  | { type: 'showRoute'; payload: { route: Route } }
  | { type: 'showPois'; payload: { pois: Poi[] } }
  | { type: 'startNavigation'; payload: { routeId: string } }
  | { type: 'setTimeOfDay'; payload: { hour: number } }
  | { type: 'setWeather'; payload: { weather: string } }
  | { type: 'showSearchResults'; payload: { results: SearchResult[] } }
  | { type: 'showBuildingInfo'; payload: { position: LatLng } };

/** クライアントから送られてくる地図の状態 */
export interface MapContext {
  camera?: { center: LatLng; height: number; heading: number; pitch: number };
  /** 画面中心の地表座標 */
  viewCenter?: LatLng;
  cityName?: string;
  activeRoute?: { id: string; mode: TravelMode; distance: number; duration: number } | null;
  timeOfDay?: number;
}

export interface AgentResult {
  reply: string;
  toolCalls: { name: string; arguments: Record<string, unknown>; ok: boolean; error?: string }[];
  uiCommands: UICommand[];
  attribution: string[];
}
