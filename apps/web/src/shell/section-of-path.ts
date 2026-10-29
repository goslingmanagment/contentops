import type { SectionKey } from './last-section'

/**
 * Раздел колонки по адресу: объект и его файлы — часть Библиотеки, остальное — по
 * второму сегменту (`/lora/plan/…` → План). Поиск и настройки к разделам не относятся.
 */
const SECTION_BY_SEGMENT: Readonly<Record<string, SectionKey>> = {
  library: 'library',
  i: 'library',
  a: 'library',
  inbox: 'inbox',
  plan: 'plan',
  journal: 'journal',
}

export function sectionOfPath(pathname: string): SectionKey | null {
  const segment = pathname.split('/')[2]
  return segment === undefined ? null : (SECTION_BY_SEGMENT[segment] ?? null)
}
