import {
  type CatalogEntry,
  FAN_NAME_LABEL,
  type ItemId,
  type MakePpvCommand,
  MakePpvCommandSchema,
  type MakePpvResult,
  PPV_KIND_LABEL,
  type PpvKind,
  PpvKindSchema,
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
import { StatusSign } from '@contentops/ui/components/status-sign'
import { zodResolver } from '@hookform/resolvers/zod'
import { UploadIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useItem } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { FilePicker } from '@/shell/upload/file-picker'
import { useUploads } from '@/shell/upload/upload-context'
import { SourceLine } from './source-line'
import { useCreatedPpv } from './use-created-ppv'

type MasterSource = MakePpvCommand['source']

const SOURCE_CHOICES: readonly { value: MasterSource; label: string }[] = [
  { value: 'as_is', label: 'Взять мастер как есть' },
  { value: 'upload', label: 'Загрузить свой монтаж' },
]

export const KIND_CHOICES: readonly { value: PpvKind; label: string }[] = PpvKindSchema.options.map(
  (kind) => ({ value: kind, label: PPV_KIND_LABEL[kind] }),
)

interface MakePpvFormProps {
  source: ItemId
  onDone: () => void
}

/**
 * «Сделать PPV» из кастома (DESIGN §4.5, сценарий §6.6): вид, название и мастер. Если имени
 * фана в ролике нет — мастер берётся как есть; есть или неизвестно — нужен свой монтаж:
 * зона файла и «Загрузить» вместо «Создать PPV», без файла кнопка неактивна. Загрузка идёт
 * с целью «PPV из CUS-…» и принимается сама после проверки — тогда и выдаётся номер. Связь
 * «PPV из кастома» пишется сама, имя фана не переносится.
 */
export function MakePpvForm({ source, onDone }: MakePpvFormProps) {
  const model = useCurrentModel().code
  const custom = useItem(model, source).data
  if (!custom) {
    return (
      <div className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Сделать PPV из {source}</DialogTitle>
          <DialogDescription className="sr-only">Вид, название и мастер</DialogDescription>
        </DialogHeader>
        <Skeleton className="h-14" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    )
  }
  return <MakePpvFields source={source} entry={custom.entry} onDone={onDone} />
}

function MakePpvFields({ source, entry, onDone }: MakePpvFormProps & { entry: CatalogEntry }) {
  const model = useCurrentModel().code
  const api = useApi()
  const titleId = useId()
  const nameInVideo = entry.fan_name !== 'no'
  const form = useForm<MakePpvCommand>({
    resolver: zodResolver(MakePpvCommandSchema),
    // Имя может звучать — вариант один, свой монтаж: зона файла открыта сразу.
    defaultValues: {
      title: entry.title,
      source: nameInVideo ? 'upload' : 'as_is',
      montage: null,
    },
  })
  const [montageFile, setMontageFile] = useState<File | null>(null)
  const created = useCreatedPpv(source, onDone)
  const create = useIntentMutation<MakePpvCommand, MakePpvResult>({
    failed: 'PPV не создан',
    run: (body, idempotencyKey) =>
      api.objects.makePpv({ params: { model, id: source }, body, idempotencyKey }),
    onSuccess: created,
  })
  const [kind, masterSource] = form.watch(['kind', 'source'])
  const upload = masterSource === 'upload'
  const { startUpload } = useUploads()
  const toast = useActionToast()

  // Свой монтаж идёт в лоток с целью «PPV из CUS-…» и принимается при загрузке (SPEC §6.1):
  // номер PPV выдаётся, когда файл на сервере и проверен; лоток скажет «принято → PPV-077».
  const submit = (body: MakePpvCommand) => {
    if (body.source === 'upload' && montageFile) {
      startUpload([montageFile], {
        target: {
          kind: 'ppv-from',
          itemId: source,
          title: `PPV из ${source}`,
          ppvKind: body.kind,
          ppvTitle: body.title,
        },
        kind: 'master_version',
      })
      toast.show({ message: `Монтаж загружается → PPV из ${source} · номер после проверки` })
      onDone()
      return
    }
    create.start(body)
  }

  const chooseMontage = (files: readonly File[]) => {
    // Монтаж один: новый выбор заменяет прежний.
    const file = files.at(-1) ?? null
    setMontageFile(file)
    form.setValue('montage', file ? { file_name: file.name, size_bytes: file.size } : null, {
      shouldValidate: file !== null,
    })
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Сделать PPV из {source}</DialogTitle>
        <DialogDescription className="sr-only">Вид, название и мастер</DialogDescription>
      </DialogHeader>
      <SourceLine entry={entry} />
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
        <Input
          id={titleId}
          {...form.register('title')}
          aria-invalid={!!form.formState.errors.title}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Мастер</h3>
        {nameInVideo ? (
          <p className="flex items-center gap-2 text-attention-ink text-sm">
            <StatusSign kind="turn" />
            {entry.fan_name ? FAN_NAME_LABEL[entry.fan_name] : 'имя: не знаю'} — нужен свой монтаж
          </p>
        ) : null}
        <Controller
          control={form.control}
          name="source"
          render={({ field }) => (
            <ChoiceChips
              label="Мастер"
              choices={
                nameInVideo
                  ? SOURCE_CHOICES.filter((choice) => choice.value === 'upload')
                  : SOURCE_CHOICES
              }
              value={field.value ?? null}
              onChange={(next) => {
                field.onChange(next)
                if (next === 'as_is') {
                  chooseMontage([])
                }
              }}
            />
          )}
        />
        {upload ? (
          <FilePicker
            single
            files={montageFile ? [montageFile] : []}
            onFilesChange={chooseMontage}
            error={form.formState.errors.montage?.message}
          />
        ) : null}
      </section>
      <DialogFooter className="items-end">
        {upload ? (
          <p className="mr-auto min-h-5 text-ink-3 text-sm">
            {!montageFile
              ? 'Выберите файл монтажа'
              : kind
                ? 'PPV появится после проверки'
                : 'Выберите вид: бандл или в личку'}
          </p>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDone}>
          Отмена
        </Button>
        {upload ? (
          <Button type="submit" disabled={!kind || !montageFile} pending={create.isPending}>
            <UploadIcon />
            Загрузить
          </Button>
        ) : (
          <Button type="submit" disabled={!kind || !masterSource} pending={create.isPending}>
            Создать PPV
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
