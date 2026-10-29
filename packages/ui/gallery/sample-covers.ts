import type { CoverKind } from '../src/components/thumb'

export interface SampleCover {
  id: string
  title: string
  kind: CoverKind
  durationSeconds?: number
  countLabel?: string
  versionCount?: number
}

/** Образцы по данным Лоры (DESIGN §9.3): ID, названия, длительности. */
export const sampleCovers: readonly SampleCover[] = [
  {
    id: 'PPV-073',
    title: 'День рождения, торт, кружево',
    kind: 'ppv',
    durationSeconds: 804,
    versionCount: 2,
  },
  { id: 'PPV-074', title: 'Кристаллы и каблуки', kind: 'ppv', durationSeconds: 581 },
  { id: 'PPV-075', title: 'Коричневое кружево у зеркала', kind: 'ppv', durationSeconds: 518 },
  { id: 'PPV-076', title: 'Нейлон и каблуки', kind: 'ppv', durationSeconds: 492 },
  { id: 'PPV-061', title: 'Стиральная машина', kind: 'ppv', durationSeconds: 655 },
  { id: 'PPV-067', title: 'Мерцание, тизинг', kind: 'ppv', durationSeconds: 377 },
  { id: 'PPV-081', title: 'Хэллоуин', kind: 'ppv', durationSeconds: 702 },
  { id: 'PPV-082', title: 'Коричневый сет', kind: 'ppv', durationSeconds: 433 },
  { id: 'CUS-197', title: 'Босс', kind: 'custom', durationSeconds: 937 },
  { id: 'CUS-195', title: 'Танец живота', kind: 'custom', durationSeconds: 221, versionCount: 2 },
  { id: 'CUS-181', title: 'Нейлон и каблуки', kind: 'custom', durationSeconds: 492 },
  { id: 'CUS-190', title: 'Уборка', kind: 'custom', durationSeconds: 1068 },
  { id: 'CUS-188', title: 'Пов от девушки', kind: 'custom', durationSeconds: 1037 },
  { id: 'CUS-186', title: 'Колготки', kind: 'custom', durationSeconds: 717 },
  { id: 'CUS-160', title: '38 фото', kind: 'custom', countLabel: '38 фото' },
  { id: 'SET-074', title: 'Чтение книги, стринги', kind: 'set', countLabel: '46 фото' },
  { id: 'SET-069', title: 'Отель, красное платье у зеркала', kind: 'set', countLabel: '31 фото' },
  { id: 'SET-073', title: 'После душа', kind: 'set', countLabel: '24 фото' },
  { id: 'SET-071', title: 'Белая рубашка', kind: 'set', countLabel: '28 фото' },
  { id: 'SXT-012', title: 'Чулки, каблуки', kind: 'sexting', countLabel: '12 фото' },
  { id: 'SXT-005', title: 'Розовые стринги', kind: 'sexting', countLabel: '15 фото' },
  { id: 'SXT-009', title: 'Пена и свечи', kind: 'sexting', countLabel: '18 фото' },
  { id: 'FYP-0801', title: 'Зеркало, чёрное боди', kind: 'fyp', durationSeconds: 9 },
  { id: 'FYP-0797', title: 'Нейлон, офис', kind: 'fyp', durationSeconds: 11 },
  { id: 'FYP-0802', title: 'Йога в леггинсах', kind: 'fyp', durationSeconds: 8 },
  { id: 'FYP-0412', title: 'Йога у зеркала', kind: 'fyp', durationSeconds: 12 },
  { id: 'FYP-0799', title: 'Вечер у окна', kind: 'fyp', durationSeconds: 7 },
  { id: 'FYP-0803', title: 'Халат у окна', kind: 'fyp', durationSeconds: 10 },
  { id: 'LIFE-191', title: 'Завтрак у окна', kind: 'life', countLabel: '16 фото' },
  { id: 'LIFE-141', title: 'Сбор яблок', kind: 'life', countLabel: '22 фото' },
  { id: 'LIFE-188', title: 'Прогулка в парке', kind: 'life', countLabel: '9 фото' },
  { id: 'LIFE-176', title: 'Ванна с пеной', kind: 'life', countLabel: '11 фото' },
  { id: 'RAW-0214', title: 'Съёмка 21 сентября', kind: 'raw', countLabel: '23 фото' },
  { id: 'RAW-0034', title: 'Съёмка 6 августа', kind: 'raw', countLabel: '36 фото' },
  { id: 'RAW-0201', title: 'Съёмка 12 сентября', kind: 'raw', countLabel: '41 фото' },
  { id: 'PRM-015', title: 'КП2 офис нейлон', kind: 'promo', countLabel: '60 фото' },
  { id: 'PRM-016', title: 'Гиф-сайты, пак 2', kind: 'promo', countLabel: '100 фото' },
  { id: 'PRM-013', title: 'Reddit, сентябрь', kind: 'promo', countLabel: '44 фото' },
  { id: 'PPV-079', title: 'Шампанское и шарики', kind: 'ppv', durationSeconds: 646 },
  { id: 'SET-066', title: 'Кружевной комплект', kind: 'set', countLabel: '33 фото' },
]
