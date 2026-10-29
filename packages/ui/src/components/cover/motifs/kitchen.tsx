import { createRandom, randomBetween } from '../../../lib/seeded-random'
import { type MotifProps, toFixed } from '../motif-props'

/** Кухонное окно с подоконником и цветком в горшке. */
export function KitchenWindow({ seed }: MotifProps) {
  const random = createRandom(seed)
  const left = randomBetween(random, 36, 46)
  const top = randomBetween(random, 18, 26)
  const width = 160 - left * 2
  const height = 64
  const plantX = random() > 0.5 ? left + 16 : left + width - 16
  return (
    <g>
      <rect
        x={toFixed(left)}
        y={toFixed(top)}
        width={toFixed(width)}
        height={height}
        fill="var(--c-glow)"
        opacity={0.85}
      />
      <circle
        cx={toFixed(left + width * 0.7)}
        cy={toFixed(top + 20)}
        r={9}
        fill="var(--c-light)"
        opacity={0.9}
      />
      <g stroke="var(--c-ink)" strokeWidth={3} fill="none">
        <rect x={toFixed(left)} y={toFixed(top)} width={toFixed(width)} height={height} />
        <path
          d={`M80 ${toFixed(top)}v${height}M${toFixed(left)} ${toFixed(top + height / 2)}h${toFixed(width)}`}
        />
      </g>
      <rect
        x={toFixed(left - 8)}
        y={toFixed(top + height)}
        width={toFixed(width + 16)}
        height={5}
        rx={1.5}
        fill="var(--c-ink)"
      />
      <path
        d={`M${toFixed(plantX - 7)} ${toFixed(top + height - 12)}h14l-2.5 12h-9z`}
        fill="var(--c-dark)"
      />
      {[-40, -10, 20, 48].map((angle) => (
        <ellipse
          key={angle}
          cx={toFixed(plantX)}
          cy={toFixed(top + height - 22)}
          rx={3}
          ry={9}
          transform={`rotate(${angle} ${toFixed(plantX)} ${toFixed(top + height - 14)})`}
          fill="var(--cover-street-dark)"
        />
      ))}
    </g>
  )
}

/** Кружка с паром на столе. */
export function Mug({ seed }: MotifProps) {
  const random = createRandom(seed)
  const x = randomBetween(random, 64, 84)
  const table = randomBetween(random, 116, 124)
  return (
    <g>
      <rect x={-4} y={toFixed(table)} width={168} height={50} fill="var(--c-dark)" opacity={0.55} />
      <path
        d={`M-4 ${toFixed(table)}H164`}
        stroke="var(--c-glow)"
        strokeOpacity={0.4}
        strokeWidth={1}
      />
      <ellipse
        cx={toFixed(x + 12)}
        cy={toFixed(table + 2)}
        rx={26}
        ry={4}
        fill="var(--c-deep)"
        opacity={0.35}
      />
      <path
        d={`M${toFixed(x + 22)} ${toFixed(table - 24)}a8 8 0 0 1 0 14`}
        fill="none"
        stroke="var(--c-ink)"
        strokeWidth={3.4}
      />
      <rect
        x={toFixed(x)}
        y={toFixed(table - 30)}
        width={24}
        height={30}
        rx={4}
        fill="var(--c-ink)"
      />
      <ellipse
        cx={toFixed(x + 12)}
        cy={toFixed(table - 29)}
        rx={11}
        ry={2.6}
        fill="var(--c-deep)"
        opacity={0.85}
      />
      {[0, 1, 2].map((index) => (
        <path
          key={index}
          d={`M${toFixed(x + 6 + index * 6)} ${toFixed(table - 36)}c-4 -6 4 -10 0 -16s4 -10 0 -14`}
          fill="none"
          stroke="var(--c-glow)"
          strokeOpacity={0.55}
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      ))}
    </g>
  )
}

/** Стол сверху: тарелка, чашка, салфетка. */
export function TableTop({ seed }: MotifProps) {
  const random = createRandom(seed)
  const plateX = randomBetween(random, 64, 86)
  const plateY = randomBetween(random, 80, 96)
  return (
    <g>
      <rect
        x={toFixed(plateX - 58)}
        y={toFixed(plateY - 22)}
        width={40}
        height={52}
        rx={3}
        transform={`rotate(-12 ${toFixed(plateX - 38)} ${toFixed(plateY)})`}
        fill="var(--c-light)"
        opacity={0.7}
      />
      <circle cx={toFixed(plateX)} cy={toFixed(plateY)} r={32} fill="var(--c-ink)" />
      <circle
        cx={toFixed(plateX)}
        cy={toFixed(plateY)}
        r={24}
        fill="none"
        stroke="var(--c-light)"
        strokeWidth={1.2}
      />
      <circle
        cx={toFixed(plateX - 4)}
        cy={toFixed(plateY + 2)}
        r={13}
        fill="var(--c-dark)"
        opacity={0.85}
      />
      <circle
        cx={toFixed(plateX + 8)}
        cy={toFixed(plateY - 6)}
        r={6}
        fill="var(--cover-street-ink)"
        opacity={0.85}
      />
      <circle cx={toFixed(plateX + 44)} cy={toFixed(plateY - 34)} r={14} fill="var(--c-ink)" />
      <circle
        cx={toFixed(plateX + 44)}
        cy={toFixed(plateY - 34)}
        r={10}
        fill="var(--c-deep)"
        opacity={0.85}
      />
      <path
        d={`M${toFixed(plateX + 56)} ${toFixed(plateY - 30)}h8`}
        stroke="var(--c-ink)"
        strokeWidth={3.5}
        strokeLinecap="round"
      />
      <path
        d={`M${toFixed(plateX + 42)} ${toFixed(plateY - 4)}l6 40`}
        stroke="var(--c-light)"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </g>
  )
}
