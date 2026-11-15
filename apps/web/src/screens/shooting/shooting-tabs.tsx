import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { useHref } from '@/app/use-href'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'

export type ShootingTab = 'customs' | 'tasks'

/**
 * «Кастомы · ТЗ» — вкладки «Съёмки» (пакет C3): заказы фанов из Hub со стороны съёмки и задания
 * модели, что не заказ фана. У «Только кастомы» вкладка одна — её и не рисуем.
 */
export function ShootingTabs({ value }: { value: ShootingTab }) {
  const model = useCurrentModel().code
  const href = useHref()
  const role = useRole()
  if (role === 'customs') return null
  const tabs = [
    {
      value: 'customs' as const,
      label: 'Кастомы',
      href: href({ to: '/$model/shooting', params: { model } }),
    },
    {
      value: 'tasks' as const,
      label: 'ТЗ',
      href: href({ to: '/$model/shooting', params: { model }, search: { tab: 'tasks' } }),
    },
  ]
  return <SectionTabs tabs={tabs} value={value} label="Вкладки Съёмки" />
}
