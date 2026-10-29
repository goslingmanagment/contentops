import type { CheckCase, CheckCaseKind, Platform } from '@contentops/contracts'

/**
 * Что можно сделать со случаем (DESIGN §4.15, §3.12): кнопки строки, главное «да» панели
 * и клавиши `1` `2` `3`. Одна таблица по виду случая вместо развилок по экрану.
 */

export type CaseAction = 'confirm' | 'reject' | 'review' | 'bind' | 'outside' | 'reject-all'

/** Подписи кнопок строки и меню (DESIGN §4.15). */
export const ACTION_LABEL: Record<CaseAction, string> = {
  confirm: 'Это оно',
  reject: 'Не то',
  review: 'Разобрать',
  bind: 'Привязать…',
  outside: 'Не наше',
  'reject-all': 'Ни один',
}

interface KindRules {
  /** Главное «да» (`1`); `null` — сначала нужен выбор в панели. */
  primary: CaseAction | null
  /** Отказ (`3`). */
  refusal: CaseAction | null
}

const RULES: Record<CheckCaseKind, KindRules> = {
  candidate: { primary: 'confirm', refusal: 'reject' },
  mismatch: { primary: 'confirm', refusal: 'reject' },
  conflict: { primary: 'confirm', refusal: 'reject' },
  partial: { primary: 'confirm', refusal: 'reject' },
  variants: { primary: null, refusal: 'reject-all' },
  surface: { primary: null, refusal: null },
  unplanned: { primary: 'bind', refusal: 'outside' },
  // vault: «Залить заново» — окно «В план» в панели, клавиши `1` у него нет.
  vault_missing: { primary: null, refusal: null },
  vault_stale: { primary: null, refusal: null },
}

/** Одна пара «наше — пост»: «Это оно» и «Не то» прямо в строке. */
export function isSinglePair(entry: CheckCase): boolean {
  return (entry.kind === 'candidate' || entry.kind === 'mismatch') && entry.posts.length === 1
}

/**
 * Кнопки строки справа. Пара Fansly решается в строке; OnlyFans — только глядя на весь
 * состав поста, поэтому «Разобрать»; пост без плана — «Привязать…» и «Не наше».
 */
export function rowActions(entry: CheckCase, platform: Platform): readonly CaseAction[] {
  if (entry.kind === 'unplanned') {
    return ['bind', 'outside']
  }
  if (isSinglePair(entry) && platform === 'fansly') {
    return ['confirm', 'reject']
  }
  return ['review']
}

export type DecisionKey = 1 | 2 | 3

/**
 * Клавиши очереди (DESIGN §3.12): `1` — главное «да», `2` — «Разобрать», `3` — отказ.
 * Цифры действуют на выбранный случай, а его пара всегда открыта в панели — поэтому и на
 * OnlyFans «Это оно» нажимают, видя весь состав поста.
 */
export function keyAction(entry: CheckCase, key: DecisionKey): CaseAction | null {
  if (key === 2) {
    return 'review'
  }
  const rules = RULES[entry.kind]
  return key === 3 ? rules.refusal : (rules.primary ?? 'review')
}
