/** Где стоит полоска после действия (DESIGN §3.8): по центру поля, над лотком, если он под ней. */
export interface ToastPlace {
  /** Центр поля по горизонтали; `null` — центр окна. */
  centerX: number | null
  /** Отступ снизу. */
  bottom: number
}

/** Обычный отступ полоски от низа окна. */
export const TOAST_BOTTOM_PX = 24
/** Полоска не шире 40rem (`--width` у полосок). */
const TOAST_MAX_WIDTH_PX = 640
/** Зазор между полоской и лотком. */
const TOAST_GAP_PX = 12

export const TOAST_DEFAULT_PLACE: ToastPlace = { centerX: null, bottom: TOAST_BOTTOM_PX }

function visibleRect(selector: string): DOMRect | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return rect
  }
  return null
}

/**
 * Полоска встаёт по центру поля `field`. Если внизу окна лежит `avoid` (лоток загрузок)
 * и полоса, где может оказаться полоска, его задевает, полоска поднимается над ним —
 * лоток и его «Скачать» остаются видны.
 */
export function measureToastPlace(field: string, avoid: string): ToastPlace {
  const fieldRect = visibleRect(field)
  const centerX = fieldRect ? fieldRect.left + fieldRect.width / 2 : window.innerWidth / 2
  const half = Math.min(TOAST_MAX_WIDTH_PX, window.innerWidth - 32) / 2
  const tray = visibleRect(avoid)
  const overlaps = tray !== null && tray.left < centerX + half && tray.right > centerX - half
  const bottom = overlaps && tray ? window.innerHeight - tray.top + TOAST_GAP_PX : TOAST_BOTTOM_PX
  return { centerX: fieldRect ? centerX : null, bottom: Math.max(TOAST_BOTTOM_PX, bottom) }
}
