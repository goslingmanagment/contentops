import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

const balloonTones = [
  'var(--c-light)',
  'var(--c-glow)',
  'var(--c-dark)',
  'var(--c-light)',
  'var(--c-ink)',
]

/** Воздушные шары на ниточках. */
export function Balloons({ seed }: MotifProps) {
  const random = createRandom(seed)
  const count = 3 + Math.floor(random() * 3)
  return (
    <g>
      {Array.from({ length: count }, (_, index) => {
        const cx = 34 + (index / Math.max(1, count - 1)) * 92 + randomBetween(random, -8, 8)
        const cy = randomBetween(random, 30, 78)
        const radius = randomBetween(random, 11, 17)
        const tone = balloonTones[index % balloonTones.length]
        return (
          <g key={index}>
            <path
              d={`M${toFixed(cx)} ${toFixed(cy + radius + 2)}q${toFixed(randomBetween(random, -6, 6))} 24 ${toFixed(randomBetween(random, -4, 4))} 58`}
              fill="none"
              stroke="var(--c-glow)"
              strokeOpacity={0.55}
              strokeWidth={0.6}
            />
            <path
              d={`M${toFixed(cx - 2)} ${toFixed(cy + radius + 2.5)}h4l-2 -3z`}
              fill={tone}
              opacity={0.9}
            />
            <ellipse
              cx={toFixed(cx)}
              cy={toFixed(cy)}
              rx={toFixed(radius * 0.86)}
              ry={toFixed(radius)}
              fill={tone}
              opacity={0.88}
            />
            <ellipse
              cx={toFixed(cx - radius * 0.32)}
              cy={toFixed(cy - radius * 0.38)}
              rx={toFixed(radius * 0.2)}
              ry={toFixed(radius * 0.3)}
              fill="var(--c-glow)"
              opacity={0.7}
            />
          </g>
        )
      })}
    </g>
  )
}

const confettiTones = ['var(--c-glow)', 'var(--c-ink)', 'var(--c-light)']

/** Конфетти. */
export function Confetti({ seed }: MotifProps) {
  const random = createRandom(seed)
  return (
    <g>
      {Array.from({ length: 34 }, (_, index) => {
        const x = randomBetween(random, 0, 160)
        const y = randomBetween(random, 0, 160)
        return (
          <rect
            key={index}
            x={toFixed(x)}
            y={toFixed(y)}
            width={toFixed(randomBetween(random, 2, 4.5))}
            height={toFixed(randomBetween(random, 1.2, 2.2))}
            transform={`rotate(${toFixed(randomBetween(random, 0, 180))} ${toFixed(x)} ${toFixed(y)})`}
            fill={confettiTones[index % confettiTones.length]}
            opacity={0.85}
          />
        )
      })}
    </g>
  )
}

function Flame({ x, y, glow }: { x: number; y: number; glow: string }) {
  return (
    <g>
      <circle cx={toFixed(x)} cy={toFixed(y - 3)} r={11} fill={glow} opacity={0.9} />
      <path
        d={`M${toFixed(x)} ${toFixed(y - 9)}q3.2 5 0 8.4q-3.2 -3.4 0 -8.4z`}
        fill="var(--c-ink)"
      />
    </g>
  )
}

/** Торт со свечами на блюде. */
export function Cake({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const cx = 80 + randomBetween(random, -10, 10)
  const base = randomBetween(random, 116, 126)
  const candles = 3 + Math.floor(random() * 3)
  return (
    <g>
      <ellipse
        cx={toFixed(cx)}
        cy={toFixed(base + 4)}
        rx={50}
        ry={8}
        fill="var(--c-glow)"
        opacity={0.55}
      />
      <rect
        x={toFixed(cx - 36)}
        y={toFixed(base - 26)}
        width={72}
        height={28}
        rx={4}
        fill="var(--c-glow)"
        opacity={0.95}
      />
      <rect
        x={toFixed(cx - 24)}
        y={toFixed(base - 46)}
        width={48}
        height={22}
        rx={4}
        fill="var(--c-light)"
        opacity={0.98}
      />
      <path
        d={`M${toFixed(cx - 36)} ${toFixed(base - 20)}q6 6 12 0t12 0t12 0t12 0t12 0t12 0v-6h-72z`}
        fill="var(--c-dark)"
        opacity={0.55}
      />
      {Array.from({ length: candles }, (_, index) => {
        const x = cx - 16 + (index * 32) / Math.max(1, candles - 1)
        return (
          <g key={index}>
            <rect
              x={toFixed(x - 1.4)}
              y={toFixed(base - 60)}
              width={2.8}
              height={14}
              rx={1}
              fill="var(--c-ink)"
              opacity={0.9}
            />
            <Flame x={x} y={base - 62} glow={paint.glow} />
          </g>
        )
      })}
    </g>
  )
}

/** Свечи разной высоты на столе. */
export function Candles({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const count = 3 + Math.floor(random() * 3)
  const table = randomBetween(random, 118, 128)
  return (
    <g>
      <rect x={-4} y={toFixed(table)} width={168} height={50} fill="var(--c-deep)" opacity={0.55} />
      <ellipse cx={80} cy={toFixed(table)} rx={70} ry={6} fill="var(--c-glow)" opacity={0.2} />
      {Array.from({ length: count }, (_, index) => {
        const x = 40 + (index * 80) / Math.max(1, count - 1) + randomBetween(random, -4, 4)
        const height = randomBetween(random, 18, 44)
        return (
          <g key={index}>
            <rect
              x={toFixed(x - 3.5)}
              y={toFixed(table - height)}
              width={7}
              height={toFixed(height)}
              rx={1.5}
              fill="var(--c-glow)"
              opacity={0.92}
            />
            <Flame x={x} y={table - height - 1} glow={paint.glow} />
          </g>
        )
      })}
    </g>
  )
}
