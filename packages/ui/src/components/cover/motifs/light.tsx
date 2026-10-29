import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Размытые огни на заднем плане. */
export function Bokeh({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const count = 9 + Math.floor(random() * 6)
  return (
    <g>
      {Array.from({ length: count }, (_, index) => {
        const radius = randomBetween(random, 4, 17)
        const cx = toFixed(randomBetween(random, 10, 150))
        const cy = toFixed(randomBetween(random, 8, 110))
        const opacity = toFixed(randomBetween(random, 0.18, 0.55))
        return index % 3 === 0 ? (
          <circle
            key={index}
            cx={cx}
            cy={cy}
            r={toFixed(radius * 1.6)}
            fill={paint.glow}
            opacity={opacity}
          />
        ) : (
          <circle
            key={index}
            cx={cx}
            cy={cy}
            r={toFixed(radius)}
            fill="var(--c-glow)"
            fillOpacity={toFixed(opacity * 0.45)}
            stroke="var(--c-glow)"
            strokeOpacity={toFixed(opacity * 0.6)}
            strokeWidth={0.7}
          />
        )
      })}
    </g>
  )
}

/** Четырёхлучевые искры. */
export function Sparkles({ seed }: MotifProps) {
  const random = createRandom(seed)
  const count = 12 + Math.floor(random() * 8)
  return (
    <g fill="var(--c-glow)">
      {Array.from({ length: count }, (_, index) => {
        const x = randomBetween(random, 8, 152)
        const y = randomBetween(random, 6, 150)
        const size = randomBetween(random, 1.4, 4.8)
        const d = `M${toFixed(x)} ${toFixed(y - size)}Q${toFixed(x)} ${toFixed(y)} ${toFixed(x + size)} ${toFixed(y)}Q${toFixed(x)} ${toFixed(y)} ${toFixed(x)} ${toFixed(y + size)}Q${toFixed(x)} ${toFixed(y)} ${toFixed(x - size)} ${toFixed(y)}Q${toFixed(x)} ${toFixed(y)} ${toFixed(x)} ${toFixed(y - size)}Z`
        return <path key={index} d={d} opacity={toFixed(randomBetween(random, 0.45, 1))} />
      })}
    </g>
  )
}

/** Гирлянда огоньков провисающими дугами. */
export function StringLights({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const garlands = [randomBetween(random, 14, 30), randomBetween(random, 38, 56)]
  return (
    <g>
      {garlands.map((top, garlandIndex) => {
        const sag = randomBetween(random, 14, 26)
        const bulbs = Array.from({ length: 9 }, (_, index) => {
          const t = index / 8
          const x = -4 + t * 168
          const y = top + sag * 4 * t * (1 - t)
          return { x: toFixed(x), y: toFixed(y) }
        })
        return (
          <g key={top}>
            <path
              d={`M-4 ${toFixed(top)}Q80 ${toFixed(top + sag * 2)} 164 ${toFixed(top)}`}
              fill="none"
              stroke="var(--c-ink)"
              strokeOpacity={0.45}
              strokeWidth={0.6}
            />
            {bulbs.map((bulb, index) => (
              <g key={`${garlandIndex}-${bulb.x}`} opacity={index % 2 === 0 ? 1 : 0.75}>
                <circle cx={bulb.x} cy={bulb.y + 2} r={7} fill={paint.glow} opacity={0.75} />
                <circle cx={bulb.x} cy={bulb.y + 2} r={1.7} fill="var(--c-glow)" />
              </g>
            ))}
          </g>
        )
      })}
    </g>
  )
}
