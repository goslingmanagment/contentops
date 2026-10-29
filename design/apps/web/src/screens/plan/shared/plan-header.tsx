import { isoWeekOf, type LocalDate } from '@contentops/contracts'
import { FieldHeader, HeaderAction } from '@contentops/ui/components/field-header'
import { type SectionTab, SectionTabs } from '@contentops/ui/components/section-tabs'
import { CalendarPlusIcon, SlidersHorizontalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useHref } from '@/app/use-href'
import { useCheckList } from '@/data/check'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'

export type PlanTab = 'day' | 'week' | 'check'

interface PlanHeaderProps {
  active: PlanTab
  /** День, от которого строятся ссылки «День» и «Неделя». */
  date: LocalDate
  /** «В план» (серая): окно с поиском объекта. */
  onPlan?: () => void
  /** Своё управление вкладки перед «Нормы»: «Подтвердить однозначные · 2» у «Сверить». */
  actions?: ReactNode
  /** Число у «Сверить», если вкладка считает его сама (решённые строки стоят на месте). */
  checkCount?: number
  info?: { open: boolean; onToggle: () => void }
  /** Полоса выделения встаёт на место шапки той же высоты (§3.3). */
  selectionBar?: ReactNode
}

/**
 * Шапка Плана (DESIGN §4.11): «План», вкладки «День · Неделя · Сверить 2»; справа
 * «Нормы» и серая «В план». Общая для дня, недели и сверки. Собрана на `FieldHeader`:
 * при открытой панели и на 1280 сначала «Нормы» и «В план» остаются значками, заголовок
 * и вкладки не трогаются.
 */
export function PlanHeader({
  active,
  date,
  onPlan,
  actions,
  checkCount: ownCheckCount,
  info,
  selectionBar,
}: PlanHeaderProps) {
  const model = useCurrentModel()
  const role = useRole()
  const href = useHref()
  const check = useCheckList(model.code)
  const checkCount = ownCheckCount ?? check.data?.items.length ?? 0
  const params = { model: model.code }
  const firstAccount = model.accounts[0]?.code
  const canAct = role === 'owner' || role === 'manager'

  const tabs: readonly SectionTab<PlanTab>[] = [
    {
      value: 'day',
      label: 'День',
      href: href({ to: '/$model/plan/$date', params: { ...params, date } }),
    },
    {
      value: 'week',
      label: 'Неделя',
      href: href({ to: '/$model/plan/w/$week', params: { ...params, week: isoWeekOf(date) } }),
    },
    {
      value: 'check',
      label: 'Сверить',
      detail: checkCount > 0 ? checkCount : undefined,
      href: href({ to: '/$model/plan/check', params }),
    },
  ]

  return (
    <FieldHeader
      title="План"
      nav={<SectionTabs tabs={tabs} value={active} label="Вид плана" />}
      actions={
        <>
          {actions}
          {canAct && firstAccount ? (
            <HeaderAction
              icon={<SlidersHorizontalIcon />}
              label="Нормы"
              href={href({
                to: '/$model/settings/pages/$account',
                params: { ...params, account: firstAccount },
              })}
            />
          ) : null}
          {canAct && onPlan ? (
            <HeaderAction icon={<CalendarPlusIcon />} label="В план" onClick={onPlan} />
          ) : null}
        </>
      }
      info={info}
      selectionBar={selectionBar}
    />
  )
}
