import type { ObjectTileSign } from '../src/components/object-tile'

export interface SampleObject {
  id: string
  title: string
  durationSeconds: number
  countLabel: number
  arrived: string
  placement: string
  versionCount?: number
  sign?: ObjectTileSign
}

const titles = [
  'День рождения, торт, кружево',
  'Кристаллы и каблуки',
  'Коричневое кружево у зеркала',
  'Нейлон и каблуки',
  'Стиральная машина',
  'Мерцание, тизинг',
  'Хэллоуин',
  'Коричневый сет',
  'Шампанское и шарики',
  'Красное платье в отеле',
  'Молоко',
  'Чулки и свечи',
  'Белая рубашка у окна',
  'Вечер в ванной',
  'Кружевной комплект, спальня',
  'Леопард и каблуки',
  'Утро, кофе, халат',
  'Офис после работы',
]

const placements = [
  'Fansly 1–3, OF VIP',
  'Fansly 1, 2',
  'ещё нигде',
  'Fansly 1–3',
  'OF VIP, OF Free',
]

/** 90 PPV Лоры для проверки сетки (DESIGN §9.3); PPV-073–076 — подробные образцы. */
export const samplePpv: readonly SampleObject[] = Array.from({ length: 90 }, (_, offset) => {
  const number = 90 - offset
  const id = `PPV-${String(number).padStart(3, '0')}`
  const special: Partial<SampleObject> =
    number === 73
      ? { title: 'День рождения, торт, кружево', versionCount: 2 }
      : number === 74
        ? { title: 'Кристаллы и каблуки', sign: { kind: 'turn', label: 'Hub нашёл похожее' } }
        : number === 75
          ? { title: 'Коричневое кружево у зеркала', sign: { kind: 'trouble', label: 'пропущено' } }
          : {}
  return {
    id,
    title: titles[number % titles.length] ?? 'Без названия',
    durationSeconds: 240 + ((number * 97) % 780),
    countLabel: 8 + (number % 17),
    arrived: `${String(1 + (number % 28)).padStart(2, '0')}.0${1 + (number % 9)}`,
    placement: placements[number % placements.length] ?? 'ещё нигде',
    ...special,
  }
})
