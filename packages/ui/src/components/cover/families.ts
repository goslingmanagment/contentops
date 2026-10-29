import { hashString } from '../../lib/seeded-random'

/**
 * Семейства синтетических обложек (DESIGN §7.9). Цвета семейства лежат токенами
 * `--cover-<семейство>-*` в globals.css; мотивы берут их через `--c-*`.
 */
export const coverFamilies = [
  'bedroom',
  'lace',
  'party',
  'evening',
  'bath',
  'kitchen',
  'street',
  'office',
] as const

export type CoverFamily = (typeof coverFamilies)[number]

/** Тип объекта каталога, от которого зависит набор семейств. */
export type CoverKind = 'ppv' | 'fyp' | 'custom' | 'set' | 'sexting' | 'life' | 'raw' | 'promo'

/**
 * Какие семейства берёт тип — столбец «Типы» в §7.9: PPV и кастомы — спальня, кружево и
 * праздник; FYP — вечер; сеты — кружево; секстинги — ванная; лайф — ванная, кухня и
 * улица; сырьё и промо — офис и улица. Повтор семейства в списке делает его чаще.
 * Разнообразие внутри одного семейства дают раскладки мотивов и оттенок каждой обложки.
 */
const familiesByKind: Record<CoverKind, readonly [CoverFamily, ...CoverFamily[]]> = {
  ppv: ['bedroom', 'lace', 'bedroom', 'lace', 'party'],
  custom: ['bedroom', 'lace', 'bedroom', 'lace', 'party'],
  set: ['lace'],
  fyp: ['evening'],
  sexting: ['bath'],
  life: ['bath', 'kitchen', 'street'],
  raw: ['office', 'street'],
  promo: ['office', 'street'],
}

/** Семейство по хэшу зерна: одно и то же ID всегда получает одну и ту же обложку. */
export function pickCoverFamily(seed: string, kind?: CoverKind): CoverFamily {
  const choices = kind ? familiesByKind[kind] : coverFamilies
  return choices[hashString(`family:${seed}`) % choices.length] ?? choices[0]
}
