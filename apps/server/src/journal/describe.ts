import type { Gender } from '@contentops/contracts/domain/common'
import type { JournalArea, JournalEvent } from '@contentops/contracts/domain/journal'
import { pastVerb } from '@contentops/contracts/format'

/**
 * Words of the journal feed (DESIGN §4.18). An `action` row of a settings command keeps in
 * `before`/`after` what the screen shows — field → value in words — and the object's name in
 * `subject_label`; the phrase is built here from the action, the actor and that name.
 * The `change` rows of the triggers keep the raw columns for audit.
 */

/** Field → value in words: «Роль» → «Контент-менеджер». */
export type Snapshot = Record<string, string>

interface Wording {
  /** Masculine past verb, as `pastVerb` expects: «изменил». */
  verb: string
  /** The rest; `{subject}` is the object's name: «норму {subject}». */
  rest: string
  /** Noun of the action for refusals and errors: «изменение нормы». */
  noun: string
}

const WORDING: Record<string, Wording> = {
  'auth.signIn': { verb: 'выполнил', rest: 'вход', noun: 'вход' },
  'auth.signOutEverywhere': {
    verb: 'завершил',
    rest: 'все свои сессии',
    noun: 'выход везде',
  },
  'settings.updateProfile': { verb: 'изменил', rest: 'профиль', noun: 'изменение профиля' },
  'settings.changePassword': { verb: 'сменил', rest: 'пароль', noun: 'смена пароля' },
  'settings.revokeMySession': {
    verb: 'отозвал',
    rest: 'сессию {subject}',
    noun: 'отзыв сессии',
  },
  'settings.addPerson': {
    verb: 'добавил',
    rest: 'человека: {subject}',
    noun: 'добавление человека',
  },
  'settings.updatePerson': { verb: 'изменил', rest: 'права: {subject}', noun: 'изменение прав' },
  'settings.revokePersonSessions': {
    verb: 'отозвал',
    rest: 'сессии: {subject}',
    noun: 'отзыв сессий',
  },
  'settings.revokeAccess': { verb: 'отозвал', rest: 'доступ: {subject}', noun: 'отзыв доступа' },
  'admin.issueToken': { verb: 'выдал', rest: 'токен агенту «{subject}»', noun: 'выдача токена' },
  'admin.revokeToken': {
    verb: 'отозвал',
    rest: 'токен агента «{subject}»',
    noun: 'отзыв токена',
  },
  'settings.addModel': { verb: 'добавил', rest: 'модель {subject}', noun: 'добавление модели' },
  'settings.addAccount': {
    verb: 'добавил',
    rest: 'страницу {subject}',
    noun: 'добавление страницы',
  },
  'plan.updateNorm': { verb: 'изменил', rest: 'норму {subject}', noun: 'изменение нормы' },
  'admin.updateIntegration': {
    verb: 'переключил',
    rest: '{subject}',
    noun: 'изменение интеграции',
  },
  'settings.connectIntegration': {
    verb: 'настроил',
    rest: '{subject}',
    noun: 'настройка интеграции',
  },
  'admin.updateThreshold': { verb: 'задал', rest: 'порог {subject}', noun: 'изменение порога' },
  'admin.removeThreshold': { verb: 'убрал', rest: 'порог {subject}', noun: 'удаление порога' },
  'settings.pauseQueue': {
    verb: 'переключил',
    rest: 'очередь «{subject}»',
    noun: 'пауза очереди',
  },
  'principal.reset_password': { verb: 'сбросил', rest: 'пароль: {subject}', noun: 'сброс пароля' },
  'principal.create': { verb: 'завёл', rest: 'владельца: {subject}', noun: 'заведение владельца' },
  bootstrap: { verb: 'выполнил', rest: 'начальную настройку', noun: 'начальная настройка' },
}

/** «Что» of the journal filter by the action's prefix: route keys are `area.name`. */
const AREA_PREFIXES: readonly [JournalArea, readonly string[]][] = [
  ['inbox', ['inbox.', 'legacy.']],
  ['catalog', ['objects.', 'objectFiles.', 'objectBatch.', 'markup.']],
  ['plan', ['plan.']],
  ['check', ['check.']],
  ['orders', ['orders.']],
  ['promo', ['promo.']],
  ['settings', ['settings.', 'admin.']],
  ['system', ['auth.', 'principal.', 'work.', 'bootstrap']],
]

export function areaOf(action: string): JournalArea {
  for (const [area, prefixes] of AREA_PREFIXES) {
    if (prefixes.some((prefix) => action.startsWith(prefix))) return area
  }
  return 'system'
}

/** `LIKE` patterns of an area for the SQL filter. */
export function areaPatterns(area: JournalArea): string[] {
  const prefixes = AREA_PREFIXES.find(([candidate]) => candidate === area)?.[1] ?? []
  return prefixes.map((prefix) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`)
}

export interface LogRow {
  action: string
  actor_type: 'human' | 'agent' | 'system'
  actor_label: string
  gender: Gender | null
  subject_label: string
  before: unknown
  after: unknown
  result: JournalEvent['result']
}

/**
 * Field → value of a `before`/`after` document: an object, or `[field, value]` pairs where the
 * order matters (jsonb sorts object keys): «Фуп · вт» before «Фуп · чт».
 */
function snapshot(value: unknown): Map<string, string> {
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.filter(
        (pair): pair is [string, unknown] => Array.isArray(pair) && typeof pair[0] === 'string',
      )
    : typeof value === 'object' && value !== null
      ? Object.entries(value)
      : []
  return new Map(
    entries.flatMap(([key, item]): [string, string][] =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? [[key, String(item)]]
        : [],
    ),
  )
}

/** A snapshot in its own order, for `before`/`after` of an `action` row. */
export function orderedFields(fields: Snapshot): [string, string][] {
  return Object.entries(fields)
}

/** «было → стало» of the fields that differ; a new object has «—» before. */
export function changesOf(before: unknown, after: unknown): JournalEvent['changes'] {
  const was = snapshot(before)
  const now = snapshot(after)
  const fields = [...new Set([...now.keys(), ...was.keys()])]
  return fields.flatMap((field) => {
    const left = was.get(field) ?? '—'
    const right = now.get(field) ?? '—'
    return left === right ? [] : [{ field, before: left, after: right }]
  })
}

export function describeEvent(row: LogRow): Pick<JournalEvent, 'phrase' | 'changes'> {
  const wording = WORDING[row.action]
  if (row.result !== 'ok' && row.action === 'auth.signIn') {
    return { phrase: `Вход не удался: ${row.subject_label}`, changes: [] }
  }
  if (row.result !== 'ok') {
    return { phrase: `${row.actor_label}: ${wording?.noun ?? row.action}`, changes: [] }
  }
  if (!wording) {
    return {
      phrase: `${row.actor_label}: ${row.action}`,
      changes: changesOf(row.before, row.after),
    }
  }
  const rest = wording.rest.replace('{subject}', row.subject_label)
  return {
    phrase: `${row.actor_label} ${pastVerb(wording.verb, row.gender)} ${rest}`,
    changes: changesOf(row.before, row.after),
  }
}
