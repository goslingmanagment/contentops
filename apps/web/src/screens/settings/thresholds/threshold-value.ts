import {
  formatNumber,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  ItemTypeSchema,
  type Model,
  type Threshold,
} from '@contentops/contracts'

/** Порог и его исключения — одна группа строк раздела. */
export interface ThresholdGroup {
  base: Threshold
  exceptions: Threshold[]
}

/** Строки с сервера по ключам, в их порядке: строка для всего, под ней исключения. */
export function groupThresholds(rows: readonly Threshold[]): ThresholdGroup[] {
  const groups = new Map<Threshold['key'], ThresholdGroup>()
  for (const row of rows) {
    if (row.scope === 'all') {
      groups.set(row.key, { base: row, exceptions: groups.get(row.key)?.exceptions ?? [] })
    }
  }
  for (const row of rows) {
    if (row.scope !== 'all') {
      groups.get(row.key)?.exceptions.push(row)
    }
  }
  return [...groups.values()]
}

/** Как назвать исключение: «Fansly 2» и серым «страница · Лора», «Лайф» и «тип». */
export interface ScopeName {
  name: string
  kind: string
}

export function scopeName(threshold: Threshold, models: readonly Model[]): ScopeName {
  const value = threshold.scope_value ?? ''
  if (threshold.scope === 'type') {
    const type = ItemTypeSchema.safeParse(value)
    return { name: type.success ? ITEM_TYPE_INFO[type.data].folder : value, kind: 'тип' }
  }
  if (threshold.scope === 'model') {
    return { name: models.find((model) => model.code === value)?.name ?? value, kind: 'модель' }
  }
  for (const model of models) {
    const account = model.accounts.find((candidate) => candidate.code === value)
    if (account) {
      return {
        name: account.label,
        kind: models.length > 1 ? `страница · ${model.name}` : 'страница',
      }
    }
  }
  return { name: value, kind: 'страница' }
}

/** Вариант в «+ для страницы или типа…»: `account:lora-2`, `type:life`. */
export interface ScopeOption {
  id: string
  scope: 'account' | 'type'
  scope_value: string
  name: string
  /** Для выбранного в поле: «Fansly 2 · Лора», когда моделей несколько. */
  fullName: string
}

export interface ScopeOptionGroup {
  label: string
  options: ScopeOption[]
}

/** Страницы по моделям и типы; уже заданные исключения порога в список не попадают. */
export function scopeOptions(
  models: readonly Model[],
  taken: readonly Threshold[],
): ScopeOptionGroup[] {
  const isTaken = (scope: ScopeOption['scope'], value: string) =>
    taken.some((row) => row.scope === scope && row.scope_value === value)
  const pages = models.map((model) => ({
    label: model.name,
    options: model.accounts
      .filter((account) => !isTaken('account', account.code))
      .map((account) => ({
        id: `account:${account.code}`,
        scope: 'account' as const,
        scope_value: account.code,
        name: account.label,
        fullName: models.length > 1 ? `${account.label} · ${model.name}` : account.label,
      })),
  }))
  const types = {
    label: 'Типы',
    options: ITEM_TYPES.filter((type) => !isTaken('type', type)).map((type) => ({
      id: `type:${type}`,
      scope: 'type' as const,
      scope_value: type,
      name: ITEM_TYPE_INFO[type].folder,
      fullName: ITEM_TYPE_INFO[type].folder,
    })),
  }
  return [...pages, types].filter((group) => group.options.length > 0)
}

/** Значение для поля ввода: `14`, `0,5`; пустое — не задано. */
export function draftOf(value: number | null): string {
  return value === null ? '' : formatNumber(value).replaceAll(' ', '')
}

/**
 * Разбор ввода: пусто — «не задано», запятая и точка годятся. `undefined` — не число,
 * сохранять нечего.
 */
export function parseDraft(draft: string): number | null | undefined {
  const text = draft.trim().replace(',', '.')
  if (text === '') {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
