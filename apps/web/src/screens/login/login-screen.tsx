import { type SignInCommand, SignInCommandSchema } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FormField } from '@contentops/ui/components/form-field'
import { Input } from '@contentops/ui/components/input'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { zodResolver } from '@hookform/resolvers/zod'
import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useId } from 'react'
import { useForm } from 'react-hook-form'
import { Logo } from '@/shell/top-bar/logo'
import { HUB_REFUSAL, hubSignInHref, isOwnerRefusal, signInFailure, useSignIn } from './use-sign-in'

const routeApi = getRouteApi('/login')

export function LoginCard({ titleId, children }: { titleId: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar p-6">
      <section
        aria-labelledby={titleId}
        className="flex w-100 flex-col gap-6 rounded-3xl bg-background px-8 pt-7 pb-8"
      >
        <header className="-mx-5 flex flex-col">
          <Logo />
          <h1 id={titleId} className="sr-only">
            Вход в ContentOps
          </h1>
        </header>
        {children}
      </section>
    </main>
  )
}

/**
 * Вход `/login` (DESIGN §4.21, §3.10; пакет C4): страница без колонки, по центру белая карточка 400 —
 * «Логин», «Пароль», «Войти» на любом адресе. Сервер спрашивает Hub (один реестр, одна учётная запись), потом
 * учётную запись самого ContentOps. Кто уже вошёл в Hub, входит без формы (молчаливая попытка). Владелец входит
 * через Hub: его логин даёт одну кнопку «Войти через Hub», пароль владельца сюда не идёт.
 */
export function LoginScreen() {
  const { from, hub } = routeApi.useSearch()
  const router = useRouter()
  const loginId = useId()
  const passwordId = useId()
  const form = useForm<SignInCommand>({
    resolver: zodResolver(SignInCommandSchema),
    defaultValues: { login: '', password: '' },
  })
  const signIn = useSignIn(() => void router.navigate({ href: from ?? '/', replace: true }))
  const { errors } = form.formState
  const { setFocus, watch } = form
  useEffect(() => {
    if (hub !== 'no_access') setFocus('login')
  }, [hub, setFocus])
  // Изменили логин или пароль: прошлый отказ (и кнопка владельца) больше не про них.
  const { isError, reset } = signIn
  useEffect(() => {
    const subscription = watch(() => {
      if (isError) reset()
    })
    return () => subscription.unsubscribe()
  }, [watch, isError, reset])

  // Хаб знает человека, а в ContentOps его не связали ни с кем: сессии нет.
  if (hub === 'no_access') {
    return (
      <LoginCard titleId={`${loginId}-title`}>
        <p role="alert" className="text-md">
          У вас нет доступа к ContentOps. Попросите владельца
        </p>
        <Link
          to="/login"
          search={{ from }}
          replace
          className="self-start text-base text-primary-ink underline-offset-4 hover:underline"
        >
          Войти по логину и паролю
        </Link>
      </LoginCard>
    )
  }

  const owner = signIn.isError && isOwnerRefusal(signIn.error)
  return (
    <LoginCard titleId={`${loginId}-title`}>
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
          ) : hub ? (
            <>
              <StatusSign kind="trouble" />
              {HUB_REFUSAL[hub]}
            </>
          ) : null}
        </p>
        {owner ? (
          <Button asChild size="lg" className="mt-2 w-full">
            <a href={hubSignInHref(from)}>Войти через Hub</a>
          </Button>
        ) : (
          <Button type="submit" size="lg" className="mt-2 w-full" pending={signIn.isPending}>
            Войти
          </Button>
        )}
        <p className="mt-3 text-muted-foreground text-sm">
          Нет логина или забыли пароль? Попросите у владельца новую ссылку.
        </p>
      </form>
    </LoginCard>
  )
}
