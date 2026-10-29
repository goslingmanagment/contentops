import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { useHref } from '@/app/use-href'
import { useCurrentModel } from '@/shell/model/model-context'

export type PromoView = 'channels' | 'handoffs'

const VIEWS: readonly { value: PromoView; label: string }[] = [
  { value: 'channels', label: 'Каналы' },
  { value: 'handoffs', label: 'Передачи' },
]

/**
 * Вкладки «Каналы · Передачи» сразу за заголовком Промо (DESIGN §4.17). Вид — свой адрес
 * (`?view=handoffs`), переход пишется в историю.
 */
export function PromoViewSwitch({ value }: { value: PromoView }) {
  const model = useCurrentModel().code
  const href = useHref()
  const tabs = VIEWS.map((view) => ({
    ...view,
    href: href({
      to: '/$model/library/promo',
      params: { model },
      search: { view: view.value === 'handoffs' ? 'handoffs' : undefined },
    }),
  }))
  return <SectionTabs tabs={tabs} value={value} label="Вид Промо" />
}
