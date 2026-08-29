'use client';

/**
 * SVG アイコン。
 *
 * 形状は @ijm/shared/icons に一元化しており、3D シーン上のマーカー
 * （map-engine の marker-icons.ts）と同じ絵柄になる。絵文字は使わない。
 */

import type { IconDefinition, IconName, IconPrimitive } from '@ijm/shared';
import { getIcon } from '@ijm/shared';

export interface IconProps {
  name: IconName;
  /** ピクセルサイズ（正方形） */
  size?: number;
  /** 線幅 */
  strokeWidth?: number;
  className?: string;
  /** 装飾目的でない場合はラベルを付ける */
  title?: string;
}

function renderPrimitive(primitive: IconPrimitive, index: number) {
  switch (primitive.kind) {
    case 'path':
      return (
        <path
          key={index}
          d={primitive.d}
          fill={primitive.filled ? 'currentColor' : 'none'}
          stroke={primitive.filled ? 'none' : 'currentColor'}
        />
      );
    case 'circle':
      return (
        <circle
          key={index}
          cx={primitive.cx}
          cy={primitive.cy}
          r={primitive.r}
          fill={primitive.filled ? 'currentColor' : 'none'}
          stroke={primitive.filled ? 'none' : 'currentColor'}
        />
      );
    case 'line':
      return (
        <line
          key={index}
          x1={primitive.x1}
          y1={primitive.y1}
          x2={primitive.x2}
          y2={primitive.y2}
          stroke="currentColor"
        />
      );
    case 'rect':
      return (
        <rect
          key={index}
          x={primitive.x}
          y={primitive.y}
          width={primitive.w}
          height={primitive.h}
          rx={primitive.rx}
          fill={primitive.filled ? 'currentColor' : 'none'}
          stroke={primitive.filled ? 'none' : 'currentColor'}
        />
      );
  }
}

export function Icon({ name, size = 18, strokeWidth = 1.7, className, title }: IconProps) {
  const definition: IconDefinition = getIcon(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox={definition.viewBox ?? '0 0 24 24'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {definition.primitives.map(renderPrimitive)}
    </svg>
  );
}
