import type { ItemDetail } from '@contentops/contracts'

type Source = NonNullable<ItemDetail['ydisk']['source']>

/** Имя источника в подписях (DESIGN §1.1): «На Я.Диске» или «На Dropbox». */
export const SOURCE_WORDS: Record<Source, { on: string; open: string; show: string }> = {
  ydisk: { on: 'На Я.Диске', open: 'Открыть на Я.Диске', show: 'Показать на Я.Диске ↗' },
  dropbox: { on: 'На Dropbox', open: 'Открыть в Dropbox', show: 'Показать в Dropbox ↗' },
}

/** Пункт меню объекта, когда карточка ещё не пришла: у модели с Dropbox — без имени. */
export function showInSourceLabel(sources: readonly Source[]): string {
  const [only] = sources
  return sources.length === 1 && only ? SOURCE_WORDS[only].show : 'Показать в источнике ↗'
}
