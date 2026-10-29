import {
  type AddAccountCommand,
  AddAccountCommandSchema,
  type Model,
  type PlatformSchema,
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
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { ChoiceSection } from '../shared/choice-chips'

const PLATFORM_CHOICES = [
  { value: 'fansly', label: 'Fansly' },
  { value: 'onlyfans', label: 'OnlyFans' },
] as const satisfies readonly { value: (typeof PlatformSchema.options)[number]; label: string }[]

interface AddAccountDialogProps {
  model: Model
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «Добавить страницу»: платформа, название, код, ник и код в Hub (если Hub уже знает её). */
export function AddAccountDialog({ model, open, onOpenChange }: AddAccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {open ? <AddAccountForm model={model} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

/** Форма хранит пустую строку, а команда — `null`, когда кода в Hub нет. */
const AccountFormSchema = AddAccountCommandSchema.extend({ hub_page: z.string().trim() })
type AccountForm = z.infer<typeof AccountFormSchema>

function AddAccountForm({ model, onClose }: { model: Model; onClose: () => void }) {
  const api = useApi()
  const toast = useActionToast()
  const ids = { label: useId(), code: useId(), handle: useId(), hub: useId() }
  const form = useForm<AccountForm>({
    resolver: zodResolver(AccountFormSchema),
    defaultValues: {
      platform: 'fansly',
      label: '',
      code: `${model.code}-`,
      handle: '',
      hub_page: '',
    },
  })
  const add = useIntentMutation<AddAccountCommand, Model>({
    failed: 'Страница не добавлена',
    run: (body, key) =>
      api.settings.addAccount({ params: { model: model.code }, body, idempotencyKey: key }),
    invalidates: () => [queryKeys.models(), queryKeys.integrations(), queryKeys.model(model.code)],
    onSuccess: (_, body) => {
      onClose()
      toast.show({ message: `Страница добавлена · ${body.label}` })
    },
  })
  const submit = (values: AccountForm) =>
    add.start({ ...values, hub_page: values.hub_page || null })
  const { errors } = form.formState

  return (
    <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Новая страница · {model.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Платформа, название, код, ник, код в Hub
        </DialogDescription>
      </DialogHeader>
      <Controller
        control={form.control}
        name="platform"
        render={({ field }) => (
          <ChoiceSection
            label="Платформа"
            options={PLATFORM_CHOICES}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />
      <div className="grid grid-cols-2 gap-x-3">
        <FormField htmlFor={ids.label} label="Название" error={errors.label?.message}>
          <Input id={ids.label} placeholder="Fansly 4" autoFocus {...form.register('label')} />
        </FormField>
        <FormField
          htmlFor={ids.code}
          label="Код"
          error={errors.code ? 'Латиница строчными, цифры и дефис' : undefined}
        >
          <Input id={ids.code} autoComplete="off" {...form.register('code')} />
        </FormField>
        <FormField htmlFor={ids.handle} label="Ник на платформе" error={errors.handle?.message}>
          <Input id={ids.handle} autoComplete="off" {...form.register('handle')} />
        </FormField>
        <FormField htmlFor={ids.hub} label="Код в Hub" hint="Пусто — Hub настроите потом">
          <Input id={ids.hub} autoComplete="off" {...form.register('hub_page')} />
        </FormField>
      </div>
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
