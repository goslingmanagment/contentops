import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Кружевная кайма: фестоны, петли и точки рядами. */
export function LaceBand({ seed }: MotifProps) {
  const random = createRandom(seed)
  const top = randomBetween(random, 100, 118)
  const step = 10
  const scallops = Array.from({ length: 18 }, (_, index) => {
    const x = -6 + index * step
    return `M${x} ${toFixed(top)}a${step / 2} ${step / 2} 0 0 0 ${step} 0`
  }).join('')
  return (
    <g fill="none" stroke="var(--c-ink)" strokeWidth={0.8}>
      <rect
        x={-4}
        y={toFixed(top - 22)}
        width={168}
        height={80}
        fill="var(--c-deep)"
        fillOpacity={0.22}
        stroke="none"
      />
      <path d={scallops} strokeOpacity={0.6} />
      <path d={scallops} transform="translate(0 7)" strokeOpacity={0.35} />
      {Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 17 }, (_, index) => {
          const cx = index * 10 + (row % 2) * 5 - 2
          const cy = top + 18 + row * 9 + Math.sin(index * 0.9 + row) * 1.5
          return (
            <circle
              key={`${row}-${index}`}
              cx={toFixed(cx)}
              cy={toFixed(cy)}
              r={toFixed(1.4 + ((index + row) % 3) * 0.6)}
              strokeOpacity={0.45}
            />
          )
        }),
      )}
      <path d={`M-4 ${toFixed(top - 12)}H164`} strokeOpacity={0.4} strokeDasharray="1.5 2.5" />
    </g>
  )
}

/** Кружевной круг из лепестков, как салфетка. */
export function LaceMedallion({ seed }: MotifProps) {
  const random = createRandom(seed)
  const cx = 80 + randomBetween(random, -8, 8)
  const cy = randomBetween(random, 70, 88)
  const rings = [
    { radius: 9, petals: 8 },
    { radius: 19, petals: 12 },
    { radius: 30, petals: 16 },
  ]
  return (
    <g fill="none" stroke="var(--c-ink)" strokeWidth={0.8}>
      <circle
        cx={toFixed(cx)}
        cy={toFixed(cy)}
        r={42}
        fill="var(--c-deep)"
        fillOpacity={0.16}
        stroke="none"
      />
      {rings.map((ring, ringIndex) =>
        Array.from({ length: ring.petals }, (_, index) => {
          const angle = (index / ring.petals) * 360 + ringIndex * 7
          return (
            <ellipse
              key={`${ring.radius}-${angle}`}
              cx={toFixed(cx)}
              cy={toFixed(cy - ring.radius)}
              rx={toFixed(2 + ringIndex * 0.8)}
              ry={toFixed(4 + ringIndex * 1.2)}
              transform={`rotate(${toFixed(angle)} ${toFixed(cx)} ${toFixed(cy)})`}
              strokeOpacity={toFixed(0.55 - ringIndex * 0.1)}
            />
          )
        }),
      )}
      <circle cx={toFixed(cx)} cy={toFixed(cy)} r={38} strokeOpacity={0.3} strokeDasharray="2 3" />
    </g>
  )
}

/** Складки ткани, текущие по диагонали. */
export function Drape({ seed }: MotifProps) {
  const random = createRandom(seed)
  return (
    <g fill="none" strokeLinecap="round">
      {Array.from({ length: 5 }, (_, index) => {
        const y = 10 + index * 30 + randomBetween(random, -6, 10)
        return (
          <path
            key={y}
            d={`M-12 ${toFixed(y)}C40 ${toFixed(y - 34 + random() * 20)} 96 ${toFixed(y + 42 - random() * 20)} 172 ${toFixed(y - 12)}`}
            stroke={index % 2 === 0 ? 'var(--c-glow)' : 'var(--c-deep)'}
            strokeOpacity={toFixed(randomBetween(random, 0.12, 0.28))}
            strokeWidth={toFixed(randomBetween(random, 10, 22))}
          />
        )
      })}
      <path
        d={`M-12 ${toFixed(randomBetween(random, 60, 90))}C50 40 100 120 172 70`}
        stroke="var(--c-glow)"
        strokeOpacity={0.45}
        strokeWidth={1.2}
      />
    </g>
  )
}
