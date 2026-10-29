import { useEffect } from 'react'
import type { Skin } from './search-params'

/** Вешает вид на корень документа: токены «Фокуса» лежат под `[data-skin="focus"]`. */
export function useSkin(skin: Skin | undefined) {
  useEffect(() => {
    const root = document.documentElement
    if (skin) {
      root.dataset.skin = skin
    } else {
      delete root.dataset.skin
    }
  }, [skin])
}
