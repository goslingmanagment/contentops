import type { z } from 'zod'

/**
 * Контекст экрана в записи истории браузера (DESIGN §2.4, §3.13): выделение и место
 * прокрутки не пишутся в адрес, а кладутся в `history.state` текущей записи. «Назад»
 * возвращает запись вместе с ними.
 *
 * Запись идёт прямо в `history.state` с сохранением служебных полей маршрутизатора и мимо
 * его подписки, поэтому маршрутизатор не перерисовывает экран на каждое изменение.
 */

function currentState(): Record<string, unknown> {
  const state: unknown = window.history.state
  return typeof state === 'object' && state !== null ? { ...state } : {}
}

export function readHistoryValue<Schema extends z.ZodType>(
  key: string,
  schema: Schema,
): z.output<Schema> | undefined {
  const parsed = schema.safeParse(currentState()[key])
  return parsed.success ? parsed.data : undefined
}

/**
 * Метод самого `History`, а не `window.history.replaceState`: маршрутизатор подменяет
 * последний и на каждый вызов перечитывает адрес. Запись в середине перехода (старый
 * экран ещё пишет своё выделение, а новый адрес ещё не записан в браузер) вернула бы
 * маршрутизатор на прежний адрес.
 */
const replaceState = History.prototype.replaceState

export function writeHistoryValue(key: string, value: unknown): void {
  replaceState.call(window.history, { ...currentState(), [key]: value }, '')
}
