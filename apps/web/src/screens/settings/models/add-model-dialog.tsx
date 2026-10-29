import { type AddModelCommand, AddModelCommandSchema, type Model } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

interface AddModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «Добавить модель»: имя и код; страницы добавляются следом в её разделе. */
export function AddModelDialog({ open, onOpenChange }: AddModelDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {open ? <AddModelForm onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function AddModelForm({ onClose }: { onClose: () => void }) {
  const api = useApi()
  const toast = useActionToast()
  const nameId = useId()
  const codeId = useId()
  const form = useForm<AddModelCommand>({
    resolver: zodResolver(AddModelCommandSchema),
    defaultValues: { name: '', code: '' },
  })
  const add = useIntentMutation<AddModelCommand, Model>({
    failed: 'Модель не добавлена',
    run: (body, key) => api.settings.addModel({ body, idempotencyKey: key }),
    invalidates: () => [queryKeys.models(), queryKeys.session(), queryKeys.integrations()],
    onSuccess: (model) => {
      onClose()
      toast.show({ message: `Модель добавлена · ${model.name}` })
    },
  })
  const { errors } = form.formState
  return (
    <form onSubmit={form.handleSubmit((body) => add.start(body))} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Добавить модель</DialogTitle>
        <DialogDescription className="sr-only">Имя и код модели</DialogDescription>
      </DialogHeader>
      <FormField htmlFor={nameId} label="Имя" error={errors.name?.message}>
        <Input id={nameId} autoFocus {...form.register('name')} />
      </FormField>
      <FormField
        htmlFor={codeId}
        label="Код"
        hint="Латиница строчными: lora — в адресах и именах файлов"
        error={errors.code ? 'Латиница строчными, цифры и дефис' : undefined}
      >
        <Input id={codeId} autoComplete="off" {...form.register('code')} />
      </FormField>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" pending={add.isPending}>
          Добавить
        </Button>
      </DialogFooter>
    </form>
  )
}
