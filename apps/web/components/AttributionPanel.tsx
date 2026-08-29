'use client';

import { useState } from 'react';
import type { DataSource } from '@ijm/shared';

/**
 * データ出典表示。
 *
 * OSM(ODbL) / PLATEAU(CC BY 4.0) / 地理院タイル の各利用条件は
 * 出典表示を必須としているため、常時アクセス可能な位置に置く。
 */
export default function AttributionPanel({ sources }: { sources: DataSource[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="pointer-events-auto">
      {open && (
        <div className="glass mb-2 max-h-[52vh] w-[min(92vw,380px)] overflow-y-auto rounded-[16px] p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">データ出典とライセンス</h2>
            <button onClick={() => setOpen(false)} className="text-[13px] text-mist-500">
              ×
            </button>
          </div>
          <ul className="space-y-2.5">
            {sources.map((s) => (
              <li key={s.id} className="rounded-xl border border-white/8 bg-ink-800/50 p-2.5">
                <p className="text-[13px] font-medium">{s.label}</p>
                <p className="mt-0.5 text-[12px] text-mist-300">{s.attribution}</p>
                <p className="mt-1 text-[11px] text-mist-500">ライセンス: {s.license}</p>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-block text-[11px] text-signal-400 underline underline-offset-2"
                >
                  利用条件を確認
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
            本アプリは公開されたオープンデータのみを使用しています。建物形状・道路・地形は
            すべて実測由来のデータで、生成 AI による捏造は行っていません。
            街路樹・街灯などの装飾は、OpenStreetMap に登録された実在位置にのみ配置しています。
          </p>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="glass rounded-full px-3 py-1.5 text-[11px] text-mist-300"
      >
        データ出典
      </button>
    </div>
  );
}
