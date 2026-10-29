import {
  type ConnectIntegrationCommand,
  ConnectIntegrationCommandSchema,
  type IntegrationView,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

type ConnectField = 'hub_page' | 'key'

/** Одно поле: Hub ждёт код страницы, Fyper — ключ; проверка та же, что у команды. */
const ConnectFormSchema = z.object({ value: z.string() })
type ConnectFormValues = z.infer<typeof ConnectFormSchema>

const FIELD_LABEL: Record<ConnectField, { label: string; placeholder: string }> = {
  hub_page: { label: 'Код страницы в Hub', placeholder: 'ari-2' },
  key: { label: 'Ключ доступа', placeholder: 'ключ из кабинета Fyper' },
}

interface ConnectFormProps {
  integration: IntegrationView
  field: ConnectField
  /** «Hub для Fansly 2 Ари», «Fyper» — для полоски после подключения. */
  subject: string
  onDone: () => void
}

/** «Настроить»: одно поле под строкой интеграции и «Подключить» (§3.11, §4.19). */
export function ConnectForm({ integration, field, subject, onDone }: ConnectFormProps) {
  const api = useApi()
  const toast = useActionToast()
  const inputId = useId()
  const form = useForm<ConnectFormValues>({
    resolver: zodResolver(
      ConnectFormSchema.superRefine(({ value }, context) => {
        const checked = ConnectIntegrationCommandSchema.shape[field].unwrap().safeParse(value)
        if (!checked.success) {
          context.addIssue({
            code: 'custom',
            path: ['value'],
            message: checked.error.issues[0]?.message,
          })
        }
      }),
    ),
    defaultValues: { value: '' },
  })
  const connect = useIntentMutation<ConnectIntegrationCommand, unknown>({
    failed: 'Не подключилось',
    run: (body, key) =>
      api.settings.connectIntegration({
        params: { integration: integration.id },
        body,
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.integrations(), queryKeys.models(), queryKeys.counters()],
    onSuccess: () => {
      toast.show({ message: `${subject}: работает` })
      onDone()
    },
  })
  const { label, placeholder } = FIELD_LABEL[field]

  return (
    <form
      onSubmit={form.handleSubmit(({ value }) => connect.start({ [field]: value.trim() }))}
      className="flex items-start gap-3 pb-4"
    >
      <FormField
        htmlFor={inputId}
        label={label}
        error={form.formState.errors.value?.message}
        className="w-72"
      >
        <Input id={inputId} autoFocus placeholder={placeholder} {...form.register('value')} />
      </FormField>
      <div className="flex gap-2 pt-6">
        <Button type="submit" variant="outline" pending={connect.isPending}>
          Подключить
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
