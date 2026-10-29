import { capitalize, type InboxGroup } from '@contentops/contracts'

/**
 * Откуда группа (DESIGN §4.8): путь Я.Диска — моноширинным; загрузка через браузер места на
 * Я.Диске не имеет — «загружено через браузер · Диана» обычным серым.
 */
export function groupSource(group: Pick<InboxGroup, 'source_path' | 'uploaded_by'>): {
  text: string
  path: boolean
} {
  return group.uploaded_by
    ? { text: `загружено через браузер · ${group.uploaded_by.name}`, path: false }
    : { text: group.source_path, path: true }
}

/** Первый факт «Что это?»: «Корень Я.Диска: 8. Other» или «Загружено через браузер · Диана». */
export function groupOrigin(group: Pick<InboxGroup, 'root' | 'source_path' | 'uploaded_by'>) {
  const source = groupSource(group)
  return source.path ? `Корень Я.Диска: ${group.root}` : capitalize(source.text)
}
