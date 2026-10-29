import { Skeleton } from '@contentops/ui/components/skeleton'
import { cn } from '@contentops/ui/lib/utils'
import { useRole } from '@/data/session'
import { useShellModel } from '../model/use-shell-model'
import { ModelSwitcher } from './model-switcher'
import { SectionNav } from './section-nav'
import { SpaceCardSlot } from './space-card-slot'
import { UploadButton } from './upload-button'

/**
 * Левая колонка на холсте (DESIGN §2.2): модель, «Загрузить», четыре раздела и карточка
 * места внизу. Колонка не прокручивается: всё вместе меньше 400 px при любом окне.
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { model, models } = useShellModel()
  const role = useRole()
  return (
    <aside
      aria-label="Колонка"
      className={cn('flex min-h-0 flex-col overflow-hidden pb-3', collapsed ? 'px-2' : 'px-3')}
    >
      {model ? (
        <ModelSwitcher model={model} models={models} collapsed={collapsed} />
      ) : (
        <div className="flex h-14 items-center gap-3 px-2">
          <Skeleton className="size-9 rounded-full" />
          {collapsed ? null : <Skeleton className="h-4 w-24 rounded-sm" />}
        </div>
      )}
      {role === 'reader' ? (
        <div className="h-3" />
      ) : (
        <div className="h-16 pt-2">{role ? <UploadButton collapsed={collapsed} /> : null}</div>
      )}
      {model ? <SectionNav model={model} collapsed={collapsed} /> : null}
      <div className="mt-auto">{collapsed ? null : <SpaceCardSlot />}</div>
    </aside>
  )
}
