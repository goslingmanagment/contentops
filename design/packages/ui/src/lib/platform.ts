/** На Mac подписываем ⌘, на остальных системах — Ctrl (DESIGN §3.12). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

export function modifierKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl'
}

/** Нажат ли Ctrl на Windows или ⌘ на Mac. */
export function hasModifierKey(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isApplePlatform() ? event.metaKey : event.ctrlKey
}

/** Фокус в поле ввода: одиночные клавиши там печатают текст, а не управляют экраном. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
