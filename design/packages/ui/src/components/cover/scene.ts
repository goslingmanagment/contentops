import { createRandom, hashString, randomBetween } from '../../lib/seeded-random'
import type { CoverFamily } from './families'

export type CoverAspect = '3:4' | '9:16' | '16:9' | '1:1'

/** Числовое отношение ширины к высоте для `aspect-ratio`. */
export const aspectRatioValue: Record<CoverAspect, number> = {
  '3:4': 3 / 4,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
}

/** Кадр внутри сцены 160 × 160 под нужную пропорцию. */
const baseViewBox: Record<CoverAspect, { x: number; y: number; width: number; height: number }> = {
  '3:4': { x: 20, y: 0, width: 120, height: 160 },
  '9:16': { x: 35, y: 0, width: 90, height: 160 },
  '16:9': { x: 0, y: 35, width: 160, height: 90 },
  '1:1': { x: 0, y: 0, width: 160, height: 160 },
}

export interface CoverScene {
  composition: number
  motifSeeds: readonly number[]
  viewBox: string
  gradient: {
    x1: number
    y1: number
    x2: number
    y2: number
    middleOffset: number
    /** Доли смешения тонов, в процентах: даёт каждой обложке свой оттенок семейства. */
    glowInLight: number
    darkInMiddle: number
    deepInEnd: number
    altInMiddle: number
    altInEnd: number
  }
  light: { cx: number; cy: number; r: number; opacity: number }
  vignette: number
}

interface SceneOptions {
  seed: string
  family: CoverFamily
  compositionCount: number
  aspect: CoverAspect
  /** Номер кадра: та же сцена с другим кадрированием и светом (кадры мастера, лента). */
  frame?: number
}

/** Описание обложки из зерна. Чистая функция: результат зависит только от входа. */
export function buildCoverScene({
  seed,
  family,
  compositionCount,
  aspect,
  frame = 0,
}: SceneOptions): CoverScene {
  const base = createRandom(hashString(`${family}:${seed}`))
  const composition = Math.floor(base() * compositionCount)
  const motifSeeds = [0, 1, 2, 3].map(() => Math.floor(base() * 2 ** 31))
  const fromTopLeft = base() > 0.35
  const gradient = {
    x1: fromTopLeft ? 0 : 1,
    y1: 0,
    x2: fromTopLeft ? 0.7 : 0.25,
    y2: 1,
    middleOffset: randomBetween(base, 0.4, 0.62),
    glowInLight: Math.round(randomBetween(base, 0, 25)),
    darkInMiddle: Math.round(randomBetween(base, 40, 85)),
    deepInEnd: Math.round(randomBetween(base, 35, 90)),
    altInMiddle: Math.round(base() > 0.4 ? randomBetween(base, 10, 55) : 0),
    altInEnd: Math.round(randomBetween(base, 0, 50)),
  }
  const vignette = randomBetween(base, 0.32, 0.52)

  const framed = createRandom(hashString(`${seed}#${frame}`))
  const lightSource = frame === 0 ? base : framed
  const light = {
    cx: randomBetween(lightSource, 30, 130),
    cy: randomBetween(lightSource, 18, 80),
    r: randomBetween(lightSource, 55, 95),
    opacity: randomBetween(lightSource, 0.28, 0.6),
  }

  return {
    composition,
    motifSeeds,
    viewBox: frameViewBox(aspect, frame, framed),
    gradient,
    light,
    vignette,
  }
}

/** Кадры мастера — тот же мотив ближе или дальше и со сдвигом. */
function frameViewBox(aspect: CoverAspect, frame: number, random: () => number): string {
  const box = baseViewBox[aspect]
  if (frame === 0) {
    return `${box.x} ${box.y} ${box.width} ${box.height}`
  }
  const zoom = randomBetween(random, 1.08, 1.4)
  const width = box.width / zoom
  const height = box.height / zoom
  const x = box.x + random() * (box.width - width)
  const y = box.y + random() * (box.height - height)
  return [x, y, width, height].map((value) => Math.round(value * 10) / 10).join(' ')
}
