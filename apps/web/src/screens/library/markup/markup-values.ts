import type {
  CatalogEntry,
  FieldStatus,
  MarkupField,
  MarkupFieldKey,
  MarkupReviewItem,
  RecordVersion,
  Tag,
} from '@contentops/contracts'

/**
 * Что строка «Разметки на проверку» показывает из полей (DESIGN §4.20, §5.4): название,
 * теги русскими именами и описание — значения черновика, а не только его состояние.
 */
export interface MarkupRowValues {
  title: string
  tags: string
  description: string
  /** Черновик от ИИ хотя бы в одном поле: в строке метка «ИИ». */
  fromAi: boolean
  /** Версии полей, которые видны в строке: их и подтверждает «Подтвердить всю разметку». */
  seen: { key: MarkupFieldKey; version: RecordVersion }[]
}

const DRAFT: ReadonlySet<FieldStatus> = new Set(['draft_ai', 'draft_import', 'ai_failed'])

function valueText(field: MarkupField, names: ReadonlyMap<string, string>): string {
  switch (field.field.key) {
    case 'title':
    case 'description':
      return field.field.value
    case 'tags':
      return field.field.value.map((key) => names.get(key) ?? key).join(', ')
    default:
      return ''
  }
}

export function markupRowValues(
  item: MarkupReviewItem,
  tags: readonly Tag[] | undefined,
): MarkupRowValues {
  const names = new Map((tags ?? []).map((tag) => [tag.key, tag.ru ?? tag.key]))
  const text = (key: MarkupFieldKey) => {
    const field = item.fields.find((candidate) => candidate.field.key === key)
    return field ? valueText(field, names) : ''
  }
  return {
    title: text('title'),
    tags: text('tags'),
    description: text('description'),
    fromAi: item.fields.some((field) => field.status === 'draft_ai'),
    seen: item.fields
      .filter((field) => DRAFT.has(field.status))
      .map((field) => ({ key: field.field.key, version: field.version })),
  }
}

/** Строка папки: объект каталога и значения его полей. */
export interface MarkupLine {
  entry: CatalogEntry
  values: MarkupRowValues
}
