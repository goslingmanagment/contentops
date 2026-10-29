import type { Handoff } from '@contentops/contracts'
import { z } from 'zod'

/** Ключ панели передачи в записи истории: «Назад» возвращает её вместе с подборкой. */
export const HANDOFF_PANEL_KEY = 'promo:handoff'

/**
 * Что показывает панель передачи (DESIGN §4.17): текущую передачу подборки, конкретную
 * (из списка «Передачи») или шаг 1 новой — досылку всей подборки или только выбранных в
 * ней материалов (ключи `RAW-0213/raw03`).
 */
export const HandoffPanelStateSchema = z
  .discriminatedUnion('show', [
    z.object({ show: z.literal('current') }),
    z.object({ show: z.literal('new'), members: z.array(z.string()).min(1).optional() }),
    z.object({ show: z.literal('handoff'), id: z.string() }),
  ])
  .nullable()

export type HandoffPanelState = NonNullable<z.infer<typeof HandoffPanelStateSchema>>

/** Передача, над которой ещё идёт работа: готовится, подготовлена или не собралась. */
function isOpen(handoff: Handoff): boolean {
  return handoff.state !== 'sent'
}

/**
 * Какую передачу показать: названную; иначе последнюю незавершённую. `null` — шаг 1:
 * всё прежнее передано, и новая передача подборки — это досылка.
 */
export function handoffToShow(
  state: HandoffPanelState,
  handoffs: readonly Handoff[],
): Handoff | null {
  if (state.show === 'new') return null
  if (state.show === 'handoff') {
    return handoffs.find((handoff) => handoff.id === state.id) ?? null
  }
  const newestFirst = [...handoffs].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  )
  return newestFirst.find(isOpen) ?? null
}
