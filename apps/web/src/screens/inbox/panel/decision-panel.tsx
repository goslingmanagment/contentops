import type { InboxGroup } from '@contentops/contracts'
import type { ReactNode } from 'react'
import { DraftPanel, type DraftPanelProps } from './draft-panel'
import { MultiPanel } from './multi-panel'

interface DecisionPanelProps extends Omit<DraftPanelProps, 'group'> {
  /** Одна выбранная группа — её решение; несколько — пакет. */
  current: InboxGroup | null
  selected: readonly InboxGroup[]
}

/**
 * Панель решения (DESIGN §3.1, §4.8): 400 справа (320 на окне 1280), открыта всегда,
 * не всплывает поверх, а сужает плитки; выбранная плитка остаётся в кадре.
 */
export function DecisionPanel({ current, selected, ...props }: DecisionPanelProps) {
  let content: ReactNode = null
  if (current) {
    content = <DraftPanel key={current.id} group={current} {...props} />
  } else if (selected.length > 1) {
    content = (
      <MultiPanel groups={selected} actions={props.actions} channelName={props.channelName} />
    )
  }
  return (
    <aside
      aria-label="Решение"
      className="flex h-full w-80 shrink-0 flex-col border-border border-l bg-background duration-160 animate-in fade-in-0 slide-in-from-right-4 min-[1320px]:w-100"
    >
      {content}
    </aside>
  )
}

/** Заготовка панели на первой загрузке: те же зоны, что у панели с группой. */
export function DecisionPanelSkeleton() {
  return (
    <aside
      aria-hidden
      className="flex h-full w-80 shrink-0 flex-col gap-3 border-border border-l bg-background px-5 pt-5 min-[1320px]:w-100"
    >
      <span className="h-5 w-3/5 rounded-sm bg-muted" />
      <span className="h-4 w-2/5 rounded-sm bg-muted" />
      <span className="mt-2 h-9 w-full rounded-lg bg-muted" />
      <span className="flex gap-2">
        <span className="h-9 flex-1 rounded-lg bg-muted" />
        <span className="h-9 flex-1 rounded-lg bg-muted" />
      </span>
    </aside>
  )
}
