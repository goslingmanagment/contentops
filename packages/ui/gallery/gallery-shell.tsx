import { cn } from 'cn'
import type { ComponentType } from 'react'
import { TooltipProvider } from '../src/components/tooltip'
import { BarsPage } from './pages/bars-page'
import { ControlsPage } from './pages/controls-page'
import { CoversPage } from './pages/covers-page'
import { FoldersPage } from './pages/folders-page'
import { MenusPage } from './pages/menus-page'
import { RecordsPage } from './pages/records-page'
import { ShellPage } from './pages/shell-page'
import { StatusPage } from './pages/status-page'
import { TilesPage } from './pages/tiles-page'
import { ViewerPage } from './pages/viewer-page'
import { useHashRoute } from './use-hash-route'

interface GalleryPage {
  path: string
  title: string
  Page: ComponentType
  /** Страница рисует оболочку сама, без полосы галереи. */
  fullscreen?: boolean
}

const pages: readonly GalleryPage[] = [
  { path: '/', title: 'Оболочка', Page: ShellPage, fullscreen: true },
  { path: '/controls', title: 'Управление', Page: ControlsPage },
  { path: '/status', title: 'Состояния', Page: StatusPage },
  { path: '/tiles', title: 'Плитки', Page: TilesPage },
  { path: '/bars', title: 'Полосы', Page: BarsPage },
  { path: '/menus', title: 'Меню', Page: MenusPage },
  { path: '/covers', title: 'Обложки', Page: CoversPage },
  { path: '/folders', title: 'Папки', Page: FoldersPage },
  { path: '/records', title: 'Журнал и настройки', Page: RecordsPage },
  { path: '/viewer', title: 'Просмотр', Page: ViewerPage, fullscreen: true },
]

export function GalleryShell() {
  const route = useHashRoute()
  const skin = route.includes('skin=focus') ? 'focus' : undefined
  const onCanvas = route.includes('bg=canvas')
  const path = route.split('?')[0] ?? '/'
  const current = pages.find((page) => page.path === path) ?? pages[0]
  if (!current) {
    return null
  }
  const { Page } = current
  if (current.fullscreen) {
    return (
      <TooltipProvider>
        <div data-skin={skin}>
          <Page />
        </div>
      </TooltipProvider>
    )
  }
  return (
    <TooltipProvider>
      <div data-skin={skin} className="min-h-dvh bg-sidebar">
        <nav className="flex h-16 items-center gap-1 px-6">
          <span className="mr-6 text-md">ContentOps · дизайн-система</span>
          {pages.map((page) => (
            <a
              key={page.path}
              href={`#${page.path}`}
              className={cn(
                'rounded-lg px-3 py-2 text-base transition-colors duration-120 hover:bg-background',
                page === current && 'bg-background font-semibold',
              )}
            >
              {page.title}
            </a>
          ))}
        </nav>
        <main className="flex flex-col gap-3 px-3 pb-3">
          <p className="px-4 text-ink-3 text-sm">
            <a
              className="underline-offset-4 hover:underline"
              href={`#${current.path}${onCanvas ? '' : '?bg=canvas'}`}
            >
              {onCanvas ? 'На белом поле' : 'На сером холсте'}
            </a>
            {' · '}
            <a
              className="underline-offset-4 hover:underline"
              href={`#${current.path}${skin ? '' : '?skin=focus'}`}
            >
              {skin ? 'Основной вид' : 'Вид «Фокус»'}
            </a>
          </p>
          <Page />
        </main>
      </div>
    </TooltipProvider>
  )
}
