import { formatNumber, type Model, type ModelCounters, plural } from '@contentops/contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { cn } from '@contentops/ui/lib/utils'
import { useRouter } from '@tanstack/react-router'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { useCounters } from '@/data/counters'
import { modelSwitchHref } from '../model/model-switch-path'
import { ModelAvatar } from './model-avatar'

interface ModelSwitcherProps {
  model: Model
  models: readonly Model[]
  collapsed: boolean
}

function pagesLabel(model: Model): string {
  const count = model.accounts.length
  return `${formatNumber(count)} ${plural(count, ['страница', 'страницы', 'страниц'])}`
}

/** «Приехало 9 · План 5»: только ненулевые числа модели. */
function countersLabel(counters: ModelCounters | undefined): string {
  if (!counters) {
    return ''
  }
  const parts: string[] = []
  if (counters.inbox > 0) {
    parts.push(`Приехало ${formatNumber(counters.inbox)}`)
  }
  if (counters.plan > 0) {
    parts.push(`План ${formatNumber(counters.plan)}`)
  }
  return parts.join(' · ')
}

/**
 * Переключатель модели (DESIGN §2.2): аватар, имя, «5 страниц». В меню — модели с правами
 * и их числа; точка на аватаре, если у другой модели есть ◆ или ▲. Смена модели ведёт в
 * тот же раздел выбранной модели; с объекта, заказа или случая — в корень раздела.
 */
export function ModelSwitcher({ model, models, collapsed }: ModelSwitcherProps) {
  const counters = useCounters().data?.models
  const router = useRouter()
  const switchTo = (code: string) => {
    const { pathname, search } = router.state.location
    void router.navigate({ href: modelSwitchHref(pathname, search, code) })
  }
  const countersOf = (code: string) => counters?.find((entry) => entry.model === code)
  const otherAttention = models.some(
    (candidate) => candidate.code !== model.code && countersOf(candidate.code)?.attention,
  )
  const single = models.length <= 1

  const face = (
    <>
      <ModelAvatar code={model.code} name={model.name} attention={otherAttention} />
      {collapsed ? null : (
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate font-semibold text-base">{model.name}</span>
          <span className="truncate text-ink-3 text-sm">{pagesLabel(model)}</span>
        </span>
      )}
      {collapsed || single ? null : <ChevronDownIcon className="size-4.5 shrink-0 text-ink-3" />}
    </>
  )
  const faceClass = cn(
    'flex h-14 w-full items-center gap-3 rounded-xl px-2 transition-colors duration-120',
    collapsed && 'justify-center px-0',
  )

  if (single) {
    return <div className={faceClass}>{face}</div>
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Модель: ${model.name}`}
        className={cn(faceClass, 'hover:bg-sidebar-accent/60 aria-expanded:bg-sidebar-accent')}
      >
        {face}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-68">
        {models.map((candidate) => {
          const numbers = countersLabel(countersOf(candidate.code))
          return (
            <DropdownMenuItem key={candidate.code} onSelect={() => switchTo(candidate.code)}>
              <ModelAvatar
                code={candidate.code}
                name={candidate.name}
                size="small"
                attention={candidate.code !== model.code && countersOf(candidate.code)?.attention}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{candidate.name}</span>
                {numbers ? (
                  <span className="truncate text-ink-3 text-sm tabular-nums">{numbers}</span>
                ) : null}
              </span>
              {candidate.code === model.code ? <CheckIcon className="text-primary" /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
