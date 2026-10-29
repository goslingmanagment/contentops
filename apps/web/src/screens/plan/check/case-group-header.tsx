import type { Account, IntegrationLine } from '@contentops/contracts'
import { cn } from '@contentops/ui/lib/utils'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'

interface CaseGroupHeaderProps {
  account: Account
  /** Строка Hub этой страницы встаёт в заголовок её группы (DESIGN §3.11). */
  line: IntegrationLine | null
  first: boolean
}

/** Заголовок группы «Fansly 2 · LoraViex», как в дне плана; первый — без отступа сверху. */
export function CaseGroupHeader({ account, line, first }: CaseGroupHeaderProps) {
  return (
    <div className={cn('flex h-full items-end gap-3 px-2 pb-2', first ? 'pt-0' : 'pt-3')}>
      <h2 className="flex min-w-0 shrink-0 items-baseline gap-2">
        <span className="text-lg">{account.label}</span>
        <span className="text-ink-3 text-sm">{account.handle}</span>
      </h2>
      {line ? <IntegrationPhrase line={line} withOwnerAction className="ml-auto" /> : null}
    </div>
  )
}
