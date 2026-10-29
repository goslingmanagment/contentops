import {
  type AnyRouter,
  type RegisteredRouter,
  useRouter,
  type ValidateLinkOptions,
} from '@tanstack/react-router'
import { useCallback } from 'react'

/** Параметры сборки адреса без привязки к реестру: проверка уже прошла у вызова. */
type CheckedLinkOptions = Parameters<AnyRouter['buildLocation']>[0]

/**
 * Готовая строка ссылки для компонентов дизайн-системы, которые берут `href`
 * (`FolderTile`, `NavItem`, крошки). Параметры проверяются по реестру маршрутов, как у
 * `Link` (`ValidateLinkOptions`); `?demo=` и `?as=` подмешиваются сами.
 */
export function useHref() {
  const router = useRouter()
  return useCallback(
    <const TOptions>(options: ValidateLinkOptions<RegisteredRouter, TOptions>): string => {
      // Проверку типов провёл `ValidateLinkOptions` у вызова; сборке нужен только сам объект.
      const checked = options as CheckedLinkOptions
      return router.history.createHref(router.buildLocation(checked).href)
    },
    [router],
  )
}
