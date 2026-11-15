import { type ChangePasswordCommand, ChangePasswordCommandSchema } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { zodResolver } from '@hookform/resolvers/zod'
import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useSession } from '@/data/session'

/**
 * «Пароль»: форма раскрывается под строкой, после ответа сервера — «Пароль сменён». Владелец, вошедший через Hub,
 * формы не видит: его пароль меняется в Hub и через ContentOps не проходит (пакет C4).
 */
export function PasswordRow() {
  const [open, setOpen] = useState(false)
  const inHub = useSession().data?.password_in_hub
  if (inHub) {
    return (
      <SettingsRow label="Пароль" detail="Пароль владельца меняется в Hub">
        <Button variant="outline" size="sm" asChild>
          <a href={inHub}>Открыть в Hub</a>
        </Button>
      </SettingsRow>
    )
  }
  return (
    <SettingsRow
      label="Пароль"
      detail="••••••••"
      below={open ? <PasswordForm onDone={() => setOpen(false)} /> : null}
    >
      {open ? null : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Сменить
        </Button>
      )}
    </SettingsRow>
  )
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const api = useApi()
  const toast = useActionToast()
  const currentId = useId()
  const nextId = useId()
  const form = useForm<ChangePasswordCommand>({
    resolver: zodResolver(ChangePasswordCommandSchema),
    defaultValues: { current: '', next: '' },
  })
  const change = useIntentMutation<ChangePasswordCommand, unknown>({
    failed: 'Пароль не сменился',
    run: (body, key) => api.settings.changePassword({ body, idempotencyKey: key }),
    onSuccess: () => {
      toast.show({ message: 'Пароль сменён' })
      onDone()
    },
  })
  const { errors } = form.formState

  return (
    <form
      onSubmit={form.handleSubmit((body) => change.start(body))}
      className="flex flex-wrap items-start gap-3 pb-4"
    >
      <FormField
        htmlFor={currentId}
        label="Нынешний пароль"
        error={errors.current?.message}
        className="w-60"
      >
        <Input
          id={currentId}
          type="password"
          autoComplete="current-password"
          autoFocus
          {...form.register('current')}
        />
      </FormField>
      <FormField
        htmlFor={nextId}
        label="Новый пароль"
        hint="Не короче 8 знаков"
        error={errors.next?.message}
        className="w-60"
      >
        <Input id={nextId} type="password" autoComplete="new-password" {...form.register('next')} />
      </FormField>
      <div className="flex gap-2 pt-6">
        <Button type="submit" variant="outline" pending={change.isPending}>
          Сохранить пароль
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
