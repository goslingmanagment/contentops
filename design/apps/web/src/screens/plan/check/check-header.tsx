import type { LocalDate } from '@contentops/contracts'
import type { ReactNode } from 'react'
import { PlanHeader } from '../shared/plan-header'

interface CheckHeaderProps {
  today: LocalDate
  /** «Подтвердить однозначные · 2» — только когда такие пары есть. */
  bulk: ReactNode
  /** `ⓘ` панели пары; в «Решённых» и «Не наше» панели нет. */
  info?: { open: boolean; onToggle: () => void }
}

/**
 * Шапка Плана на вкладке «Сверить» (DESIGN §4.15): общая шапка дня и недели, вкладка
 * «Сверить · 8» выбрана, справа «Подтвердить однозначные · 2» и `ⓘ`. Кнопка серая: синяя —
 * в панели. Число у вкладки шапка берёт сама из открытых случаев (`useCheckList`), как в
 * Дне и Неделе: серые решённые строки очереди в него не входят.
 */
export function CheckHeader({ today, bulk, info }: CheckHeaderProps) {
  return <PlanHeader active="check" date={today} actions={bulk} info={info} />
}
