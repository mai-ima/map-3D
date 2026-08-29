'use client';

/**
 * 共有 UI プリミティブ。
 * 3D シーンの上に重ねる「計器盤」としての最小要素だけを持つ。
 */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Panel({ className, children, ...rest }: PanelProps) {
  return (
    <div className={cx('glass rounded-[16px]', className)} {...rest}>
      {children}
    </div>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'chip';
  active?: boolean;
}

export function Button({ variant = 'ghost', active, className, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none select-none';

  const variants: Record<string, string> = {
    primary: 'bg-signal-500 text-ink-950 hover:bg-signal-400 px-4 py-2 font-semibold',
    ghost: cx(
      'px-3 py-1.5 border border-white/10 text-mist-300 hover:text-mist-100 hover:border-white/25',
      active && 'bg-signal-500/15 border-signal-400/50 text-signal-400',
    ),
    danger: 'bg-alert-400/15 border border-alert-400/40 text-alert-400 px-3 py-1.5',
    chip: cx(
      'px-3 py-1 text-[12px] border border-white/10 text-mist-300 hover:border-white/25',
      active && 'bg-signal-500/20 border-signal-400/60 text-signal-400',
    ),
  };

  return <button className={cx(base, variants[variant], className)} {...rest} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'text-[10px] font-semibold uppercase tracking-[0.14em] text-mist-500',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-signal-400',
        className,
      )}
      aria-hidden
    />
  );
}
