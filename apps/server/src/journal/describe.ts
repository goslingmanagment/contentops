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
  'settings.addAgent': { verb: 'добавил', rest: 'агента «{subject}»', noun: 'добавление агента' },
  'settings.updateAgent': { verb: 'изменил', rest: 'агента «{subject}»', noun: 'изменение агента' },
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
  // Catalog (stage 2а): `{subject}` is «название PPV-073», «PPV-073».
  'objects.updateField': { verb: 'изменил', rest: '{subject}', noun: 'правка разметки' },
  'objects.confirmMarkup': {
    verb: 'подтвердил',
    rest: 'разметку {subject}',
    noun: 'подтверждение разметки',
  },
  'objects.setFlags': { verb: 'изменил', rest: 'отметки {subject}', noun: 'изменение отметок' },
  'objects.addLink': { verb: 'добавил', rest: 'связь {subject}', noun: 'новая связь' },
  'objects.confirmLink': {
    verb: 'подтвердил',
    rest: 'связь {subject}',
    noun: 'подтверждение связи',
  },
  'objects.removeLink': { verb: 'убрал', rest: 'связь {subject}', noun: 'удаление связи' },
  'objects.changeType': { verb: 'сменил', rest: 'тип {subject}', noun: 'смена типа' },
  'objects.remove': { verb: 'удалил', rest: '{subject}', noun: 'удаление' },
  'objects.restore': { verb: 'вернул', rest: '{subject}', noun: 'возврат' },
  'objectFiles.reorder': { verb: 'переставил', rest: 'файлы {subject}', noun: 'новый порядок' },
  'objectFiles.pick': { verb: 'изменил', rest: 'отбор {subject}', noun: 'отбор кадров' },
  'objectFiles.assign': {
    verb: 'изменил',
    rest: 'назначение кадров {subject}',
    noun: 'назначение кадров',
  },
  'objectFiles.setPurpose': {
    verb: 'изменил',
    rest: 'назначение {subject}',
    noun: 'назначение съёмки',
  },
  'objectFiles.remove': { verb: 'убрал', rest: 'файлы из {subject}', noun: 'удаление файлов' },
  'objectFiles.merge': { verb: 'слил', rest: '{subject}', noun: 'слияние' },
  'objectFiles.extractShoot': { verb: 'выделил', rest: '{subject}', noun: 'выделение съёмки' },
  'objectBatch.tags': { verb: 'изменил', rest: 'теги {subject}', noun: 'правка тегов' },
  'objectBatch.secondPerson': {
    verb: 'изменил',
    rest: 'отметку «второй человек» {subject}',
    noun: 'отметка «второй человек»',
  },
  'settings.updateTag': { verb: 'изменил', rest: 'тег {subject}', noun: 'правка тега' },
  'settings.mergeTag': { verb: 'слил', rest: 'тег {subject}', noun: 'слияние тегов' },
  'fixtures.seed': { verb: 'завёл', rest: '{subject} (фикстура)', noun: 'фикстура' },
  // Promo (stage 4в): `{subject}` is «PRM-015»; contractors by name.
  'promo.create': { verb: 'завёл', rest: 'подборку {subject}', noun: 'новая подборка' },
  'promo.add': { verb: 'добавил', rest: 'материалы в {subject}', noun: 'добавление в промо' },
  'promo.remove': { verb: 'убрал', rest: 'материалы из {subject}', noun: 'удаление из промо' },
  'promo.prepareHandoff': {
    verb: 'начал',
    rest: 'готовить передачу {subject}',
    noun: 'подготовка передачи',
  },
  'promo.markSent': { verb: 'отметил', rest: 'передачу {subject}', noun: '«Передано»' },
  'settings.addContractor': {
    verb: 'добавил',
    rest: 'подрядчика {subject}',
    noun: 'добавление подрядчика',
  },
  'settings.updateContractor': {
    verb: 'изменил',
    rest: 'формат подрядчика {subject}',
    noun: 'формат подрядчика',
  },
  // Orders (stage 4б): `{subject}` is «Кастом «вся в красном»».
  'orders.create': { verb: 'завёл', rest: 'заказ: {subject}', noun: 'новый заказ' },
  'orders.update': { verb: 'изменил', rest: 'заказ: {subject}', noun: 'правка заказа' },
  'orders.markPart': { verb: 'отметил', rest: 'часть заказа: {subject}', noun: 'отметка части' },
  'orders.linkDelivery': { verb: 'привязал', rest: 'сдачу к заказу: {subject}', noun: 'сдача' },
  'orders.retractDelivery': {
    verb: 'отвязал',
    rest: 'сдачу от заказа: {subject}',
    noun: 'отвязка сдачи',
  },
  'orders.addRevision': { verb: 'добавил', rest: 'правку: {subject}', noun: 'правка' },
  'orders.completeRevision': {
    verb: 'отметил',
    rest: 'правку выполненной: {subject}',
    noun: 'выполнение правки',
  },
  'orders.reopenRevision': { verb: 'переоткрыл', rest: 'правку: {subject}', noun: 'правка снова' },
  'orders.addMessage': {
    verb: 'добавил',
    rest: 'сообщение к заказу: {subject}',
    noun: 'сообщение',
  },
  'orders.close': { verb: 'закрыл', rest: 'заказ: {subject}', noun: 'закрытие заказа' },
  'orders.cancel': { verb: 'снял', rest: 'заказ: {subject}', noun: 'снятие заказа' },
}

/** Why an object is in «Недавние»: «правка разметки», «подтверждение разметки». */
export function reasonOf(action: string): string {
  return WORDING[action]?.noun ?? action
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
