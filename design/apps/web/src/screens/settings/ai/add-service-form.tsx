import {
  type AddAiServiceCommand,
  AddAiServiceCommandSchema,
  AI_TASK_LABEL,
  type AiSettings,
  AiTaskSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
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

/** Галочка согласия в форме пустая, пока её не поставили; команда требует `true`. */
const ServiceFormSchema = AddAiServiceCommandSchema.extend({ consent: z.boolean() }).refine(
  (form) => form.consent,
  { path: ['consent'], message: 'Без согласия сервис ничего не получит' },
)
type ServiceForm = z.infer<typeof ServiceFormSchema>

interface AddServiceFormProps {
  /** Первый сервис подключает ИИ целиком: раздел появляется в списке слева. */
  first?: boolean
  onDone?: () => void
}

/** Сервис: название, что он делает, согласие отправлять ему кадры и описания. */
export function AddServiceForm({ first = false, onDone }: AddServiceFormProps) {
  const api = useApi()
  const toast = useActionToast()
  const nameId = useId()
  const consentId = useId()
  const form = useForm<ServiceForm>({
    resolver: zodResolver(ServiceFormSchema),
    defaultValues: { name: '', tasks: ['markup'], consent: false },
  })
  const add = useIntentMutation<AddAiServiceCommand, AiSettings>({
    failed: 'Сервис не подключён',
    run: (body, key) => api.settings.addAiService({ body, idempotencyKey: key }),
    invalidates: () => [queryKeys.aiSettings(), queryKeys.integrations()],
    onSuccess: (_, body) => {
      toast.show({ message: `Подключено · ${body.name}` })
      onDone?.()
    },
  })
  const { errors } = form.formState

  return (
    <form
      onSubmit={form.handleSubmit((values) => add.start({ ...values, consent: true }))}
      className="flex flex-col gap-4 py-4"
    >
      <FormField htmlFor={nameId} label="Название" error={errors.name?.message} className="w-80">
        <Input id={nameId} autoFocus={!first} {...form.register('name')} />
      </FormField>
      <Controller
        control={form.control}
        name="tasks"
        render={({ field, fieldState }) => (
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2 text-ink-3 text-sm">Что делает</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {AiTaskSchema.options.map((task) => {
                const id = `${nameId}-${task}`
                return (
                  <label key={task} htmlFor={id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={field.value.includes(task)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked === true
                            ? [...field.value, task]
                            : field.value.filter((item) => item !== task),
                        )
                      }
                    />
                    {AI_TASK_LABEL[task]}
                  </label>
                )
              })}
            </div>
            <p className="min-h-4 text-destructive text-xs">{fieldState.error?.message}</p>
          </fieldset>
        )}
      />
      <Controller
        control={form.control}
        name="consent"
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-1">
            <label htmlFor={consentId} className="flex items-center gap-2">
              <Checkbox
                id={consentId}
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
              Согласен отправлять этому сервису кадры и описания
            </label>
            <p className="min-h-4 text-destructive text-xs">{fieldState.error?.message}</p>
          </div>
        )}
      />
      <div className="flex gap-2">
        <Button type="submit" variant={first ? 'default' : 'outline'} pending={add.isPending}>
          Подключить
        </Button>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Отмена
          </Button>
        ) : null}
      </div>
    </form>
  )
}
