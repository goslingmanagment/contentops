import {
  type AddContractorCommand,
  AddContractorCommandSchema,
  CONTRACTOR_FORMAT_LABEL,
  type Contractor,
  ContractorFormatSchema,
  type Model,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { usePromoChannels } from '@/data/promo'
import { queryKeys } from '@/data/query-keys'

interface AddContractorDialogProps {
  model: Model
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «Добавить подрядчика»: имя, канал, контакт и формат файлов для следующей передачи. */
export function AddContractorDialog({ model, open, onOpenChange }: AddContractorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-120">
        {open ? <AddContractorForm model={model} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

const ANY_CHANNEL = '—'

/** Форма хранит пустые строки, команда — `null`. */
const ContractorFormSchema = AddContractorCommandSchema.extend({
  channel: z.string(),
  contact: z.string().trim(),
})
type ContractorForm = z.infer<typeof ContractorFormSchema>

function AddContractorForm({ model, onClose }: { model: Model; onClose: () => void }) {
  const api = useApi()
  const toast = useActionToast()
  const channels = usePromoChannels(model.code).data ?? []
  const ids = { name: useId(), channel: useId(), contact: useId(), format: useId() }
  const form = useForm<ContractorForm>({
    resolver: zodResolver(ContractorFormSchema),
    defaultValues: { name: '', channel: ANY_CHANNEL, contact: '', format: 'upload' },
  })
  const add = useIntentMutation<AddContractorCommand, Contractor>({
    failed: 'Подрядчик не добавлен',
    run: (body, key) =>
      api.settings.addContractor({ params: { model: model.code }, body, idempotencyKey: key }),
    invalidates: () => [queryKeys.promoContractors(model.code)],
    onSuccess: (contractor) => {
      onClose()
      toast.show({ message: `Подрядчик добавлен · ${contractor.name}` })
    },
  })
  const submit = (values: ContractorForm) =>
    add.start({
      ...values,
      channel: values.channel === ANY_CHANNEL ? null : values.channel,
      contact: values.contact || null,
    })
  const { errors } = form.formState
  return (
    <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Новый подрядчик · {model.name}</DialogTitle>
        <DialogDescription className="sr-only">Имя, канал, контакт и формат</DialogDescription>
      </DialogHeader>
      <FormField htmlFor={ids.name} label="Имя" error={errors.name?.message}>
        <Input id={ids.name} autoFocus placeholder="GaranTTeam Social" {...form.register('name')} />
      </FormField>
      <div className="grid grid-cols-2 gap-x-3">
        <FormField htmlFor={ids.channel} label="Канал">
          <Controller
            control={form.control}
            name="channel"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={ids.channel} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_CHANNEL}>любой</SelectItem>
                  {channels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>
        <FormField htmlFor={ids.format} label="Формат файлов">
          <Controller
            control={form.control}
            name="format"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={ids.format} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ContractorFormatSchema.options.map((format) => (
                    <SelectItem key={format} value={format}>
                      {CONTRACTOR_FORMAT_LABEL[format]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>
      </div>
      <FormField htmlFor={ids.contact} label="Контакт" hint="Telegram или почта — по желанию">
        <Input id={ids.contact} autoComplete="off" {...form.register('contact')} />
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
