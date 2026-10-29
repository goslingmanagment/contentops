import type { MarkupField, MarkupFieldKey } from '@contentops/contracts'
import { useObjectPage } from '../../object-context'

/** Поле разметки объекта по ключу; у объекта без поля — `undefined`. */
export function useMarkupField(key: MarkupFieldKey): MarkupField | undefined {
  return useObjectPage().detail.markup.find((field) => field.field.key === key)
}
