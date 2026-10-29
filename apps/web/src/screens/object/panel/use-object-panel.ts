import { useCallback, useEffect, useState } from 'react'
import { readStored, writeStored } from '@/lib/browser-storage'
import { useMediaQuery } from '@/lib/use-media-query'

const STORAGE_KEY = 'contentops:info-panel:object'
const WIDE_WINDOW = '(min-width: 1440px)'
const NARROW_WINDOW = '(max-width: 1319px)'

/**
 * Панель сведений объекта (DESIGN §4.4): открыта по умолчанию при окне от 1440, дальше
 * запоминается, как у всех разделов (§3.4). При окне 1280 панель уже — 320. Клавишу `i`
 * слушает страница объекта: панель открывает и раскрытая страница «где залито».
 */
export function useObjectPanel() {
  const wide = useMediaQuery(WIDE_WINDOW)
  const [open, setOpen] = useState(() => {
    const stored = readStored('local', STORAGE_KEY)
    return stored === null ? window.matchMedia(WIDE_WINDOW).matches : stored === 'open'
  })
  const [touched, setTouched] = useState(() => readStored('local', STORAGE_KEY) !== null)
  useEffect(() => {
    if (touched) {
      writeStored('local', STORAGE_KEY, open ? 'open' : 'closed')
    }
  }, [open, touched])

  const show = useCallback(() => {
    setTouched(true)
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    setTouched(true)
    setOpen(false)
  }, [])

  const narrow = useMediaQuery(NARROW_WINDOW)
  return {
    open: touched ? open : wide,
    show,
    close,
    width: narrow ? ('narrow' as const) : ('default' as const),
  }
}
