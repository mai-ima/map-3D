'use client';

import { useRef, useState } from 'react';
import type { ChatMessage } from '@ijm/ai';

export interface AIPanelProps {
  enabled: boolean;
  busy: boolean;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
}

const SUGGESTIONS = [
  '東京駅から皇居まで歩いて',
  '渋谷駅から一番近いコンビニを探して',
  '銀座に移動して夕方にして',
  'このあたりのカフェを教えて',
];

/**
 * AI チャット。
 * AI は地図を直接操作せず、サーバ側の Tool Calling を経由して UI コマンドを返す。
 */
export default function AIPanel({ enabled, busy, messages, onSend, onClose }: AIPanelProps) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setText('');
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    });
  };

  return (
    <div className="glass flex max-h-[62vh] w-[min(92vw,400px)] flex-col rounded-[18px]">
      <div className="flex items-center gap-2 border-b border-white/8 px-3.5 py-2.5">
        <span className="text-[13px] font-semibold">AI アシスタント</span>
        {!enabled && (
          <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-mist-500">
            未設定
          </span>
        )}
        <button onClick={onClose} className="ml-auto text-[13px] text-mist-500">
          ×
        </button>
      </div>

      {!enabled ? (
        <div className="p-3.5 text-[12px] leading-relaxed text-mist-300">
          <p>
            AI 機能を使うには、サーバ側の環境変数に <code className="text-signal-400">AI_PROVIDER</code>
            （openai / anthropic / gemini / local）と、対応する API キーを設定してください。
          </p>
          <p className="mt-2 text-mist-500">
            API キーはサーバ側にのみ保持され、ブラウザには渡りません。
          </p>
        </div>
      ) : (
        <>
          <div ref={listRef} className="min-h-[120px] flex-1 space-y-2.5 overflow-y-auto p-3.5">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-[12px] text-mist-500">
                  自然な言葉で地図を操作できます。例えば:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border border-white/10 px-2.5 py-1 text-[12px] text-mist-300 hover:border-signal-400/50 hover:text-signal-400"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${
                  m.role === 'user'
                    ? 'ml-auto bg-signal-500/18 text-mist-100'
                    : 'bg-ink-800/70 text-mist-300'
                }`}
              >
                {m.content}
              </div>
            ))}

            {busy && (
              <div className="flex items-center gap-2 text-[12px] text-mist-500">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-signal-400" />
                考えています…
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-white/8 p-2.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(text);
              }}
              placeholder="地図に指示する…"
              className="flex-1 rounded-full border border-white/10 bg-ink-800/70 px-3 py-2 text-[13px] outline-none placeholder:text-mist-500 focus:border-signal-400/50"
              enterKeyHint="send"
            />
            <button
              onClick={() => send(text)}
              disabled={busy || !text.trim()}
              className="rounded-full bg-signal-500 px-3.5 py-2 text-[13px] font-semibold text-ink-950 disabled:opacity-40"
            >
              送信
            </button>
          </div>
        </>
      )}
    </div>
  );
}
