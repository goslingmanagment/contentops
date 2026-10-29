import { type ComponentProps, type ComponentType, createContext, useContext } from 'react'

/**
 * Ссылка дизайн-системы. Компоненты не знают о маршрутизаторе: приложение подставляет
 * свою ссылку (например, `Link` из TanStack Router) через `LinkComponentProvider`.
 * Без провайдера рисуется обычный `<a href>`, чего хватает для hash-адресов прототипа.
 */
export type UiLinkProps = Omit<ComponentProps<'a'>, 'href'> & { href: string }

const LinkComponentContext = createContext<ComponentType<UiLinkProps> | null>(null)

export const LinkComponentProvider = LinkComponentContext.Provider

export function UiLink(props: UiLinkProps) {
  const LinkComponent = useContext(LinkComponentContext)
  if (LinkComponent) {
    return <LinkComponent {...props} />
  }
  return <a {...props} />
}
