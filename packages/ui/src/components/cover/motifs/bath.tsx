import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Плитка на стене: квадратная или «кабанчик». */
export function Tiles({ seed }: MotifProps) {
  const random = createRandom(seed)
  const subway = random() > 0.5
  const height = subway ? 9 : 16
  const width = subway ? 20 : 16
  const rows = Math.ceil(120 / height)
  const lines: string[] = []
  for (let row = 0; row <= rows; row += 1) {
    lines.push(`M0 ${row * height}H160`)
    const offset = subway && row % 2 === 1 ? width / 2 : 0
    for (let x = offset; x <= 160; x += width) {
      lines.push(`M${x} ${row * height}v${height}`)
    }
  }
  return (
    <path
      d={lines.join('')}
      fill="none"
      stroke="var(--c-glow)"
      strokeOpacity={0.3}
      strokeWidth={0.7}
    />
  )
}

/** Пузыри с бликом. */
export function Bubbles({ seed }: MotifProps) {
  const random = createRandom(seed)
  const count = 9 + Math.floor(random() * 7)
  return (
    <g>
      {Array.from({ length: count }, (_, index) => {
        const radius = randomBetween(random, 2.5, 11)
        const cx = randomBetween(random, 10, 150)
        const cy = randomBetween(random, 20, 140)
        return (
          <g key={index}>
            <circle
              cx={toFixed(cx)}
              cy={toFixed(cy)}
              r={toFixed(radius)}
              fill="var(--c-glow)"
              fillOpacity={0.12}
              stroke="var(--c-ink)"
              strokeOpacity={0.6}
              strokeWidth={0.7}
            />
            <path
              d={`M${toFixed(cx - radius * 0.6)} ${toFixed(cy - radius * 0.2)}a${toFixed(radius * 0.6)} ${toFixed(radius * 0.6)} 0 0 1 ${toFixed(radius * 0.5)} ${toFixed(-radius * 0.45)}`}
              fill="none"
              stroke="var(--c-ink)"
              strokeOpacity={0.8}
              strokeWidth={0.8}
              strokeLinecap="round"
            />
          </g>
        )
      })}
    </g>
  )
}

/** Ванна с пеной. */
export function Bathtub({ seed }: MotifProps) {
  const random = createRandom(seed)
  const top = randomBetween(random, 98, 110)
  return (
    <g>
      <rect
        x={-4}
        y={toFixed(top + 30)}
        width={168}
        height={40}
        fill="var(--c-deep)"
        opacity={0.35}
      />
      {Array.from({ length: 11 }, (_, index) => (
        <circle
          key={index}
          cx={toFixed(22 + index * 11.6)}
          cy={toFixed(top - 2 + Math.sin(index * 1.7) * 3)}
          r={toFixed(randomBetween(random, 5, 9))}
          fill="var(--c-ink)"
          opacity={0.92}
        />
      ))}
      <rect
        x={12}
        y={toFixed(top)}
        width={136}
        height={44}
        rx={20}
        fill="var(--c-ink)"
        opacity={0.95}
      />
      <rect
        x={12}
        y={toFixed(top)}
        width={136}
        height={6}
        rx={3}
        fill="var(--c-glow)"
        opacity={0.9}
      />
      <path
        d={`M16 ${toFixed(top + 26)}Q80 ${toFixed(top + 40)} 144 ${toFixed(top + 26)}`}
        fill="none"
        stroke="var(--c-dark)"
        strokeOpacity={0.3}
        strokeWidth={1.5}
      />
      <path
        d={`M132 ${toFixed(top)}v-18h-10`}
        fill="none"
        stroke="var(--c-deep)"
        strokeOpacity={0.6}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </g>
  )
}

/** Струи душа. */
export function ShowerRain({ seed }: MotifProps) {
  const random = createRandom(seed)
  const headX = randomBetween(random, 96, 120)
  return (
    <g>
      <path
        d={`M150 10H${toFixed(headX + 8)}v8`}
        fill="none"
        stroke="var(--c-deep)"
        strokeOpacity={0.6}
        strokeWidth={2.4}
      />
      <ellipse
        cx={toFixed(headX + 8)}
        cy={20}
        rx={11}
        ry={3.4}
        fill="var(--c-deep)"
        opacity={0.65}
      />
      {Array.from({ length: 26 }, (_, index) => {
        const start = headX + randomBetween(random, -8, 24)
        const length = randomBetween(random, 50, 120)
        return (
          <path
            key={index}
            d={`M${toFixed(start)} 24l${toFixed(-length * 0.28)} ${toFixed(length)}`}
            stroke="var(--c-glow)"
            strokeOpacity={toFixed(randomBetween(random, 0.25, 0.6))}
            strokeWidth={0.7}
            strokeLinecap="round"
          />
        )
      })}
    </g>
  )
}
