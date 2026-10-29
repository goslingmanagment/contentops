import type { Account, AccountCode } from '@contentops/contracts'
import { FilterPopoverChip } from '@contentops/ui/components/filter-chips'
import { ToggleGroup, ToggleGroupItem } from '@contentops/ui/components/toggle-group'
import { formatWhere, type WhereCondition } from './catalog-filters'

type Answer = 'yes' | 'no'

interface WhereChipProps {
  accounts: readonly Account[]
  conditions: readonly WhereCondition[]
  onChange: (next: string[]) => void
}

function answerOf(conditions: readonly WhereCondition[], account: AccountCode): Answer | '' {
  const condition = conditions.find((candidate) => candidate.account === account)
  if (!condition) {
    return ''
  }
  return condition.placed ? 'yes' : 'no'
}

/** «Нет на Fansly 2», «Есть на Fansly 1, нет на Fansly 2». */
function chipLabel(accounts: readonly Account[], conditions: readonly WhereCondition[]): string {
  const parts = conditions.map((condition) => {
    const page =
      accounts.find((account) => account.code === condition.account)?.label ?? condition.account
    return `${condition.placed ? 'есть' : 'нет'} на ${page}`
  })
  const text = parts.join(', ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Где залито'
}

/**
 * «Где залито ▾» (DESIGN §4.2): у каждой страницы «есть» или «нет». Чип можно поставить
 * на две страницы сразу: «есть на Fansly 1, нет на Fansly 2» — «подлейте как на фансли 1».
 */
export function WhereChip({ accounts, conditions, onChange }: WhereChipProps) {
  const setAnswer = (account: AccountCode, answer: string) => {
    const others = conditions.filter((condition) => condition.account !== account)
    const next =
      answer === 'yes' || answer === 'no'
        ? [...others, { account, placed: answer === 'yes' }]
        : others
    onChange(next.map(formatWhere))
  }
  return (
    <FilterPopoverChip label={chipLabel(accounts, conditions)} active={conditions.length > 0}>
      <p className="px-1 pb-1 text-ink-3 text-sm">Где залито</p>
      <ul className="flex flex-col gap-1">
        {accounts.map((account) => (
          <li key={account.code} className="flex h-10 items-center justify-between gap-3 px-1">
            <span className="truncate">{account.label}</span>
            <ToggleGroup
              type="single"
              variant="segment"
              size="sm"
              value={answerOf(conditions, account.code)}
              onValueChange={(answer) => setAnswer(account.code, answer)}
              aria-label={`${account.label}: есть или нет`}
            >
              <ToggleGroupItem value="yes" className="px-2.5 text-sm">
                есть
              </ToggleGroupItem>
              <ToggleGroupItem value="no" className="px-2.5 text-sm">
                нет
              </ToggleGroupItem>
            </ToggleGroup>
          </li>
        ))}
      </ul>
    </FilterPopoverChip>
  )
}
