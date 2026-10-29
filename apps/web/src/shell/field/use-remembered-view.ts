import { useCallback } from 'react'
import { type ViewParam, ViewParamSchema } from '@/app/search-params'
import { readStored, writeStored } from '@/lib/browser-storage'

/**
 * Вид раздела (DESIGN §3.2): живёт в адресе, а без него берётся тот, что человек выбрал
 * в этом разделе в прошлый раз.
 */
export function useRememberedView(sectionKey: string, fromAddress: ViewParam | undefined) {
  const storageKey = `contentops:view:${sectionKey}`
  const remembered = ViewParamSchema.safeParse(readStored('local', storageKey)).data
  const view: ViewParam = fromAddress ?? remembered ?? 'large'
  const remember = useCallback(
    (next: ViewParam) => writeStored('local', storageKey, next),
    [storageKey],
  )
  return { view, remember }
}
