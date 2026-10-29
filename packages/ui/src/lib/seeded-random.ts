import { hashString, mulberry32 } from '@contentops/contracts/hash'

/**
 * Детерминированные числа для заглушек: одно и то же зерно даёт один и тот же результат
 * на любой машине, поэтому обложка объекта не меняется между запусками. Хэш и генератор —
 * общие с данными прототипа (`@contentops/contracts/hash`).
 */

export { hashString }

/** Равномерные числа в [0, 1). */
export type RandomSource = () => number

export function createRandom(seed: number): RandomSource {
  return mulberry32(seed)
}

export function randomBetween(random: RandomSource, min: number, max: number): number {
  return min + random() * (max - min)
}

export function pickOne<T>(random: RandomSource, items: readonly [T, ...T[]]): T {
  const index = Math.floor(random() * items.length)
  return items[Math.min(index, items.length - 1)] ?? items[0]
}
