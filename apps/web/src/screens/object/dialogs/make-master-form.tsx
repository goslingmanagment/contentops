import {
  type AcceptResult,
  type CatalogEntry,
  formatDuration,
  type ItemFile,
  type ItemId,
  type MakeMasterCommand,
  MakeMasterCommandSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { Input } from '@contentops/ui/components/input'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { Thumb } from '@contentops/ui/components/thumb'
import { zodResolver } from '@hookform/resolvers/zod'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import { useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useItem } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { readFileSelection } from '../files/file-selection'
import { fileCover } from '../files/file-thumb'
import { KIND_CHOICES } from './make-ppv-form'
import { SourceLine } from './source-line'
import { useCreatedPpv } from './use-created-ppv'

interface MakeMasterFormProps {
  source: ItemId
  onDone: () => void
}

/**
 * «Сделать мастером PPV» из сырья (DESIGN §4.5): выбранное видео съёмки становится
 * мастером нового PPV с происхождением «выделен из», принятие — в этом же окне, без
 * повторной обработки.
 */
export function MakeMasterForm({ source, onDone }: MakeMasterFormProps) {
  const model = useCurrentModel().code
  const raw = useItem(model, source).data
  if (!raw) {
    return (
      <div className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Сделать мастером PPV</DialogTitle>
          <DialogDescription className="sr-only">Видео, вид и название</DialogDescription>
        </DialogHeader>
        <Skeleton className="h-14" />
        <Skeleton className="h-32" />
      </div>
    )
  }
  const videos = raw.files.filter((file) => file.media === 'video')
  return <MakeMasterFields source={source} entry={raw.entry} videos={videos} onDone={onDone} />
}

interface MakeMasterFieldsProps extends MakeMasterFormProps {
  entry: CatalogEntry
  videos: readonly ItemFile[]
}

function MakeMasterFields({ source, entry, videos, onDone }: MakeMasterFieldsProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const titleId = useId()
  const selected = readFileSelection(source)
  const preselected = videos.find((video) => selected.includes(video.key))?.key
  const form = useForm<MakeMasterCommand>({
    resolver: zodResolver(MakeMasterCommandSchema),
    defaultValues: { file_key: preselected, title: '' },
  })
  const created = useCreatedPpv(source, onDone)
  const create = useIntentMutation<MakeMasterCommand, AcceptResult>({
    failed: 'PPV не создан',
    run: (body, idempotencyKey) =>
      api.objectFiles.makeMaster({ params: { model, id: source }, body, idempotencyKey }),
    onSuccess: created,
  })
  const [fileKey, kind, title] = form.watch(['file_key', 'kind', 'title'])

  return (
    <form onSubmit={form.handleSubmit(create.start)} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Сделать мастером PPV</DialogTitle>
        <DialogDescription className="sr-only">Видео, вид и название</DialogDescription>
      </DialogHeader>
      <SourceLine entry={entry} />
      <section className="flex flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Видео</h3>
        <Controller
          control={form.control}
          name="file_key"
          render={({ field }) => (
            <RadioGroupPrimitive.Root
              aria-label="Видео"
              value={field.value ?? ''}
              onValueChange={field.onChange}
              className="flex flex-wrap gap-2"
            >
              {videos.map((video) => (
                <RadioGroupPrimitive.Item
                  key={video.key}
                  value={video.key}
                  className="flex w-18 flex-col gap-1 rounded-lg p-1 text-left transition-colors duration-120 hover:bg-accent data-[state=checked]:bg-primary-tint data-[state=checked]:ring-2 data-[state=checked]:ring-primary data-[state=checked]:ring-inset"
                >
                  <Thumb
                    {...fileCover(entry, video)}
                    aspect="9:16"
                    showCaptions={false}
                    className="rounded-md"
                  />
                  <span className="text-ink-3 text-xs tabular-nums">
                    {video.duration_s === null ? video.file_name : formatDuration(video.duration_s)}
                  </span>
                </RadioGroupPrimitive.Item>
              ))}
            </RadioGroupPrimitive.Root>
          )}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Вид</h3>
        <Controller
          control={form.control}
          name="kind"
          render={({ field }) => (
            <ChoiceChips
              label="Вид PPV"
              choices={KIND_CHOICES}
              value={field.value ?? null}
              onChange={field.onChange}
            />
          )}
        />
      </section>
      <section className="flex flex-col gap-2">
        <label htmlFor={titleId} className="text-ink-3 text-sm">
          Название
        </label>
        <Input id={titleId} placeholder="Два-четыре слова" {...form.register('title')} />
      </section>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Отмена
        </Button>
        <Button
          type="submit"
          disabled={!fileKey || !kind || !title?.trim()}
          pending={create.isPending}
        >
          Создать PPV
        </Button>
      </DialogFooter>
    </form>
  )
}
