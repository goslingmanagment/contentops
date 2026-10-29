import { formatPercent } from '@contentops/contracts/format'
import { cn } from 'cn'

interface ProgressRingProps {
  /** Ход, 0–100; `undefined` — ход неизвестен, кольцо стоит пустым. */
  value?: number
  /** Что собирается: «Фото из кадров собираются». */
  label: string
  size?: 24 | 32
  className?: string
}

/**
 * Кольцо долгой операции на месте плитки (DESIGN §3.13, п. 7): «Сделать фото», «Сделать
 * обложкой», версии фупа. Не вращается: дуга растёт вместе с ходом.
 */
export function ProgressRing({ value, label, size = 32, className }: ProgressRingProps) {
  const radius = size / 2 - 3
  const circumference = 2 * Math.PI * radius
  const share = Math.min(100, Math.max(0, value ?? 0)) / 100
  return (
    <svg
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      aria-valuetext={value === undefined ? label : `${label} ${formatPercent(share)}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0 -rotate-90', className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={3}
        className="stroke-scrim-foreground/30"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
        className="stroke-scrim-foreground transition-[stroke-dashoffset] duration-160"
      />
    </svg>
  )
}
