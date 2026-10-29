import { ITEM_TYPE_INFO, type ItemType } from '@contentops/contracts'

/**
 * Куда можно попасть по слову из поиска (DESIGN §2.1: «поиск понимает названия
 * разделов»): разделы колонки, вкладка «Сверить», заказы и папки Библиотеки.
 */
export type Destination =
  | { kind: 'section'; section: 'inbox' | 'library' | 'plan' | 'journal' }
  | { kind: 'check' }
  | { kind: 'orders' }
  | { kind: 'folder'; type: ItemType }
  | { kind: 'not-uploaded' }

export interface NamedDestination {
  label: string
  /** Где это: «Раздел», «Папка Библиотеки». */
  place: string
  destination: Destination
  /** Другие слова, по которым находится: «приёмка», «задачи». */
  aliases: readonly string[]
}

const SECTIONS: readonly NamedDestination[] = [
  {
    label: 'Приехало',
    place: 'Раздел',
    destination: { kind: 'section', section: 'inbox' },
    aliases: ['новое', 'приемка'],
  },
  {
    label: 'Библиотека',
    place: 'Раздел',
    destination: { kind: 'section', section: 'library' },
    aliases: ['каталог'],
  },
  {
    label: 'План',
    place: 'Раздел',
    destination: { kind: 'section', section: 'plan' },
    aliases: ['задачи'],
  },
  { label: 'Сверить', place: 'План', destination: { kind: 'check' }, aliases: ['сверка'] },
  {
    label: 'Журнал',
    place: 'Раздел',
    destination: { kind: 'section', section: 'journal' },
    aliases: ['история'],
  },
  { label: 'Заказы', place: 'Кастомы', destination: { kind: 'orders' }, aliases: ['заказ'] },
]

const FOLDER_ALIASES: Record<ItemType, readonly string[]> = {
  ppv: ['ппв'],
  fyp: ['фуп', 'фупы'],
  custom: ['кастом'],
  set: ['сет'],
  sexting: ['сексты', 'секстинг'],
  life: ['лайфы'],
  raw: ['сырье', 'съемки'],
  promo: ['подборки'],
}

const FOLDERS: readonly NamedDestination[] = [
  ...(Object.keys(FOLDER_ALIASES) as ItemType[]).map((type) => ({
    label: ITEM_TYPE_INFO[type].folder,
    place: 'Папка Библиотеки',
    destination: { kind: 'folder' as const, type },
    aliases: FOLDER_ALIASES[type],
  })),
  {
    label: 'Ещё не залито',
    place: 'Папка Библиотеки',
    destination: { kind: 'not-uploaded' },
    aliases: ['не залито', 'незалитое'],
  },
]

export const NAMED_DESTINATIONS: readonly NamedDestination[] = [...SECTIONS, ...FOLDERS]
