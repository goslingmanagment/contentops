import {
  type Account,
  formatNumber,
  type PlanAccountGroup,
  plural,
  type SlotGap,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ItemMenuButton } from '@contentops/ui/components/item-menu'
import { PlusIcon } from 'lucide-react'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { RowActions, RowTime } from './day-row'

interface GroupHeadProps {
  account: Account
  group: PlanAccountGroup
  rowCount: number
  /** Клик по заголовку группы выделяет все её строки (§3.3). */
  onSelectAll: () => void
  /** «⋯ → Отметить выложенное вне плана…» (DESIGN §2.5). */
  onOutsidePlan?: () => void
}

/**
 * Заголовок группы страницы (DESIGN §4.11): «Fansly 1 · LoraVie · Диана» и строка
 * интеграции этой страницы (§3.11), если Hub для неё не работает.
 */
export function GroupHead({
  account,
  group,
  rowCount,
  onSelectAll,
  onOutsidePlan,
}: GroupHeadProps) {
  const meta = [account.handle, group.assignee?.name].filter(Boolean).join(' · ')
  return (
    <div className="flex h-12 items-end gap-3 px-2 pb-2">
      <button
        type="button"
        onClick={onSelectAll}
        disabled={rowCount === 0}
        title={rowCount > 0 ? 'Выделить строки страницы' : undefined}
        className="flex min-w-0 shrink-0 items-baseline gap-2 rounded-sm text-left enabled:hover:text-primary-ink"
      >
        <span className="text-lg">{account.label}</span>
        <span className="truncate text-ink-3 text-sm">{meta}</span>
      </button>
      <div className="flex min-w-0 flex-1 justify-end">
        {group.integration ? (
          <IntegrationPhrase line={group.integration} withOwnerAction className="min-w-0" />
        ) : null}
      </div>
      {onOutsidePlan ? (
        <ItemMenuButton
          menu={{
            actions: [
              {
                id: 'outside',
                label: 'Отметить выложенное вне плана…',
                onSelect: onOutsidePlan,
              },
            ],
          }}
          size="icon-sm"
          label={`Ещё: ${account.label}`}
        />
      ) : null}
    </div>
  )
}

interface GapRowProps {
  gap: SlotGap
  /** В виде «по времени» — чья это страница. */
  accountLabel: string | null
  canAct: boolean
  onPick: () => void
}

/**
 * Пустое место нормы 54 пунктиром (DESIGN §4.11): «Здесь нужен лайф в vault» и «Выбрать»;
 * окно «В план» открывается с подставленной страницей, днём и типом.
 */
export function GapRow({ gap, accountLabel, canAct, onPick }: GapRowProps) {
  return (
    <div className="flex h-13.5 items-center gap-3 rounded-lg border border-input border-dashed px-2">
      <RowTime time={gap.time} allDay={false} />
      <div aria-hidden className="flex aspect-[3/4] w-7.5 items-center justify-center text-ink-3">
        <PlusIcon className="size-4" />
      </div>
      <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">
        {accountLabel ? `${accountLabel} · ` : ''}
        {gap.text}
      </span>
      {canAct ? (
        <RowActions>
          <Button variant="outline" size="sm" onClick={onPick}>
            Выбрать
          </Button>
        </RowActions>
      ) : null}
    </div>
  )
}

interface UnplannedLineProps {
  count: number
  onCheck: () => void
}

/** «Hub видел 1 пост без плана · Сверить» — одна серая строка под группой страницы. */
export function UnplannedLine({ count, onCheck }: UnplannedLineProps) {
  const posts = `${formatNumber(count)} ${plural(count, ['пост', 'поста', 'постов'])}`
  return (
    <div className="flex h-9 items-center gap-1 pl-29.5 text-muted-foreground text-sm">
      Hub видел {posts} без плана ·
      <Button variant="link" size="inline" className="text-sm" onClick={onCheck}>
        Сверить
      </Button>
    </div>
  )
}

/** Заголовок отменённых строк: они скрыты, пока их не показали через «⋯ → Отменённые». */
export function CancelledHead({ count }: { count: number }) {
  return (
    <div className="flex h-12 items-end gap-2 px-2 pb-2">
      <span className="text-lg">Отменённые</span>
      <span className="text-ink-3 text-sm tabular-nums">{count}</span>
    </div>
  )
}
