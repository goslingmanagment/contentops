import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { useHref } from '@/app/use-href'
import { useCurrentModel } from '@/shell/model/model-context'

export type CustomsView = 'all' | 'orders' | 'to-ppv'

const VIEWS: readonly { value: CustomsView; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'orders', label: 'Заказы' },
  { value: 'to-ppv', label: 'Переделка в PPV' },
]

const SEARCH_VIEW: Record<CustomsView, 'orders' | 'to-ppv' | undefined> = {
  all: undefined,
  orders: 'orders',
  'to-ppv': 'to-ppv',
}

/**
 * «Все · Заказы · Переделка в PPV» — вкладки Кастомов сразу за заголовком (DESIGN §4.2,
 * §4.16): одна папка, три вида, одни вкладки на все три экрана, место в шапке не
 * меняется. Каждый вид — свой адрес (`?view=orders`, `?view=to-ppv`), поэтому переход
 * пишется в историю и «Назад» возвращает вид.
 */
export function CustomsViewSwitch({ value }: { value: CustomsView }) {
  const model = useCurrentModel().code
  const href = useHref()
  const tabs = VIEWS.map((view) => ({
    ...view,
    href: href({
      to: '/$model/library/customs',
      params: { model },
      search: { view: SEARCH_VIEW[view.value] },
    }),
  }))
  return <SectionTabs tabs={tabs} value={value} label="Вид Кастомов" />
}
