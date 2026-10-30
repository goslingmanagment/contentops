import { hashString, mulberry32 } from '@contentops/contracts/hash'

/**
 * Deterministic randomness for fixtures: mulberry32 with a fixed seed, so the same
 * catalog comes out on every run and in every test.
 */

export interface Random {
  /** Uniform in [0, 1). */
  next(): number
  int(min: number, max: number): number
  pick<T>(values: readonly T[]): T
  chance(probability: number): boolean
  /** Normal-ish value between `min` and `max` peaking at `mode`. */
  triangular(min: number, mode: number, max: number): number
  shuffle<T>(values: readonly T[]): T[]
  sample<T>(values: readonly T[], count: number): T[]
}

export function createRandom(seed: number | string): Random {
  const next = mulberry32(typeof seed === 'string' ? hashString(seed) : seed)
  const random: Random = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (values) => {
      const value = values[Math.floor(next() * values.length)]
      if (value === undefined) throw new Error('pick from an empty list')
      return value
    },
    chance: (probability) => next() < probability,
    triangular: (min, mode, max) => {
      const split = (mode - min) / (max - min)
      const draw = next()
      return draw < split
        ? min + Math.sqrt(draw * (max - min) * (mode - min))
        : max - Math.sqrt((1 - draw) * (max - min) * (max - mode))
    },
    shuffle: (values) => {
      const copy = [...values]
      for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(next() * (index + 1))
        const held = copy[index] as (typeof copy)[number]
        copy[index] = copy[other] as (typeof copy)[number]
        copy[other] = held
      }
      return copy
    },
    sample: (values, count) => random.shuffle(values).slice(0, count),
  }
  return random
}
