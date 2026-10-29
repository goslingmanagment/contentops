import type { FolderTileProps } from '../src/components/folder-tile'
import { StatusWord } from '../src/components/status-word'

/** Папки корня Библиотеки на данных Лоры (DESIGN §4.1, §9.3). */
export const libraryFolders: readonly FolderTileProps[] = [
  {
    href: '#/lora/library/ppv',
    name: 'PPV',
    count: 90,
    composition: '52 бандла · 38 в личку · 11 ч',
    note: '+3 за неделю',
    layout: 'feature',
    tiles: [
      { seed: 'PPV-079', kind: 'ppv', durationSeconds: 646 },
      { seed: 'PPV-076', kind: 'ppv', durationSeconds: 492 },
      { seed: 'PPV-075', kind: 'ppv', durationSeconds: 518 },
    ],
  },
  {
    href: '#/lora/library/fyp',
    name: 'FYP',
    count: 796,
    composition: '796 · 150 от SteadyContent',
    note: '+12 за неделю',
    layout: 'columns',
    tiles: [
      { seed: 'FYP-0803', kind: 'fyp', durationSeconds: 10 },
      { seed: 'FYP-0802', kind: 'fyp', durationSeconds: 8 },
      { seed: 'FYP-0801', kind: 'fyp', durationSeconds: 9 },
    ],
  },
  {
    href: '#/lora/library/customs',
    name: 'Кастомы',
    count: 197,
    composition: '197 · 30 ч · в PPV 38',
    note: <StatusWord sign="trouble">1 заказ просрочен</StatusWord>,
    layout: 'feature',
    tiles: [
      { seed: 'CUS-197', kind: 'custom', durationSeconds: 937 },
      { seed: 'CUS-195', kind: 'custom', durationSeconds: 221 },
      { seed: 'CUS-190', kind: 'custom', durationSeconds: 1068 },
    ],
  },
  {
    href: '#/lora/library/sets',
    name: 'Сеты',
    count: 73,
    composition: '73 · ≈1 965 кадров',
    note: '+1 за неделю',
    layout: 'grid-6',
    tiles: ['SET-074', 'SET-073', 'SET-072', 'SET-071', 'SET-070', 'SET-069'].map((seed) => ({
      seed,
      kind: 'set' as const,
    })),
  },
  {
    href: '#/lora/library/sextings',
    name: 'Секстинги',
    count: 12,
    composition: '12 · 1 072 файла',
    layout: 'feature',
    tiles: [
      { seed: 'SXT-012', kind: 'sexting', countLabel: '12 фото' },
      { seed: 'SXT-011', kind: 'sexting', countLabel: '96 фото' },
      { seed: 'SXT-010', kind: 'sexting', countLabel: '88 фото' },
    ],
  },
  {
    href: '#/lora/library/life',
    name: 'Лайф',
    count: 118,
    composition: '118 · 744 фото',
    note: '+2 за неделю',
    layout: 'grid-4',
    tiles: ['LIFE-191', 'LIFE-190', 'LIFE-189', 'LIFE-141'].map((seed) => ({
      seed,
      kind: 'life' as const,
    })),
  },
  {
    href: '#/lora/library/raw',
    name: 'Сырьё',
    count: 83,
    composition: '83 съёмки · 6 архивов не разобраны',
    layout: 'feature',
    tiles: [
      { seed: 'RAW-0214', kind: 'raw', countLabel: '23 фото' },
      { seed: 'RAW-0213', kind: 'raw', countLabel: '31 фото' },
      { seed: 'RAW-0212', kind: 'raw', countLabel: '18 фото' },
    ],
  },
  {
    href: '#/lora/library/promo',
    name: 'Промо',
    count: 22,
    composition: '22 подборки · 6 каналов',
    layout: 'feature',
    tiles: [
      { seed: 'PRM-016', kind: 'promo', countLabel: '100 фото' },
      { seed: 'PRM-015', kind: 'promo', countLabel: '60 фото' },
      { seed: 'PRM-013', kind: 'promo', countLabel: '44 фото' },
    ],
  },
  {
    href: '#/lora/library/not-uploaded',
    name: 'Ещё не залито',
    composition: 'по 5 страницам',
    layout: 'feature',
    tiles: [
      { seed: 'PPV-075', kind: 'ppv', durationSeconds: 518 },
      { seed: 'SET-072', kind: 'set', countLabel: '26 фото' },
      { seed: 'PPV-074', kind: 'ppv', durationSeconds: 581 },
    ],
  },
]
