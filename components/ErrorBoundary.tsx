'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from '@ijm/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 想定外の例外で画面が真っ白になるのを防ぐ。
 *
 * Cesium は WebGL やタイル読み込みの都合で、初期化後も非同期に例外を投げることがある。
 * React は捕捉されない例外が起きるとツリー全体を破棄するため、
 * 何も出ない「クラッシュしたように見える」状態になってしまう。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] 描画中に例外が発生しました', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-950 px-6">
        <div className="max-w-md text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/5 text-mist-400">
            <Icon name="alert" size={20} />
          </span>
          <p className="text-[15px] font-medium text-white">表示中に問題が発生しました</p>
          <p className="mt-2 break-words text-[13px] leading-relaxed text-mist-500">
            {error.message || '不明なエラー'}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-lg bg-white/8 px-4 py-2 text-[13px] text-mist-200 transition hover:bg-white/12"
            >
              再試行
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-signal-500 px-4 py-2 text-[13px] font-medium text-ink-950 transition hover:bg-signal-400"
            >
              再読み込み
            </button>
          </div>
        </div>
      </div>
    );
  }
}
