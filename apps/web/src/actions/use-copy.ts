import { copyText } from '@contentops/ui/lib/copy-text'
import { useCallback } from 'react'
import { useActionToast } from './action-toast-context'

/** Копирование с итогом в полоске (DESIGN §3.8): удача — своя фраза, неудача не молчит. */
export function useCopy(): (text: string, done: string) => Promise<boolean> {
  const toast = useActionToast()
  return useCallback(
    async (text, done) => {
      const copied = await copyText(text)
      toast.show(copied ? { message: done } : { message: 'Не скопировалось', tone: 'error' })
      return copied
    },
    [toast],
  )
}
