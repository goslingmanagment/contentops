import { cn } from '@contentops/ui/lib/utils'
import { Outlet } from '@tanstack/react-router'
import { useRef } from 'react'
import { useRole } from '@/data/session'
import { useMediaQuery } from '@/lib/use-media-query'
import { MakePpvDialogProvider } from './dialogs/make-ppv-dialog-provider'
import { NewOrderDialogProvider } from './dialogs/order-dialog-provider'
import { PlanDialogProvider } from './dialogs/plan-dialog-provider'
import { Sidebar } from './sidebar/sidebar'
import { Logo } from './top-bar/logo'
import { TopBar } from './top-bar/top-bar'
import { UploadProvider } from './upload/upload-provider'

/**
 * Оболочка (DESIGN §2, §3.1): серый холст, колонка 240 (224 при окне 1280, значки уже
 * 1100), верхняя полоса 64 и белое поле с радиусом 16, которое отстоит от краёв на 12.
 * Экран рисуется внутри поля; колонка не прокручивается.
 */
export function AppShell() {
  const collapsed = useMediaQuery('(max-width: 1099px)')
  const role = useRole()
  const fieldRef = useRef<HTMLElement>(null)

  return (
    <UploadProvider enabled={role !== null && role !== 'reader'}>
      <PlanDialogProvider>
        <NewOrderDialogProvider>
          <MakePpvDialogProvider>
            <div
              className={cn(
                'grid h-dvh min-w-0 grid-rows-[64px_minmax(0,1fr)] overflow-hidden bg-sidebar text-sidebar-foreground',
                collapsed
                  ? 'grid-cols-[72px_minmax(0,1fr)]'
                  : 'grid-cols-[224px_minmax(0,1fr)] min-[1320px]:grid-cols-[240px_minmax(0,1fr)]',
              )}
            >
              <button
                type="button"
                onClick={() => fieldRef.current?.focus()}
                className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:shadow-md"
              >
                К содержимому
              </button>
              <Logo compact={collapsed} />
              <TopBar />
              <Sidebar collapsed={collapsed} />
              <main
                ref={fieldRef}
                tabIndex={-1}
                aria-label="Рабочее поле"
                className="mr-3 mb-3 ml-3 min-h-0 min-w-0 overflow-hidden rounded-3xl bg-background text-foreground outline-none"
              >
                <Outlet />
              </main>
            </div>
          </MakePpvDialogProvider>
        </NewOrderDialogProvider>
      </PlanDialogProvider>
    </UploadProvider>
  )
}
