import {
  type AcceptHow,
  type AcceptManyResult,
  type AcceptResult,
  type BatchResult,
  formatNumber,
  plural,
} from '@contentops/contracts'

/** Полоска после «Принять» (DESIGN §3.8): «Принято → CUS-198 · Открыть» и следующий шаг. */

const ACCEPTED_PREFIX: Record<AcceptHow, (id: string) => string> = {
  new: (id) => `Принято → ${id}`,
  upload: (id) => `Принято → ${id}`,
  delivery: (id) => `Принято → ${id}`,
  extend: (id) => `Принято → + в ${id}`,
  fix: (id) => `Принято как исправление → ${id}`,
  duplicate: (id) => `Уже есть: ${id}`,
}

export function acceptedMessage(result: AcceptResult): string {
  return ACCEPTED_PREFIX[result.how](result.item_id)
}

/** Чем стала группа в пакете: «SET-075», «+ в SET-074», «уже есть SET-069». */
const BECAME: Record<AcceptHow, (id: string) => string> = {
  new: (id) => id,
  upload: (id) => id,
  delivery: (id) => id,
  extend: (id) => `+ в ${id}`,
  fix: (id) => `исправление ${id}`,
  duplicate: (id) => `уже есть ${id}`,
}

/** Сколько итогов пакета называть поимённо; остальные — «и ещё 3». */
const NAMED = 4

/**
 * Итог «Принять N» (§3.3, §3.8): чем стала каждая группа — «Принято: SET-075, LIFE-192,
 * + в SET-074, PRM-017»; непрошедшие — «· 1 не готова», их выделяет «Показать».
 */
export function acceptManyMessage(result: AcceptManyResult): string {
  const became = result.results.flatMap((entry) =>
    entry.ok && entry.accepted ? [BECAME[entry.accepted.how](entry.accepted.item_id)] : [],
  )
  if (became.length === 0) {
    return batchMessage('Принято', result)
  }
  const named = became.length > NAMED ? became.slice(0, NAMED - 1) : became
  const rest = became.length - named.length
  const failed = result.results.filter((entry) => !entry.ok).length
  return [
    `Принято: ${named.join(', ')}${rest > 0 ? ` и ещё ${formatNumber(rest)}` : ''}`,
    failed > 0
      ? `${formatNumber(failed)} не ${plural(failed, ['готова', 'готовы', 'готовы'])}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** Следующий шаг по типу, как его называет сервер. */
export type NextStep = 'open' | 'upload_teaser' | 'plan' | 'close_order'

const NEXT_STEP: Readonly<Record<string, NextStep>> = {
  'Отобрать кадры': 'open',
  'Лента / чаты': 'open',
  'Добавить тизер': 'upload_teaser',
  'В план': 'plan',
  'Закрыть заказ': 'close_order',
}

export function nextStepOf(label: string): NextStep {
  return NEXT_STEP[label] ?? 'open'
}

export function groupsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['группа', 'группы', 'групп'])}`
}

/** Итог пакета «по каждой записи» (§3.3): «Принято 4 из 5 · 1 не готова · Показать». */
export function batchMessage(verb: string, result: BatchResult): string {
  const done = result.results.filter((entry) => entry.ok).length
  const failed = result.results.length - done
  if (failed === 0) {
    return `${verb} ${groupsWord(done)}`
  }
  return `${verb} ${formatNumber(done)} из ${formatNumber(result.results.length)} · ${formatNumber(failed)} не ${plural(failed, ['готова', 'готовы', 'готовы'])}`
}
