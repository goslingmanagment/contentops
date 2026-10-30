import { TooltipProvider } from '@contentops/ui/components/tooltip'
import { LinkComponentProvider } from '@contentops/ui/components/ui-link'
import { getRouteApi, Outlet, useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { ActionToastProvider } from '@/actions/action-toast-provider'
import { ApiProvider } from '@/data/api-provider'
import { RouterUiLink } from './router-ui-link'
import { useSkin } from './use-skin'

const rootRouteApi = getRouteApi('__root__')

/**
 * Корень приложения: сеанс данных, подсказки, ссылки дизайн-системы поверх маршрутизатора и
 * полоска после действия. `?demo=`, `?as=` и `?skin=` работают только в разработке.
 */
export function RootLayout() {
  const { demo, as, skin } = rootRouteApi.useSearch()
  useSkin(import.meta.env.DEV ? skin : undefined)
  const router = useRouter()
  // После входа — тот же адрес целиком: фильтры, вид и вкладка живут в запросе (§3.10).
  const toLogin = useCallback(() => {
    const { pathname, href } = router.state.location
    if (pathname !== '/login') {
      void router.navigate({ to: '/login', search: { from: href } })
    }
  }, [router])

  return (
    <ApiProvider demo={demo ?? null} role={as ?? null} onUnauthenticated={toLogin}>
      <TooltipProvider>
        <LinkComponentProvider value={RouterUiLink}>
          <ActionToastProvider>
            <Outlet />
          </ActionToastProvider>
        </LinkComponentProvider>
      </TooltipProvider>
    </ApiProvider>
  )
}
