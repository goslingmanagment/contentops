import type { ItemDetail, MarkupFieldKey, MarkupValue } from '@contentops/contracts'
import { useCallback, useMemo, useRef } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useApi } from '@/data/api-session'
import { useItemWriter } from '@/data/object'
import { queryKeys } from '@/data/query-keys'
import { useObjectPage } from '../../object-context'

/** Конфликт версии (412) на месте поля: «Диана изменила название 1 мин назад». */
export interface FieldConflict {
  message: string
  theirsLabel: string
  /** Что человек ввёл: «Оставить мой» отправит это ещё раз поверх новой версии. */
  draft: MarkupValue
}

const FIELD_ACCUSATIVE: Record<MarkupFieldKey, string> = {
  title: 'название',
  title_en: 'английское название',
  tags: 'теги',
  description: 'описание',
  timeline: 'хронологию',
  platform_texts: 'тексты для платформы',
}

interface FieldEdit {
  value: MarkupValue
  /** Прежнее значение для «Отменить»; у самой отмены его нет. */
  previous: MarkupValue | null
}

function fieldOf(detail: ItemDetail, key: MarkupFieldKey) {
  return detail.markup.find((field) => field.field.key === key)
}

/**
 * Сохранение поля разметки с `If-Match` версии поля (DESIGN §4.4) на общем
 * `useVersionedSave`: «Сохранено · Отменить» только после ответа, отмена возвращает
 * прежнее значение. Конфликт версии не уходит в полоску, а встаёт строкой на месте поля с
 * двумя выходами (§3.10); «Оставить мой» идёт поверх версии из ответа сервера.
 */
export function useFieldSave(key: MarkupFieldKey) {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const toast = useActionToast()
  const write = useItemWriter(model.code)
  const invalidates = useMemo(
    () => [queryKeys.item(model.code, detail.entry.id)],
    [detail.entry.id, model.code],
  )
  const undoRef = useRef<(saved: ItemDetail, previous: MarkupValue) => void>(() => undefined)

  const versioned = useVersionedSave<FieldEdit, ItemDetail>({
    subject: FIELD_ACCUSATIVE[key],
    failed: 'Не сохранилось',
    invalidates,
    run: ({ value }, version, idempotencyKey) =>
      api.objects.updateField({
        params: { model: model.code, id: detail.entry.id, field: key },
        body: value,
        ifMatch: version,
        idempotencyKey,
      }),
    onSuccess: (saved, { previous }) => {
      write(saved)
      if (previous === null) {
        toast.show({ message: 'Отменено' })
        return
      }
      toast.show({
        message: 'Сохранено',
        undoable: true,
        action: { label: 'Отменить', onSelect: () => undoRef.current(saved, previous) },
      })
    },
  })
  const { save: versionedSave } = versioned
  undoRef.current = (saved, previous) =>
    void versionedSave({ value: previous, previous: null }, fieldOf(saved, key)?.version ?? 1)

  const save = useCallback(
    (value: MarkupValue) => {
      const field = fieldOf(detail, key)
      return versionedSave({ value, previous: field?.field ?? null }, field?.version ?? 1)
    },
    [detail, key, versionedSave],
  )

  const conflict = useMemo<FieldConflict | null>(
    () =>
      versioned.conflict
        ? {
            message: versioned.conflict.message,
            theirsLabel: versioned.conflict.theirsLabel,
            draft: versioned.conflict.mine.value,
          }
        : null,
    [versioned.conflict],
  )

  return {
    save,
    pending: versioned.isPending,
    conflict,
    showTheirs: versioned.showTheirs,
    keepMine: versioned.keepMine,
  }
}

export type FieldSave = ReturnType<typeof useFieldSave>
