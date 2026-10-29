import {
  type Account,
  type NormKind,
  type PersonRef,
  type UpdateWeekNormCommand,
  UpdateWeekNormCommandSchema,
  type WeekNorm,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'
import { PostingLines, ReleaseLine } from './norm-extras'
import { NormGrid } from './norm-grid'
import { editableOf, weekTotals } from './norm-text'

interface NormEditorProps {
  norm: WeekNorm
  page: Account
  people: readonly PersonRef[]
  readOnly: boolean
}

/**
 * Норма недели страницы (DESIGN §4.14): сетка «тип × день», выпуск раз в N недель, кто
 * обычно выкладывает и уровень версий. «Сохранено» — только после ответа сервера; чужая
 * правка не затирается молча (412 → строка конфликта). План пересчитывает пустые места
 * сразу после сохранения.
 */
export function NormEditor({ norm, page, people, readOnly }: NormEditorProps) {
  const pageLabel = page.label
  // Фупов на OnlyFans нет: у страницы OnlyFans нет ни строки «Фуп», ни уровня версий.
  const onlyFans = page.platform === 'onlyfans'
  const hidden: ReadonlySet<NormKind> = new Set(onlyFans ? ['fyp'] : [])
  const model = useCurrentModel().code
  const commands = usePlanCommands(model)
  const toast = useActionToast()
  const form = useForm<UpdateWeekNormCommand>({
    resolver: zodResolver(UpdateWeekNormCommandSchema),
    defaultValues: editableOf(norm),
  })
  const values = form.watch()
  const save = useVersionedSave({
    run: (values: UpdateWeekNormCommand, version: number, key: string) =>
      commands.updateNorm({ key, account: norm.account, version, norm: values }),
    failed: 'Норма не сохранилась',
    subject: 'норму',
    invalidates: [...planChangedKeys(model), queryKeys.weekNorm(model, norm.account)],
    onSuccess: (saved: WeekNorm) => {
      form.reset(editableOf(saved))
      toast.show({ message: `Сохранено · норма ${pageLabel}` })
    },
  })

  // Свежая норма с сервера встаёт в форму, только если человек ничего не правит или сам
  // попросил «Показать её вариант»: фон не сбрасывает ввод (§3.13).
  const [takeFresh, setTakeFresh] = useState(false)
  const { isDirty } = form.formState
  useEffect(() => {
    if (!isDirty || takeFresh) {
      form.reset(editableOf(norm))
      setTakeFresh(false)
    }
  }, [norm, form, isDirty, takeFresh])

  return (
    <form
      className="flex min-w-0 flex-col gap-5"
      onSubmit={form.handleSubmit(() => save.save(form.getValues(), norm.version))}
    >
      {save.conflict ? (
        <ConflictLine
          message={save.conflict.message}
          theirsLabel={save.conflict.theirsLabel}
          onShowTheirs={() => {
            setTakeFresh(true)
            save.showTheirs()
          }}
          onKeepMine={() => save.keepMine(form.getValues())}
        />
      ) : null}
      <NormGrid
        cells={values.cells}
        hidden={hidden}
        readOnly={readOnly}
        onCountChange={(row, day, count) =>
          form.setValue(`cells.${row}.per_day.${day}`, count, { shouldDirty: true })
        }
        onTimeChange={(row, time) =>
          form.setValue(`cells.${row}.time`, time, { shouldDirty: true })
        }
      />
      <p className="text-base">{weekTotals(values, hidden)}</p>
      <div className="flex flex-col border-border border-t pt-3">
        <ReleaseLine
          release={values.release}
          readOnly={readOnly}
          onChange={(release) => form.setValue('release', release, { shouldDirty: true })}
        />
        <PostingLines
          assignee={values.usual_assignee}
          level={values.uniq_level}
          withFypLevel={!onlyFans}
          people={people}
          readOnly={readOnly}
          onAssigneeChange={(assignee) =>
            form.setValue('usual_assignee', assignee, { shouldDirty: true })
          }
          onLevelChange={(level) => form.setValue('uniq_level', level, { shouldDirty: true })}
        />
      </div>
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!isDirty} pending={save.isPending}>
            Сохранить
          </Button>
          {isDirty ? (
            <Button type="button" variant="ghost" onClick={() => form.reset(editableOf(norm))}>
              Вернуть как было
            </Button>
          ) : null}
        </div>
      )}
    </form>
  )
}
