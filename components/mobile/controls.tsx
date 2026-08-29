'use client';

import type { ReactNode } from 'react';
import type { IconName } from '@ijm/shared';
import { Icon } from '@ijm/ui';

/**
 * iOS のコントロールに寄せた共通パーツ。
 *
 * 押した瞬間に見た目が変わること（active:scale）と、
 * タップ領域が 44pt 以上あることを全部品で守る。
 * この 2 つが揃っていないと、見た目を似せてもネイティブらしくならない。
 */

/** セグメンテッドコントロール（iOS の UISegmentedControl 相当） */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; iconName?: IconName }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-[10px] bg-white/8 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] font-medium transition-all duration-150 active:scale-[0.97] ${
              active ? 'bg-white/16 text-white shadow-sm' : 'text-mist-400'
            }`}
          >
            {o.iconName && <Icon name={o.iconName} size={15} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 地図の上に浮かぶ丸ボタン */
export function FloatingButton({
  iconName,
  label,
  onClick,
  active,
}: {
  iconName: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-11 w-11 items-center justify-center rounded-full ring-1 backdrop-blur-xl transition-all duration-150 active:scale-90 ${
        active
          ? 'bg-signal-500 text-ink-950 ring-signal-400/40'
          : 'bg-ink-900/85 text-mist-200 ring-white/12'
      }`}
    >
      <Icon name={iconName} size={19} />
    </button>
  );
}

/** iOS の設定アプリのような行。まとめて角丸のグループにする */
export function ListGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[14px] bg-white/6 ring-1 ring-white/8">{children}</div>
  );
}

export function ListRow({
  iconName,
  title,
  detail,
  onClick,
  trailing,
}: {
  iconName?: IconName;
  title: string;
  detail?: string;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const inner = (
    <>
      {iconName && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/8 text-mist-300">
          <Icon name={iconName} size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-mist-100">{title}</span>
        {detail && <span className="block truncate text-[12px] text-mist-500">{detail}</span>}
      </span>
      {trailing}
    </>
  );

  const className =
    'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-100 [&+&]:border-t [&+&]:border-white/6';

  if (!onClick) return <div className={className}>{inner}</div>;

  return (
    <button type="button" onClick={onClick} className={`${className} active:bg-white/10`}>
      {inner}
    </button>
  );
}

/** シート内のセクション見出し */
export function SheetSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="pt-4 first:pt-1">
      {title && (
        <h2 className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-mist-500">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/** 横に並ぶ選択チップ。横スクロールで溢れを吸収する */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  iconName,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  iconName?: IconName;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] transition-all duration-150 active:scale-95 ${
        active
          ? 'bg-signal-500/18 text-signal-300 ring-1 ring-signal-400/40'
          : 'bg-white/8 text-mist-300 ring-1 ring-white/8'
      }`}
    >
      {iconName && <Icon name={iconName} size={14} />}
      {children}
    </button>
  );
}
