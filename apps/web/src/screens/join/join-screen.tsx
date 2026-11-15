import { JoinCommandSchema } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { LoginCard } from '../login/login-screen'
import { signInFailure, useJoin } from '../login/use-sign-in'

const FormSchema = z
  .object({ password: JoinCommandSchema.shape.password, again: z.string() })
  .refine((value) => value.password === value.again, {
    message: 'Пароли не совпадают',
    path: ['again'],
  })
type FormValues = z.infer<typeof FormSchema>

/** Секрет ссылки — в её `#`: в адрес и журналы сервера он не попадает; после чтения стирается из строки. */
function takeToken(): string {
  const token = decodeURIComponent(window.location.hash.replace(/^#/, ''))
  if (token) window.history.replaceState(null, '', window.location.pathname)
  return token
}

/**
 * «Придумайте пароль» `/join#…` (пакет C4): приглашение контент-менеджера кончается в ContentOps. Пароль задаётся
 * в реестре Hub (через сервер ContentOps), человек входит и попадает на «Сегодня» с карточкой «Первый день».
 */
export function JoinScreen() {
  const router = useRouter()
  const passwordId = useId()
  const againId = useId()
  const [token] = useState(takeToken)
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { password: '', again: '' },
  })
  const join = useJoin(() => void router.navigate({ href: '/', replace: true }))
  const { errors } = form.formState
  const { setFocus } = form
  useEffect(() => {
    if (token) setFocus('password')
  }, [token, setFocus])

  if (!token) {
    return (
      <LoginCard titleId={`${passwordId}-title`}>
        <p role="alert" className="text-md">
          В ссылке нет приглашения. Откройте ссылку целиком, как её прислали, или попросите у
          владельца новую.
        </p>
      </LoginCard>
    )
  }
  return (
    <LoginCard titleId={`${passwordId}-title`}>
      <form
        noValidate
        onSubmit={form.handleSubmit(({ password }) => join.mutate({ token, password }))}
        className="flex flex-col gap-1"
      >
        <h2 className="pb-2 font-medium text-lg">Придумайте пароль</h2>
        <FormField htmlFor={passwordId} label="Пароль" error={errors.password?.message}>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password !== undefined}
            {...form.register('password')}
          />
        </FormField>
        <FormField htmlFor={againId} label="Ещё раз" error={errors.again?.message}>
          <Input
            id={againId}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.again !== undefined}
            {...form.register('again')}
          />
        </FormField>
        <p role="alert" className="flex min-h-6 items-center gap-2 text-base text-destructive">
          {join.isError ? (
            <>
              <StatusSign kind="trouble" />
              {signInFailure(join.error)}
            </>
          ) : null}
        </p>
        <Button type="submit" size="lg" className="mt-2 w-full" pending={join.isPending}>
          Сохранить и войти
        </Button>
        <p className="mt-3 text-muted-foreground text-sm">
          Пароль не короче 12 знаков. Логин — тот, что в сообщении с этой ссылкой.
        </p>
      </form>
    </LoginCard>
  )
}
