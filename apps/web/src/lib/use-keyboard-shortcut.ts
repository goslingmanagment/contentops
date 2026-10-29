import { hasModifierKey, isTypingTarget } from '@contentops/ui/lib/platform'
import { useEffect, useEffectEvent } from 'react'

export interface ShortcutOptions {
  /** `KeyboardEvent.code`: `KeyI`, `Slash`, `Digit1` — работает и в русской раскладке. */
  code: string
  /** Ctrl на Windows, ⌘ на Mac. */
  modifier?: boolean
  shift?: boolean
  /** Срабатывать и в поле ввода (например, `Ctrl K`). */
  whileTyping?: boolean
  /**
   * Перехватить клавишу раньше общих клавиш оболочки: экран, где у клавиши свой смысл
   * (`/` в Журнале — фильтр, а не поиск), слушает в фазе перехвата.
   */
  capture?: boolean
  enabled?: boolean
}

/** Клавиша не срабатывает внутри открытого окна: у окна свои клавиши. */
function insideDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"]') !== null
}

function matches(event: KeyboardEvent, options: ShortcutOptions): boolean {
  if (event.code !== options.code || event.altKey) {
    return false
  }
  if (hasModifierKey(event) !== (options.modifier ?? false)) {
    return false
  }
  if (event.shiftKey !== (options.shift ?? false)) {
    return false
  }
  if (!options.whileTyping && isTypingTarget(event.target)) {
    return false
  }
  return !insideDialog(event.target)
}

/**
 * Клавиша уровня окна (DESIGN §3.12). Слушается по `KeyboardEvent.code`, в полях ввода
 * буквы печатаются, а не управляют экраном.
 */
export function useKeyboardShortcut(options: ShortcutOptions, handler: () => void): void {
  const { code, modifier, shift, whileTyping, capture = false, enabled = true } = options
  const onShortcut = useEffectEvent(handler)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matches(event, { code, modifier, shift, whileTyping })) {
        return
      }
      event.preventDefault()
      onShortcut()
    }
    window.addEventListener('keydown', onKeyDown, { capture })
    return () => window.removeEventListener('keydown', onKeyDown, { capture })
  }, [code, modifier, shift, whileTyping, capture, enabled])
}
