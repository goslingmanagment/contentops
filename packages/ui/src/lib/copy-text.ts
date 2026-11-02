/**
 * Копирует текст в буфер обмена; `false` — не вышло, и вызывающий обязан об этом сказать.
 * Продукт работает и по простому HTTP: там `isSecureContext` ложно и `navigator.clipboard`
 * нет, поэтому запасной путь — скрытое поле и `document.execCommand('copy')`.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Права браузера: запасной путь ещё может сработать.
    }
  }
  return copyThroughField(text)
}

function copyThroughField(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.setAttribute('aria-hidden', 'true')
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;opacity:0'
  // Рядом с фокусом, а не в `body`: окно и меню держат фокус внутри себя и не отдали бы его.
  const host = previous && previous !== document.body ? previous.parentElement : null
  ;(host ?? document.body).append(field)
  try {
    field.focus({ preventScroll: true })
    field.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    previous?.focus({ preventScroll: true })
  }
}
