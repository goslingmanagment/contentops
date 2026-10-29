import type { ItemType } from '@contentops/contracts'
import type { CatalogChipKey } from '../shared/catalog-chips'
import type { SortBase } from './section-sort'

/** Раздел-тип Библиотеки; «Промо» открывается папками каналов (DESIGN §4.17). */
export type SectionType = Exclude<ItemType, 'promo'>

interface SectionConfig {
  /** Сортировки раздела; первая — по умолчанию (DESIGN §4.2). */
  sorts: readonly SortBase[]
  numberOrder: 'asc' | 'desc'
  /** Чипы типа, кроме общих. */
  chips: readonly CatalogChipKey[]
  /** Пустой раздел: что происходит и прямой путь. */
  empty: string
}

const EMPTY_TAIL = 'всё новое приходит в Приехало'

/** Свои чипы, сортировки и слова пустого раздела у каждого типа (DESIGN §4.2). */
export const SECTION_CONFIG: Record<SectionType, SectionConfig> = {
  ppv: {
    sorts: ['number', 'arrived', 'stale', 'duration'],
    numberOrder: 'desc',
    chips: ['kind', 'noteaser', 'nophotos'],
    empty: `PPV пока нет — ${EMPTY_TAIL}`,
  },
  fyp: {
    sorts: ['arrived', 'number', 'stale', 'best'],
    numberOrder: 'desc',
    chips: ['nover', 'steady'],
    empty: `Фупов пока нет — ${EMPTY_TAIL}`,
  },
  custom: {
    sorts: ['number', 'arrived', 'duration'],
    numberOrder: 'desc',
    chips: ['name', 'photo'],
    empty: `Кастомов пока нет — ${EMPTY_TAIL}`,
  },
  set: {
    sorts: ['number', 'arrived', 'stale'],
    numberOrder: 'desc',
    chips: ['unpicked'],
    empty: `Сетов пока нет — ${EMPTY_TAIL}`,
  },
  sexting: {
    sorts: ['number', 'arrived', 'stale'],
    numberOrder: 'asc',
    chips: [],
    empty: `Секстингов пока нет — ${EMPTY_TAIL}`,
  },
  life: {
    sorts: ['shot', 'arrived', 'stale'],
    numberOrder: 'desc',
    chips: ['unassigned', 'use'],
    empty: `Лайфа пока нет — ${EMPTY_TAIL}`,
  },
  raw: {
    sorts: ['shot', 'arrived', 'number'],
    numberOrder: 'desc',
    chips: ['purpose'],
    empty: `Сырья пока нет — ${EMPTY_TAIL}`,
  },
}

/** Общие чипы: «Где залито ▾» первым, остальные после чипов типа. */
export function chipsOf(type: SectionType): CatalogChipKey[] {
  return ['where', ...SECTION_CONFIG[type].chips, 'tags', 'markup', 'period', 'second']
}
