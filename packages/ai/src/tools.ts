/**
 * AI に公開する「地図ツール」の定義。
 *
 * AI は地図を直接操作せず、必ずこれらのツール呼び出しを経由する。
 * ツールの実体は executor.ts にあり、GIS / ルーティングの各パッケージへ委譲する。
 */

import type { ToolDefinition } from './types';

export const GEO_TOOLS: ToolDefinition[] = [
  {
    name: 'search_place',
    description:
      '地名・駅名・施設名から場所を検索して緯度経度を得る。ユーザーが場所を言葉で指定したときは必ずこれを使う。緯度経度を推測してはいけない。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索する場所の名前（例: 東京駅、皇居、渋谷スクランブル交差点）' },
        near: {
          type: 'string',
          description: '近傍を優先したい場合の基準地名。省略時は現在の地図の中心を使う。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_nearby',
    description:
      '指定地点の周辺にある施設（コンビニ・カフェ・飲食店・駅・公園など）を検索する。「近くの〇〇」という質問に使う。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'カテゴリ（convenience / cafe / restaurant / station / park / hospital / parking / hotel など。日本語も可）',
        },
        place: {
          type: 'string',
          description: '基準となる場所の名前。省略時は現在の地図の中心を基準にする。',
        },
        radius: { type: 'number', description: '検索半径 (m)。既定 500、最大 3000。' },
        limit: { type: 'number', description: '最大件数。既定 10。' },
      },
      required: ['category'],
      additionalProperties: false,
    },
  },
  {
    name: 'calculate_route',
    description:
      '2 地点間の経路を計算して地図に表示する。出発地・目的地は地名で指定してよい（内部で検索される）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '出発地の名前。「現在地」「ここ」の場合は "current" を渡す。' },
        to: { type: 'string', description: '目的地の名前' },
        mode: {
          type: 'string',
          enum: ['walk', 'drive', 'bicycle'],
          description: '移動手段。歩いて→walk、車で→drive、自転車で→bicycle',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_building_info',
    description:
      '指定した地点にある建物の情報（名称・用途・高さ・住所）を取得する。「この建物は何？」という質問に使う。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '建物の名前や場所。省略時は地図の中心。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_map_context',
    description: '現在の地図の状態（中心座標・高度・方位・表示中のルート）を取得する。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'set_camera',
    description:
      'カメラを指定した場所へ移動する。場所は名前で指定する（緯度経度を推測してはいけない）。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '移動先の場所の名前' },
        height: { type: 'number', description: '対地高度 (m)。俯瞰は 800〜2000、街並みを見るなら 200〜500。' },
        heading: { type: 'number', description: '方位 (度, 0=北)' },
        pitch: { type: 'number', description: '俯角 (度, -90〜0)' },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'highlight_location',
    description: '指定した場所に目印を表示する。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '目印を置く場所の名前' },
        label: { type: 'string', description: '目印に表示するラベル' },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_navigation',
    description:
      '直前に計算したルートで 3D ナビゲーションを開始する。ユーザーが「案内して」「ナビして」と言ったときに使う。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'set_time_of_day',
    description: '地図上の時刻を変更する（日照・影・空の色が変わる）。',
    parameters: {
      type: 'object',
      properties: {
        hour: { type: 'number', description: '0〜23 の時刻。「朝」は 7、「昼」は 12、「夕方」は 17、「夜」は 21 を目安にする。' },
      },
      required: ['hour'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_weather',
    description: '地図上の天候を変更する。',
    parameters: {
      type: 'object',
      properties: {
        weather: {
          type: 'string',
          enum: ['clear', 'cloudy', 'rain', 'snow', 'fog'],
          description: '天候',
        },
      },
      required: ['weather'],
      additionalProperties: false,
    },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return GEO_TOOLS.find((t) => t.name === name);
}
