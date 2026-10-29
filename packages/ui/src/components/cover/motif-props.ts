/**
 * Мотив рисуется в квадрате 160 × 160; главное держится в середине 90 × 90, потому что
 * вертикальные кадры режут бока, а горизонтальные — верх и низ (см. `viewBoxFor`).
 * Цвета — только `var(--c-light|dark|deep|glow|ink)` семейства.
 */
export interface MotifProps {
  /** Зерно мотива: положение и размеры деталей. */
  seed: number
  /** Ссылки на общие градиенты обложки. */
  paint: CoverPaint
}

export interface CoverPaint {
  /** Радиальный свет цвета `--c-glow`, от плотного к прозрачному. */
  glow: string
  /** Линейный блик для стекла и зеркал. */
  sheen: string
}

/** Округление координат до десятых, чтобы разметка SVG оставалась короткой. */
export function toFixed(value: number): number {
  return Math.round(value * 10) / 10
}
