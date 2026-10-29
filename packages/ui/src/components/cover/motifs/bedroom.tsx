import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Кровать: стёганое изголовье, подушки с тенью, одеяло со складками. */
export function Bed({ seed }: MotifProps) {
  const random = createRandom(seed)
  const top = randomBetween(random, 84, 96)
  const shift = randomBetween(random, -10, 10)
  const left = 18 + shift
  const tufts = [0, 1, 2, 3, 4, 5].map((index) => left + 12 + index * 20)
  return (
    <g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={124}
        height={40}
        rx={10}
        fill="var(--c-deep)"
        opacity={0.55}
      />
      <g stroke="var(--c-glow)" strokeOpacity={0.18} strokeWidth={1}>
        {tufts.map((x) => (
          <path key={x} d={`M${toFixed(x)} ${toFixed(top + 6)}v18`} />
        ))}
      </g>
      <rect
        x={toFixed(10 + shift)}
        y={toFixed(top + 26)}
        width={140}
        height={70}
        rx={16}
        fill="var(--c-light)"
        opacity={0.9}
      />
      <ellipse
        cx={toFixed(51 + shift)}
        cy={toFixed(top + 35)}
        rx={24}
        ry={5}
        fill="var(--c-deep)"
        opacity={0.25}
      />
      <ellipse
        cx={toFixed(107 + shift)}
        cy={toFixed(top + 37)}
        rx={24}
        ry={5}
        fill="var(--c-deep)"
        opacity={0.25}
      />
      <rect
        x={toFixed(28 + shift)}
        y={toFixed(top + 12)}
        width={46}
        height={21}
        rx={9}
        fill="var(--c-ink)"
        opacity={0.95}
      />
      <rect
        x={toFixed(84 + shift)}
        y={toFixed(top + 14)}
        width={46}
        height={21}
        rx={9}
        fill="var(--c-ink)"
        opacity={0.85}
      />
      <path
        d={`M${toFixed(10 + shift)} ${toFixed(top + 52)}C${toFixed(50 + shift)} ${toFixed(top + 42)} ${toFixed(92 + shift)} ${toFixed(top + 64)} ${toFixed(150 + shift)} ${toFixed(top + 48)}V${toFixed(top + 96)}H${toFixed(10 + shift)}Z`}
        fill="var(--c-dark)"
        opacity={0.5}
      />
      <g fill="none" stroke="var(--c-glow)" strokeLinecap="round">
        <path
          d={`M${toFixed(24 + shift)} ${toFixed(top + 64)}C${toFixed(60 + shift)} ${toFixed(top + 58)} ${toFixed(100 + shift)} ${toFixed(top + 74)} ${toFixed(140 + shift)} ${toFixed(top + 62)}`}
          strokeOpacity={0.35}
          strokeWidth={1.4}
        />
        <path
          d={`M${toFixed(40 + shift)} ${toFixed(top + 78)}C${toFixed(70 + shift)} ${toFixed(top + 72)} ${toFixed(96 + shift)} ${toFixed(top + 86)} ${toFixed(128 + shift)} ${toFixed(top + 76)}`}
          strokeOpacity={0.2}
          strokeWidth={1}
        />
      </g>
    </g>
  )
}

/** Торшер с тёплым пятном света. */
export function FloorLamp({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const x = random() > 0.5 ? randomBetween(random, 34, 46) : randomBetween(random, 112, 126)
  const shadeTop = randomBetween(random, 40, 52)
  return (
    <g>
      <circle cx={toFixed(x)} cy={toFixed(shadeTop + 12)} r={40} fill={paint.glow} opacity={0.95} />
      <path
        d={`M${toFixed(x)} ${toFixed(shadeTop + 16)}V150`}
        stroke="var(--c-deep)"
        strokeOpacity={0.7}
        strokeWidth={1.8}
      />
      <ellipse cx={toFixed(x)} cy={151} rx={9} ry={2.4} fill="var(--c-deep)" opacity={0.6} />
      <path
        d={`M${toFixed(x - 8)} ${toFixed(shadeTop)}H${toFixed(x + 8)}L${toFixed(x + 14)} ${toFixed(shadeTop + 17)}H${toFixed(x - 14)}Z`}
        fill="var(--c-ink)"
        opacity={0.95}
      />
    </g>
  )
}
