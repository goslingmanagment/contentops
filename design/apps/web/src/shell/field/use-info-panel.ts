import { useCallback, useEffect, useState } from 'react'
import { readStored, writeStored } from '@/lib/browser-storage'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'

/**
 * Панель сведений экрана (DESIGN §3.4): открыта или закрыта — запоминается на раздел,
 * клавиша `i` открывает и закрывает. При окне 1280 панель уже — 320 вместо 360.
 */
export function useInfoPanel(sectionKey: string) {
  const storageKey = `contentops:info-panel:${sectionKey}`
  const [open, setOpen] = useState(() => readStored('local', storageKey) === 'open')
  useEffect(() => writeStored('local', storageKey, open ? 'open' : 'closed'), [open, storageKey])

  const toggle = useCallback(() => setOpen((current) => !current), [])
  const close = useCallback(() => setOpen(false), [])
  useKeyboardShortcut({ code: 'KeyI' }, toggle)

  const narrow = useMediaQuery('(max-width: 1319px)')
  return { open, toggle, close, width: narrow ? ('narrow' as const) : ('default' as const) }
}
