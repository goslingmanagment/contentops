import { TAG_GROUP_LABEL, type Tag, TagGroupSchema } from '@contentops/contracts'
import type { TagGroupOption, TagOption } from '@contentops/ui/components/tag-input'

/** Словарь тегов для `TagInput`: тег показывается русским именем, если оно есть. */
export function tagOptionsOf(tags: readonly Tag[] | undefined): TagOption[] {
  return (tags ?? []).map((tag) => ({
    value: tag.key,
    label: tag.ru ?? tag.key,
    group: tag.group ?? undefined,
  }))
}

/** Три группы словаря: «действия / атрибуты / настроение» (DESIGN §4.4). */
export const TAG_GROUP_OPTIONS: readonly TagGroupOption[] = TagGroupSchema.options.map((group) => ({
  value: group,
  label: TAG_GROUP_LABEL[group],
}))

/** Русское имя тега для строк и подсказок. */
export function tagLabel(tags: readonly Tag[] | undefined, key: string): string {
  return tags?.find((tag) => tag.key === key)?.ru ?? key
}
