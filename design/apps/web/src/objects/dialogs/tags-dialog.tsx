import {
  type BatchResult,
  type BatchTagsCommand,
  BatchTagsCommandSchema,
  type CatalogEntry,
  formatNumber,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { TagInput } from '@contentops/ui/components/tag-input'
import { zodResolver } from '@hookform/resolvers/zod'
import { XIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useTags } from '@/data/catalog'
import { queryKeys } from '@/data/query-keys'
import { useCurrentModel } from '@/shell/model/model-context'
import { batchMessage } from '../batch-message'
import { TAG_GROUP_OPTIONS, tagLabel, tagOptionsOf } from '../tag-options'

interface TagsDialogProps {
  entries: readonly CatalogEntry[]
  onClose: () => void
}

/** Теги, которые уже стоят у выбранных, с числом объектов: «кружево · 5». */
function tagsInSelection(entries: readonly CatalogEntry[]): { key: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * «Теги…» для нескольких объектов (DESIGN §3.3): добавить одной строкой ввода и убрать
 * нажатием на тег, который уже стоит. Пакет «по каждой записи», итог одной полоской.
 */
export function TagsDialog({ entries, onClose }: TagsDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const tags = useTags().data
  const options = useMemo(() => tagOptionsOf(tags), [tags])
  const present = useMemo(() => tagsInSelection(entries), [entries])
  const form = useForm<BatchTagsCommand>({
    resolver: zodResolver(BatchTagsCommandSchema),
    defaultValues: { items: entries.map((entry) => entry.id), add: [], remove: [] },
  })
  const add = form.watch('add')
  const remove = form.watch('remove')

  const apply = useIntentMutation<BatchTagsCommand, BatchResult>({
    failed: 'Теги не сохранились',
    run: (body, idempotencyKey) =>
      api.objectBatch.tags({ params: { model }, body, idempotencyKey }),
    invalidates: () => [queryKeys.catalogIndex(model), queryKeys.model(model)],
    onSuccess: (result) => {
      onClose()
      toast.show({ message: batchMessage(result, 'Теги изменены') })
    },
  })

  const toggleRemove = (key: string) =>
    form.setValue(
      'remove',
      remove.includes(key) ? remove.filter((tag) => tag !== key) : [...remove, key],
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-130">
        <form onSubmit={form.handleSubmit(apply.start)} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Теги</DialogTitle>
            <DialogDescription>
              {`Выбрано ${formatNumber(entries.length)} ${plural(entries.length, ['объект', 'объекта', 'объектов'])}`}
            </DialogDescription>
          </DialogHeader>
          <section className="flex flex-col gap-2">
            <h3 className="text-ink-3 text-sm">Добавить</h3>
            <Controller
              control={form.control}
              name="add"
              render={({ field }) => (
                <TagInput
                  label="Добавить теги"
                  value={field.value}
                  onChange={field.onChange}
                  options={options}
                  groups={TAG_GROUP_OPTIONS}
                />
              )}
            />
          </section>
          {present.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-ink-3 text-sm">Убрать</h3>
              <div className="flex flex-wrap gap-1.5">
                {present.map(({ key, count }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={remove.includes(key)}
                    onClick={() => toggleRemove(key)}
                    className="inline-flex h-7 items-center gap-1 rounded-3xl bg-secondary px-2.5 text-sm transition-colors duration-120 hover:bg-secondary-hover aria-pressed:bg-destructive-bg aria-pressed:text-destructive aria-pressed:line-through"
                  >
                    {tagLabel(tags, key)}
                    <span className="text-ink-3 tabular-nums">{formatNumber(count)}</span>
                    {remove.includes(key) ? <XIcon className="size-3.5" /> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button
              type="submit"
              disabled={add.length + remove.length === 0}
              pending={apply.isPending}
            >
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
