import {
  UPLOAD_KIND_LABEL,
  type UploadKind,
  UploadKindSchema,
  uploadKindNeedsTarget,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { zodResolver } from '@hookform/resolvers/zod'
import { UploadIcon } from 'lucide-react'
import { useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { FilePicker } from './file-picker'
import { type UploadForm, UploadFormSchema } from './upload-form'
import { defaultUploadKind, type UploadTarget } from './upload-target'
import { TargetLine } from './upload-target-line'

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UploadTarget | null
  /** Вид, выбранный заранее: «Новая версия мастера» после «Загрузить свой монтаж». */
  initialKind: UploadKind | null
  /** Файлы, отпущенные на окно, — уже выбраны. */
  initialFiles: readonly File[]
  onSubmit: (form: UploadForm) => void
}

/**
 * Окно «Загрузить» (DESIGN §3.7, 480): вид файла одной кнопкой, цель уже подставлена,
 * «Загрузить». С целью файл после проверки привязывается сам, без второго «Принять».
 */
export function UploadDialog({
  open,
  onOpenChange,
  target,
  initialKind,
  initialFiles,
  onSubmit,
}: UploadDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {open ? (
          <UploadFormBody
            target={target}
            initialKind={initialKind}
            initialFiles={initialFiles}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface UploadFormBodyProps {
  target: UploadTarget | null
  initialKind: UploadKind | null
  initialFiles: readonly File[]
  onCancel: () => void
  onSubmit: (form: UploadForm) => void
}

function UploadFormBody({
  target,
  initialKind,
  initialFiles,
  onCancel,
  onSubmit,
}: UploadFormBodyProps) {
  const form = useForm<UploadForm>({
    resolver: zodResolver(UploadFormSchema),
    defaultValues: { kind: initialKind ?? defaultUploadKind(target), files: [...initialFiles] },
  })
  const kind = form.watch('kind')
  const files = form.watch('files')
  const missingTarget = uploadKindNeedsTarget(kind) && target === null
  const kindLabelId = useId()
  // Без цели ведут куда-то только «Другое»: тизер, монтаж и версия без объекта — тупик.
  const kinds = target
    ? UploadKindSchema.options
    : UploadKindSchema.options.filter((option) => !uploadKindNeedsTarget(option))

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Загрузить</DialogTitle>
        <DialogDescription className="sr-only">Вид файла, цель и сами файлы</DialogDescription>
      </DialogHeader>

      <section className="flex flex-col gap-2">
        <h3 id={kindLabelId} className="text-ink-3 text-sm">
          Что это
        </h3>
        <Controller
          control={form.control}
          name="kind"
          render={({ field }) => (
            <ChoiceChips
              labelledBy={kindLabelId}
              value={field.value}
              onChange={field.onChange}
              choices={kinds.map((option) => ({ value: option, label: UPLOAD_KIND_LABEL[option] }))}
            />
          )}
        />
        {target ? null : (
          <p className="text-ink-3 text-sm">Чтобы загрузить тизер или монтаж, откройте объект</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Куда</h3>
        <TargetLine
          target={uploadKindNeedsTarget(kind) ? target : null}
          kindIsOther={kind === 'other'}
        />
      </section>

      <Controller
        control={form.control}
        name="files"
        render={({ field, fieldState }) => (
          <FilePicker
            files={field.value}
            onFilesChange={field.onChange}
            error={fieldState.error?.message}
          />
        )}
      />

      <DialogFooter className="items-end">
        <div className="mr-auto min-h-5 text-ink-3 text-sm">
          {missingTarget ? 'Нет цели: откройте объект или строку плана' : null}
        </div>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        <Button type="submit" disabled={missingTarget || files.length === 0}>
          <UploadIcon />
          Загрузить
        </Button>
      </DialogFooter>
    </form>
  )
}
