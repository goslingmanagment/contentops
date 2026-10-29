import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { useHref } from '@/app/use-href'
import { useInboxList } from '@/data/inbox'
import { useCurrentModel } from '@/shell/model/model-context'

export type InboxTab = 'new' | 'done' | 'old'

/**
 * Вкладки «Приехало» сразу за заголовком (DESIGN §4.8): «Новое 9», «Решённое»,
 * «Разбор старого 38». Последняя видна, только пока в старом есть спорное. Число
 * «Нового» — то же, что в колонке: решение плюс готовое.
 */
export function InboxTabs({ active }: { active: InboxTab }) {
  const model = useCurrentModel().code
  const list = useInboxList(model, 'active').data
  const href = useHref()
  const tabs = [
    {
      value: 'new' as const,
      label: 'Новое',
      detail: list?.count || undefined,
      href: href({ to: '/$model/inbox', params: { model } }),
    },
    {
      value: 'done' as const,
      label: 'Решённое',
      href: href({ to: '/$model/inbox/done', params: { model } }),
    },
    {
      value: 'old' as const,
      label: 'Разбор старого',
      detail: list?.legacy_disputes || undefined,
      href: href({ to: '/$model/inbox/old', params: { model } }),
    },
  ].filter((tab) => tab.value !== 'old' || active === 'old' || (tab.detail ?? 0) > 0)

  return <SectionTabs tabs={tabs} value={active} label="Приехало" />
}
