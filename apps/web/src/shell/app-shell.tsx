import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { Outlet, useLocation } from '@tanstack/react-router'
import { MenuIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useRole } from '@/data/session'
import { useMediaQuery } from '@/lib/use-media-query'
import { MakePpvDialogProvider } from './dialogs/make-ppv-dialog-provider'
import { NewOrderDialogProvider } from './dialogs/order-dialog-provider'
import { PlanDialogProvider } from './dialogs/plan-dialog-provider'
import { Sidebar } from './sidebar/sidebar'
import { ProductSwitcher } from './top-bar/product-switcher'
import { TopBar } from './top-bar/top-bar'
import { UploadProvider } from './upload/upload-provider'

/**
 * Оболочка (DESIGN §2, §3.1): серый холст, колонка 240 (224 при окне 1280, значки уже
 * 1100), верхняя полоса 64 и белое поле с радиусом 16, которое отстоит от краёв на 12.
 * Экран рисуется внутри поля; колонка не прокручивается. На телефоне (уже 768) колонка
 * прячется за одной кнопкой «Меню» и открывается поверх поля (план продуктов §2.4).
 */
export function AppShell() {
  const phone = useMediaQuery('(max-width: 767px)')
  const collapsed = useMediaQuery('(max-width: 1099px)') && !phone
  const role = useRole()
  const fieldRef = useRef<HTMLElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = useLocation({ select: (location) => location.pathname })
  // Переход по пункту меню закрывает его.
  useEffect(() => {
    if (pathname) setMenuOpen(false)
  }, [pathname])

  return (
    <UploadProvider enabled={role !== null && role !== 'reader' && role !== 'customs'}>
      <PlanDialogProvider>
        <NewOrderDialogProvider>
          <MakePpvDialogProvider>
            <div
              className={cn(
                'grid h-dvh min-w-0 overflow-hidden bg-sidebar text-sidebar-foreground',
                phone
                  ? 'grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)]'
                  : collapsed
                    ? 'grid-cols-[72px_minmax(0,1fr)] grid-rows-[64px_minmax(0,1fr)]'
                    : 'grid-cols-[224px_minmax(0,1fr)] grid-rows-[64px_minmax(0,1fr)] min-[1320px]:grid-cols-[240px_minmax(0,1fr)]',
              )}
            >
              <button
                type="button"
                onClick={() => fieldRef.current?.focus()}
                className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:shadow-md"
              >
                К содержимому
              </button>
              {phone ? (
                <header className="flex h-14 min-w-0 items-center gap-1 px-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Меню"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                  >
                    {menuOpen ? <XIcon /> : <MenuIcon />}
                  </Button>
                  <ProductSwitcher />
                </header>
              ) : (
                <>
                  <ProductSwitcher compact={collapsed} />
                  <TopBar />
                  <Sidebar collapsed={collapsed} />
                </>
              )}
              <main
                ref={fieldRef}
                tabIndex={-1}
                aria-label="Рабочее поле"
                className={cn(
                  'min-h-0 min-w-0 overflow-hidden bg-background text-foreground outline-none',
                  phone ? 'mx-2 mb-2 rounded-2xl' : 'mr-3 mb-3 ml-3 rounded-3xl',
                )}
              >
                <Outlet />
              </main>
              {phone && menuOpen ? (
                <div className="fixed inset-x-0 top-14 bottom-0 z-40 flex">
                  <div className="flex w-72 max-w-[85vw] flex-col bg-sidebar pt-2 shadow-xl [&>aside]:flex-1">
                    <Sidebar collapsed={false} />
                  </div>
                  <button
                    type="button"
                    aria-label="Закрыть меню"
                    className="flex-1 bg-foreground/25"
                    onClick={() => setMenuOpen(false)}
                  />
                </div>
              ) : null}
            </div>
          </MakePpvDialogProvider>
        </NewOrderDialogProvider>
      </PlanDialogProvider>
    </UploadProvider>
  )
}
