import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Солнце с ореолом. */
export function Sun({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const cx = randomBetween(random, 50, 112)
  const cy = randomBetween(random, 32, 58)
  return (
    <g>
      <circle cx={toFixed(cx)} cy={toFixed(cy)} r={46} fill={paint.glow} opacity={0.9} />
      <circle
        cx={toFixed(cx)}
        cy={toFixed(cy)}
        r={toFixed(randomBetween(random, 13, 18))}
        fill="var(--c-glow)"
      />
    </g>
  )
}

/** Холмы в три плана. */
export function Hills({ seed }: MotifProps) {
  const random = createRandom(seed)
  const layers = [
    { base: 92, fill: 'var(--c-dark)', opacity: 0.45 },
    { base: 110, fill: 'var(--c-dark)', opacity: 0.7 },
    { base: 128, fill: 'var(--c-deep)', opacity: 0.75 },
  ]
  return (
    <g>
      {layers.map((layer) => {
        const lift = randomBetween(random, 8, 20)
        const peak = randomBetween(random, 30, 130)
        return (
          <path
            key={layer.base}
            d={`M-4 ${toFixed(layer.base + lift / 2)}Q${toFixed(peak)} ${toFixed(layer.base - lift * 2)} 164 ${toFixed(layer.base)}V170H-4Z`}
            fill={layer.fill}
            opacity={layer.opacity}
          />
        )
      })}
    </g>
  )
}

/** Ветка с листьями из верхнего угла. */
export function Leaves({ seed }: MotifProps) {
  const random = createRandom(seed)
  const fromLeft = random() > 0.5
  const startX = fromLeft ? -6 : 166
  const endX = fromLeft ? 118 : 42
  const endY = randomBetween(random, 60, 90)
  const leaves = Array.from({ length: 11 }, (_, index) => {
    const t = (index + 1) / 12
    const x = startX + (endX - startX) * t
    const y = 8 + (endY - 8) * t * t + (index % 2 === 0 ? -6 : 6)
    const angle =
      (fromLeft ? 20 : 160) + (index % 2 === 0 ? -50 : 50) + randomBetween(random, -12, 12)
    return { x, y, angle, size: randomBetween(random, 7, 12) }
  })
  return (
    <g>
      <path
        d={`M${startX} 8Q${toFixed((startX + endX) / 2)} ${toFixed(endY * 0.2)} ${toFixed(endX)} ${toFixed(endY)}`}
        fill="none"
        stroke="var(--c-deep)"
        strokeOpacity={0.75}
        strokeWidth={1.8}
      />
      {leaves.map((leaf, index) => (
        <path
          key={`${leaf.x}-${leaf.y}`}
          d={`M0 0q${toFixed(leaf.size * 0.55)} ${toFixed(-leaf.size * 0.5)} ${toFixed(leaf.size * 1.6)} 0q${toFixed(-leaf.size * 1.05)} ${toFixed(leaf.size * 0.5)} ${toFixed(-leaf.size * 1.6)} 0z`}
          transform={`translate(${toFixed(leaf.x)} ${toFixed(leaf.y)}) rotate(${toFixed(leaf.angle)})`}
          fill={index % 3 === 0 ? 'var(--c-deep)' : 'var(--c-dark)'}
          opacity={0.92}
        />
      ))}
    </g>
  )
}

/** Яблоня: крона и красные яблоки. */
export function AppleTree({ seed }: MotifProps) {
  const random = createRandom(seed)
  return (
    <g>
      {Array.from({ length: 7 }, (_, index) => (
        <circle
          key={`leaf-${index}`}
          cx={toFixed(randomBetween(random, 10, 150))}
          cy={toFixed(randomBetween(random, 0, 70))}
          r={toFixed(randomBetween(random, 22, 36))}
          fill={index % 2 === 0 ? 'var(--c-dark)' : 'var(--c-deep)'}
          opacity={0.55}
        />
      ))}
      {Array.from({ length: 10 }, (_, index) => {
        const cx = randomBetween(random, 16, 144)
        const cy = randomBetween(random, 30, 120)
        const radius = randomBetween(random, 5, 8)
        return (
          <g key={`apple-${index}`}>
            <circle cx={toFixed(cx)} cy={toFixed(cy)} r={toFixed(radius)} fill="var(--c-ink)" />
            <circle
              cx={toFixed(cx - radius * 0.35)}
              cy={toFixed(cy - radius * 0.35)}
              r={toFixed(radius * 0.28)}
              fill="var(--c-glow)"
              opacity={0.6}
            />
          </g>
        )
      })}
    </g>
  )
}
