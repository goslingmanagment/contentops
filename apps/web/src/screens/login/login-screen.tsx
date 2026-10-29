import { type SignInCommand, SignInCommandSchema } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { zodResolver } from '@hookform/resolvers/zod'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { Logo } from '@/shell/top-bar/logo'
import { signInFailure, useSignIn } from './use-sign-in'

const routeApi = getRouteApi('/login')

/**
 * Вход `#/login` (DESIGN §4.21, §3.10): страница без колонки, по центру белая карточка
 * 400 — «Логин», «Пароль», «Войти». После входа — тот же адрес, откуда пришли.
 */
export function LoginScreen() {
  const { from } = routeApi.useSearch()
  const router = useRouter()
  const loginId = useId()
  const passwordId = useId()
  const form = useForm<SignInCommand>({
    resolver: zodResolver(SignInCommandSchema),
    defaultValues: { login: '', password: '' },
  })
  const signIn = useSignIn(() => void router.navigate({ href: from ?? '/', replace: true }))
  const { errors } = form.formState

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar p-6">
      <section
        aria-labelledby={`${loginId}-title`}
        className="flex w-100 flex-col gap-6 rounded-3xl bg-background px-8 pt-7 pb-8"
      >
        <header className="-mx-5 flex flex-col">
          <Logo />
          <h1 id={`${loginId}-title`} className="sr-only">
            Вход в ContentOps
          </h1>
        </header>
        <form
          noValidate
          onSubmit={form.handleSubmit((body) => signIn.mutate(body))}
          className="flex flex-col gap-1"
        >
          <FormField htmlFor={loginId} label="Логин" error={errors.login?.message}>
            <Input
              id={loginId}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              aria-invalid={errors.login !== undefined}
              {...form.register('login')}
            />
          </FormField>
          <FormField htmlFor={passwordId} label="Пароль" error={errors.password?.message}>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.password !== undefined}
              {...form.register('password')}
            />
          </FormField>
          <p role="alert" className="flex min-h-6 items-center gap-2 text-base text-destructive">
            {signIn.isError ? (
              <>
                <StatusSign kind="trouble" />
                {signInFailure(signIn.error)}
              </>
            ) : null}
          </p>
          <Button type="submit" size="lg" className="mt-2 w-full" pending={signIn.isPending}>
            Войти
          </Button>
        </form>
      </section>
    </main>
  )
}
