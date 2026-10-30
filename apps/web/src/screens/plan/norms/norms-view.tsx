import type { AccountCode, WeekNorm } from '@contentops/contracts'
import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useHref } from '@/app/use-href'
import { useWeekNorm, useWeekNorms } from '@/data/plan'
import { useModelPeople } from '@/data/settings'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePlanAccess } from '../shared/use-plan-access'
import { NormEditor } from './norm-editor'

function perWeek(norm: WeekNorm | undefined): number {
  return (norm?.cells ?? []).reduce(
    (sum, cell) => sum + cell.per_day.reduce((days, count) => days + count, 0),
    0,
  )
}

/**
 * Норма недели страниц модели (DESIGN §4.14): сверху пять страниц общими вкладками
 * `SectionTabs` с числом мест в неделю, ниже норма выбранной. Живёт в рамке Настроек («Страницы и нормы»). КМ и владелец правят,
 * остальные видят.
 */
export function NormsView({ account }: { account: AccountCode }) {
  const model = useCurrentModel()
  const href = useHref()
  const access = usePlanAccess()
  const norms = useWeekNorms(
    model.code,
    model.accounts.map((page) => page.code),
  )
  const norm = useWeekNorm(model.code, account)
  // «Обычно выкладывает» выбирают из людей с правами на модель.
  const people = useModelPeople(model.code).data ?? []
  const page = model.accounts.find((candidate) => candidate.code === account)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-lg">{model.name}</h2>
        <SectionTabs
          label="Страницы"
          value={account}
          className="flex-wrap self-start"
          tabs={model.accounts.map((candidate) => ({
            value: candidate.code,
            label: candidate.label,
            // Мест в неделю по норме; пока нормы не пришли — заготовка той же ширины.
            detail: norms.ready
              ? perWeek(norms.norms.find((item) => item.account === candidate.code))
              : null,
            href: href({
              to: '/$model/settings/pages/$account',
              params: { model: model.code, account: candidate.code },
            }),
          }))}
        />
      </div>
      <section className="flex min-w-0 flex-col gap-4">
        <h3 className="font-medium text-base">
          {page ? `${page.label} ${page.handle} · норма недели` : 'Норма недели'}
        </h3>
        {norm.isError ? (
          <ErrorLine message="Не загрузилось" onRetry={() => void norm.refetch()} />
        ) : null}
        {norm.isPending && !norm.isError ? (
          <div aria-hidden className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full rounded-lg" />
            {Array.from({ length: 4 }, (_, row) => (
              <Skeleton key={`row-${row}`} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : null}
        {norm.data && page ? (
          <NormEditor norm={norm.data} page={page} people={people} readOnly={!access.canAct} />
        ) : null}
      </section>
    </div>
  )
}
