import { cn } from 'cn'
import type { ComponentProps } from 'react'

/**
 * Три знака состояния (DESIGN §5.1): `done` ✓ — готово, делать нечего; `turn` ◆ — твой
 * ход; `trouble` ▲ — беда. Форма читается и без цвета: круг, ромб, треугольник с «!».
 */
export type StatusKind = 'done' | 'turn' | 'trouble'

const signLabel: Record<StatusKind, string> = {
  done: 'готово',
  turn: 'твой ход',
  trouble: 'беда',
}

const signColor: Record<StatusKind, string> = {
  done: 'text-foreground',
  turn: 'text-attention',
  trouble: 'text-destructive',
}

interface StatusSignProps extends Omit<ComponentProps<'svg'>, 'children'> {
  kind: StatusKind
  /** 14 — везде, 12 — в ячейках недели. */
  size?: 14 | 12
  /** Подпись для чтения с экрана. Без неё знак считается украшением: рядом всегда есть слово. */
  label?: string
}

export function StatusSign({ kind, size = 14, label, className, ...props }: StatusSignProps) {
  const labelled = label !== undefined
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? label || signLabel[kind] : undefined}
      aria-hidden={labelled ? undefined : true}
      data-status={kind}
      className={cn('shrink-0 transition-colors duration-160', signColor[kind], className)}
      {...props}
    >
      <SignShape kind={kind} />
    </svg>
  )
}

function SignShape({ kind }: { kind: StatusKind }) {
  if (kind === 'done') {
    return (
      <>
        <circle cx="7" cy="7" r="6.5" fill="currentColor" />
        <path
          d="M4.1 7.2 6.1 9.2 9.9 5.1"
          fill="none"
          className="stroke-background"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    )
  }
  if (kind === 'turn') {
    return (
      <path
        d="M7 1.1 12.9 7 7 12.9 1.1 7Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    )
  }
  return (
    <>
      <path
        d="M7 1.4 13 12.3H1Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M7 5.3v3.2" className="stroke-background" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10.3" r="0.85" className="fill-background" />
    </>
  )
}
