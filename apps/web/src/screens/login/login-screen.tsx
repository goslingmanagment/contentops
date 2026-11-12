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
import { HUB_REFUSAL, hubSignInHref, signInFailure, useHubSignIn, useSignIn } from './use-sign-in'

const routeApi = getRouteApi('/login')

function LoginCard({ titleId, children }: { titleId: string; children: ReactNode }) {
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
 * Вход `/login` (DESIGN §4.21, §3.10): страница без колонки, по центру белая карточка
 * 400 — «Логин», «Пароль», «Войти». После входа — тот же адрес, откуда пришли. На публичном
 * имени, где настроен хаб, первым идёт «Войти через хаб» (SPEC §11.1), пароль — ниже.
 */
export function LoginScreen() {
  const { from, hub } = routeApi.useSearch()
  const router = useRouter()
  const loginId = useId()
  const passwordId = useId()
  const { offered: hubOffered, known: methodsKnown } = useHubSignIn()
  const form = useForm<SignInCommand>({
    resolver: zodResolver(SignInCommandSchema),
    defaultValues: { login: '', password: '' },
  })
  const signIn = useSignIn(() => void router.navigate({ href: from ?? '/', replace: true }))
  const { errors } = form.formState
  // Курсор в «Логин», только когда пароль — главный способ: хаба на этом адресе нет.
  const { setFocus } = form
  useEffect(() => {
    if (methodsKnown && !hubOffered && hub !== 'no_access') setFocus('login')
  }, [methodsKnown, hubOffered, hub, setFocus])

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
          Войти по паролю
        </Link>
      </LoginCard>
    )
  }

  return (
    <LoginCard titleId={`${loginId}-title`}>
      {hubOffered ? (
        <div className="flex flex-col gap-1">
          <Button asChild size="lg" className="w-full">
            <a href={hubSignInHref(from)}>Войти через хаб</a>
          </Button>
          {hub ? (
            <p role="alert" className="flex min-h-6 items-center gap-2 text-base text-destructive">
              <StatusSign kind="trouble" />
              {HUB_REFUSAL[hub]}
            </p>
          ) : null}
          <p className="mt-4 text-center text-base text-muted-foreground">или по паролю</p>
        </div>
      ) : null}
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
          ) : null}
        </p>
        <Button
          type="submit"
          size="lg"
          variant={hubOffered ? 'outline' : 'default'}
          className="mt-2 w-full"
          pending={signIn.isPending}
        >
          Войти
        </Button>
      </form>
    </LoginCard>
  )
}
