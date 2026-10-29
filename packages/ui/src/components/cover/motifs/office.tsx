import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Стол с ноутбуком и лампой. */
export function Desk({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const top = randomBetween(random, 112, 122)
  const laptopX = randomBetween(random, 52, 72)
  const lampOnLeft = random() > 0.5
  const lampX = lampOnLeft ? 30 : 132
  return (
    <g>
      <rect x={-4} y={toFixed(top)} width={168} height={8} fill="var(--c-deep)" opacity={0.75} />
      <rect
        x={-4}
        y={toFixed(top + 8)}
        width={168}
        height={50}
        fill="var(--c-deep)"
        opacity={0.35}
      />
      <path
        d={`M${toFixed(laptopX)} ${toFixed(top)}l5 -34h42l5 34z`}
        fill="var(--c-deep)"
        opacity={0.85}
      />
      <path
        d={`M${toFixed(laptopX + 8)} ${toFixed(top - 4)}l4 -26h34l4 26z`}
        fill="var(--c-glow)"
        opacity={0.55}
      />
      <rect
        x={toFixed(laptopX - 6)}
        y={toFixed(top - 2)}
        width={64}
        height={3}
        rx={1.5}
        fill="var(--c-ink)"
      />
      <circle cx={lampX} cy={toFixed(top - 34)} r={26} fill={paint.glow} opacity={0.8} />
      <path
        d={`M${lampX} ${toFixed(top)}v-26l${lampOnLeft ? 10 : -10} -10`}
        fill="none"
        stroke="var(--c-deep)"
        strokeWidth={1.8}
      />
      <path
        d={`M${lampX + (lampOnLeft ? 4 : -16)} ${toFixed(top - 42)}h12l3 8h-18z`}
        fill="var(--c-ink)"
      />
    </g>
  )
}

/** Жалюзи на окне. */
export function Blinds({ seed }: MotifProps) {
  const random = createRandom(seed)
  const left = randomBetween(random, 30, 50)
  const width = randomBetween(random, 70, 86)
  const top = randomBetween(random, 14, 22)
  const slats = 12
  return (
    <g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={toFixed(width)}
        height={slats * 7.4}
        rx={2}
        fill="var(--c-glow)"
        opacity={0.3}
      />
      {Array.from({ length: slats }, (_, index) => (
        <rect
          key={index}
          x={toFixed(left)}
          y={toFixed(top + 2 + index * 7.4)}
          width={toFixed(width)}
          height={3.6}
          fill="var(--c-glow)"
          opacity={toFixed(0.45 + (index % 3) * 0.08)}
        />
      ))}
      <path
        d={`M${toFixed(left + width - 8)} ${toFixed(top)}v${toFixed(slats * 7.4 + 14)}`}
        stroke="var(--c-deep)"
        strokeOpacity={0.45}
        strokeWidth={0.8}
      />
    </g>
  )
}

/** Полосы света от жалюзи на стене. */
export function BlindStripes({ seed }: MotifProps) {
  const random = createRandom(seed)
  const angle = randomBetween(random, 18, 34)
  return (
    <g transform={`rotate(${toFixed(-angle)} 80 80)`} fill="var(--c-glow)">
      {Array.from({ length: 9 }, (_, index) => (
        <rect
          key={index}
          x={-40}
          y={toFixed(18 + index * 13)}
          width={240}
          height={toFixed(randomBetween(random, 4, 7))}
          opacity={toFixed(randomBetween(random, 0.16, 0.3))}
        />
      ))}
    </g>
  )
}

/** Большое окно с переплётом 3 × 3. */
export function GridWindow({ seed }: MotifProps) {
  const random = createRandom(seed)
  const left = randomBetween(random, 26, 40)
  const top = randomBetween(random, 14, 24)
  const size = 160 - left * 2
  const height = size * 0.9
  const cells = [1, 2].map((part) => part / 3)
  return (
    <g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={toFixed(size)}
        height={toFixed(height)}
        fill="var(--c-glow)"
        opacity={0.42}
      />
      <g stroke="var(--c-ink)" strokeOpacity={0.75} strokeWidth={2.4} fill="none">
        <rect x={toFixed(left)} y={toFixed(top)} width={toFixed(size)} height={toFixed(height)} />
        {cells.map((part) => (
          <path
            key={part}
            d={`M${toFixed(left + size * part)} ${toFixed(top)}v${toFixed(height)}M${toFixed(left)} ${toFixed(top + height * part)}h${toFixed(size)}`}
          />
        ))}
      </g>
    </g>
  )
}
