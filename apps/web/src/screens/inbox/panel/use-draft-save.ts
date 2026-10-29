import type { DraftFields, InboxGroup, UpdateDraftCommand } from '@contentops/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useInboxCommands, usePutInboxGroup } from '@/data/inbox'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'

type FieldKey = keyof DraftFields

const FIELD_WORD: Partial<Record<FieldKey, string>> = {
  title: 'название',
  description: 'описание',
  tags: 'теги',
}

/** Поля, правку которых можно отменить из полоски (§3.8): теги, название, описание. */
const UNDOABLE: ReadonlySet<FieldKey> = new Set(['title', 'description', 'tags'])

interface DraftEdit {
  patch: UpdateDraftCommand
  /** Прежние значения для «Отменить»; у самой отмены — `null`. */
  previous: UpdateDraftCommand | null
}

export interface DraftConflict {
  field: FieldKey
  message: string
  theirsLabel: string
  mine: UpdateDraftCommand
}

function fieldOf(patch: UpdateDraftCommand): FieldKey | undefined {
  return (Object.keys(patch) as FieldKey[])[0]
}

function previousOf(fields: DraftFields, patch: UpdateDraftCommand): UpdateDraftCommand {
  const keys = Object.keys(patch) as FieldKey[]
  return Object.fromEntries(keys.map((key) => [key, fields[key]])) as UpdateDraftCommand
}

/**
 * Сохранение полей черновика (DESIGN §3.8, §3.10) на общем `useVersionedSave`: запрос
 * несёт версию группы, которую видел человек; «Сохранено · Отменить» — только после
 * ответа. Если запись успели изменить (412), на месте поля встаёт строка конфликта, ввод
 * не пропадает; «Оставить мой» идёт поверх версии из ответа сервера.
 */
export function useDraftSave(group: InboxGroup) {
  const model = useCurrentModel().code
  const commands = useInboxCommands(model)
  const putGroup = usePutInboxGroup(model)
  const toast = useActionToast()
  const latest = useRef(group)
  const [savingField, setSavingField] = useState<FieldKey | null>(null)

  useEffect(() => {
    latest.current = group
  }, [group])

  const invalidates = useMemo(() => [queryKeys.inbox(model, 'active')], [model])
  const undoRef = useRef<(previous: UpdateDraftCommand) => void>(() => undefined)

  const versioned = useVersionedSave<DraftEdit, InboxGroup>({
    subject: ({ patch }) => FIELD_WORD[fieldOf(patch) ?? 'title'] ?? 'поле',
    failed: 'Не сохранилось',
    invalidates,
    run: ({ patch }, version, key) => commands.update({ ...latest.current, version }, patch, key),
    onSuccess: (saved, { patch, previous }) => {
      latest.current = saved
      putGroup(saved)
      const field = fieldOf(patch)
      if (previous && field && UNDOABLE.has(field)) {
        toast.show({
          message: 'Сохранено',
          undoable: true,
          action: { label: 'Отменить', onSelect: () => undoRef.current(previous) },
        })
      }
    },
  })
  const { save: versionedSave, keepMine: versionedKeepMine, dismissConflict } = versioned

  // Другая группа в панели — прежний конфликт к ней не относится.
  const groupId = group.id
  useEffect(() => {
    if (groupId) {
      dismissConflict()
    }
  }, [groupId, dismissConflict])

  const track = useCallback(async (field: FieldKey | undefined, saving: Promise<boolean>) => {
    setSavingField(field ?? null)
    try {
      return await saving
    } finally {
      setSavingField(null)
    }
  }, [])

  /** `true` — сервер принял правку; `withUndo` — показать «Отменить» в полоске. */
  const save = useCallback(
    (patch: UpdateDraftCommand, withUndo = true): Promise<boolean> => {
      const field = fieldOf(patch)
      if (field === undefined) {
        return Promise.resolve(true)
      }
      const previous = withUndo ? previousOf(latest.current.fields, patch) : null
      return track(field, versionedSave({ patch, previous }, latest.current.version))
    },
    [track, versionedSave],
  )
  undoRef.current = (previous) => void save(previous, false)

  const conflict = useMemo<DraftConflict | null>(() => {
    const view = versioned.conflict
    const field = view ? fieldOf(view.mine.patch) : undefined
    return view && field
      ? { field, message: view.message, theirsLabel: view.theirsLabel, mine: view.mine.patch }
      : null
  }, [versioned.conflict])

  /** «Оставить мой»: свой ввод поверх версии, которую прислал сервер. */
  const keepMine = useCallback(
    () => track(conflict?.field, versionedKeepMine()),
    [conflict?.field, track, versionedKeepMine],
  )

  return { save, savingField, conflict, showTheirs: versioned.showTheirs, keepMine }
}

export type DraftSave = ReturnType<typeof useDraftSave>
