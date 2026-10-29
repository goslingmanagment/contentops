import type { Crumb } from '@contentops/ui/components/field-header'
import { useHref } from '@/app/use-href'
import { useCatalogIndex } from '@/data/catalog'
import { useCurrentModel } from '@/shell/model/model-context'

/**
 * Крошка «Библиотека» над заказами и «Переделкой в PPV». Заголовок у трёх видов Кастомов
 * один — «Кастомы 197», поэтому вкладки видов за ним не переезжают.
 */
export function useCustomsCrumbs(): Crumb[] {
  const model = useCurrentModel().code
  const href = useHref()
  return [{ label: 'Библиотека', href: href({ to: '/$model/library', params: { model } }) }]
}

/** Число кастомов для заголовка «Кастомы 197» у всех трёх видов; пока индекс не пришёл — нет. */
export function useCustomsCount(): number | undefined {
  const model = useCurrentModel().code
  const index = useCatalogIndex(model).data
  return index?.items.filter((item) => item.type === 'custom').length
}
