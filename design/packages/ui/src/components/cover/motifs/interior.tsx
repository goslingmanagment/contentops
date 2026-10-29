import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Окно на стене и полоса света до пола. */
export function WindowLight({ seed }: MotifProps) {
  const random = createRandom(seed)
  const x = randomBetween(random, 64, 96)
  const y = randomBetween(random, 16, 30)
  const width = 40
  const height = 58
  const shaft = `${toFixed(x)},${toFixed(y + height)} ${toFixed(x + width)},${toFixed(y + height)} ${toFixed(x + width - 36)},160 ${toFixed(x - 72)},160`
  return (
    <g>
      <polygon points={shaft} fill="var(--c-glow)" opacity={0.16} />
      <rect
        x={toFixed(x - 3)}
        y={toFixed(y - 3)}
        width={width + 6}
        height={height + 6}
        rx={2}
        fill="var(--c-deep)"
        opacity={0.3}
      />
      <rect
        x={toFixed(x)}
        y={toFixed(y)}
        width={width}
        height={height}
        rx={1.5}
        fill="var(--c-glow)"
        opacity={0.82}
      />
      <path
        d={`M${toFixed(x + width / 2)} ${toFixed(y)}v${height}M${toFixed(x)} ${toFixed(y + height / 2)}h${width}`}
        stroke="var(--c-dark)"
        strokeOpacity={0.55}
        strokeWidth={2.4}
      />
    </g>
  )
}

/** Складки шторы у одного края. */
export function Curtain({ seed }: MotifProps) {
  const random = createRandom(seed)
  const onLeft = random() > 0.5
  const start = onLeft ? 8 : 104
  return (
    <g fill="none" strokeLinecap="round">
      {Array.from({ length: 6 }, (_, index) => {
        const x = start + index * 9 + randomBetween(random, -2, 2)
        const sway = randomBetween(random, 6, 12)
        return (
          <path
            key={x}
            d={`M${toFixed(x)} -4C${toFixed(x + sway)} 50 ${toFixed(x - sway)} 104 ${toFixed(x + sway / 2)} 164`}
            stroke={index % 2 === 0 ? 'var(--c-light)' : 'var(--c-deep)'}
            strokeOpacity={toFixed(randomBetween(random, 0.14, 0.3))}
            strokeWidth={toFixed(randomBetween(random, 8, 14))}
          />
        )
      })}
    </g>
  )
}

/** Зеркало-арка с отражённым светом. */
export function MirrorArch({ seed, paint }: MotifProps) {
  const random = createRandom(seed)
  const width = randomBetween(random, 54, 64)
  const left = 80 - width / 2 + randomBetween(random, -8, 8)
  const top = randomBetween(random, 26, 38)
  const radius = width / 2
  const outer = `M${toFixed(left)} 170V${toFixed(top + radius)}a${toFixed(radius)} ${toFixed(radius)} 0 0 1 ${toFixed(width)} 0V170Z`
  const inset = 5
  const inner = `M${toFixed(left + inset)} 170V${toFixed(top + radius)}a${toFixed(radius - inset)} ${toFixed(radius - inset)} 0 0 1 ${toFixed(width - inset * 2)} 0V170Z`
  return (
    <g>
      <path
        d={outer}
        fill="var(--c-deep)"
        fillOpacity={0.35}
        stroke="var(--c-ink)"
        strokeOpacity={0.7}
        strokeWidth={2.2}
      />
      <path d={inner} fill="var(--c-light)" fillOpacity={0.3} />
      <path d={inner} fill={paint.sheen} opacity={0.55} />
      <circle
        cx={toFixed(left + width * 0.62)}
        cy={toFixed(top + radius + 10)}
        r={toFixed(radius * 0.9)}
        fill={paint.glow}
        opacity={0.55}
      />
    </g>
  )
}

/** Ночное окно с городом и светящимися окнами. */
export function NightWindow({ seed }: MotifProps) {
  // Обложка — отдельный документ SVG (картинка), поэтому ID по зерну не сталкивается.
  const clipId = `night-window-${seed}`
  const random = createRandom(seed)
  const left = randomBetween(random, 30, 44)
  const top = randomBetween(random, 22, 32)
  const width = 160 - left * 2
  const height = randomBetween(random, 78, 92)
  const buildings: { x: number; width: number; height: number }[] = []
  let cursor = left
  while (cursor < left + width) {
    const buildingWidth = randomBetween(random, 7, 15)
    buildings.push({
      x: cursor,
      width: buildingWidth,
      height: randomBetween(random, 16, height * 0.7),
    })
    cursor += buildingWidth + 1
  }
  const bottom = top + height
  return (
    <g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={toFixed(width)}
        height={toFixed(height)}
        fill="var(--c-deep)"
        opacity={0.75}
      />
      <circle
        cx={toFixed(left + width * 0.72)}
        cy={toFixed(top + 18)}
        r={6}
        fill="var(--c-glow)"
        opacity={0.85}
      />
      <clipPath id={clipId}>
        <rect x={toFixed(left)} y={toFixed(top)} width={toFixed(width)} height={toFixed(height)} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        {buildings.map((building) => (
          <g key={building.x}>
            <rect
              x={toFixed(building.x)}
              y={toFixed(bottom - building.height)}
              width={toFixed(building.width)}
              height={toFixed(building.height)}
              fill="var(--c-dark)"
              opacity={0.9}
            />
            {Array.from({ length: Math.floor(building.height / 9) }, (_, row) =>
              random() > 0.45 ? (
                <rect
                  key={row}
                  x={toFixed(building.x + 2)}
                  y={toFixed(bottom - building.height + 4 + row * 9)}
                  width={2.2}
                  height={3}
                  fill="var(--c-glow)"
                  opacity={0.85}
                />
              ) : null,
            )}
          </g>
        ))}
      </g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={toFixed(width)}
        height={toFixed(height)}
        fill="none"
        stroke="var(--c-ink)"
        strokeOpacity={0.55}
        strokeWidth={3}
      />
      <path
        d={`M80 ${toFixed(top)}v${toFixed(height)}`}
        stroke="var(--c-ink)"
        strokeOpacity={0.5}
        strokeWidth={2}
      />
    </g>
  )
}
