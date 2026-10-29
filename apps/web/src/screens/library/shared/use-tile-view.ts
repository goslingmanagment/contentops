import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import { useCallback } from 'react'
import { tileViewOf, type ViewParam, viewParamOf } from '@/app/search-params'
import { useRememberedView } from '@/shell/field/use-remembered-view'

/**
 * Вид списка — крупная плитка, плитка или строка (DESIGN §3.2): из адреса, иначе прошлый
 * выбор в этом разделе. Смена вида пишется и в адрес, и в память раздела.
 */
export function useTileView(
  storageKey: string,
  fromAddress: ViewParam | undefined,
  onChange: (view: ViewParam) => void,
) {
  const { view, remember } = useRememberedView(storageKey, fromAddress)
  const changeView = useCallback(
    (next: ObjectTileView) => {
      const param = viewParamOf(next)
      remember(param)
      onChange(param)
    },
    [remember, onChange],
  )
  return { tileView: tileViewOf(view), changeView }
}
