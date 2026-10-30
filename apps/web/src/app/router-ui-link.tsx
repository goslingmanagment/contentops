import type { UiLinkProps } from '@contentops/ui/components/ui-link'
import { useRouter } from '@tanstack/react-router'
import type { MouseEvent } from 'react'
import { routerHrefOf } from './router-href'

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/**
 * Ссылка дизайн-системы поверх маршрутизатора: обычный `<a href>` для нового окна и
 * средней кнопки, переход без перезагрузки — для простого нажатия по внутренней ссылке
 * (путь от корня или тот же origin — `routerHrefOf`).
 */
export function RouterUiLink({ href, onClick, target, ...props }: UiLinkProps) {
  const router = useRouter()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !isPlainLeftClick(event) || target) {
      return
    }
    const internal = routerHrefOf(href, window.location.href)
    if (internal === null) {
      return
    }
    event.preventDefault()
    void router.navigate({ href: internal })
  }
  return <a {...props} href={href} target={target} onClick={handleClick} />
}
