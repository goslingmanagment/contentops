import { DOWNLOAD_KIND_LABEL, type DownloadKind } from '@contentops/contracts/commands/objects'
import type { Gender } from '@contentops/contracts/domain/common'
import { DECISION_LABEL, type DecisionKind } from '@contentops/contracts/domain/inbox'
import { ITEM_TYPE_INFO, type ItemType } from '@contentops/contracts/domain/item-type'
import type { JournalArea, JournalEvent } from '@contentops/contracts/domain/journal'
import { formatNumber, pastVerb, plural } from '@contentops/contracts/format'

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
  /** Facts of `after` that finish the sentence: «72 файла», «новый объект, 21 файл». */
  tail?: (after: Map<string, string>, raw: unknown) => string | null
}

const files = (n: string | undefined) =>
  n === undefined || Number.isNaN(Number(n))
    ? null
    : `${formatNumber(Number(n))} ${plural(Number(n), ['файл', 'файла', 'файлов'])}`

const quoted = (value: string | undefined) => (value ? `«${value}»` : null)

const joined = (...parts: (string | null | undefined)[]) =>
  parts.filter((part): part is string => Boolean(part)).join(', ') || null

/** «Как» of an acceptance: «новый объект PPV-044» → «новый объект», «дополнение SET-074» stays. */
const acceptTail = (after: Map<string, string>) =>
  joined(
    after.get('Как')?.replace(/^новый объект .*/, 'новый объект'),
    files(after.get('Файлов')),
    after.get('Принято'),
    after.has('Дублей') ? `дублей ${after.get('Дублей')}` : null,
  )

const downloadTail = (after: Map<string, string>) => {
  const kind = DOWNLOAD_KIND_LABEL[after.get('kind') as DownloadKind]
  return joined(
    kind ? kind.charAt(0).toLowerCase() + kind.slice(1) : null,
    after.get('strip_metadata') === 'false' ? 'метаданные оставлены' : null,
  )
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
  // Plan (4а): `{subject}` is «PPV-073 · Fansly 1 · стена 22.09 20:00».
  'plan.createRows': { verb: 'поставил', rest: 'в план {subject}', noun: 'постановка в план' },
  'plan.createRelease': { verb: 'поставил', rest: 'выпуск: {subject}', noun: 'выпуск PPV' },
  'plan.undoCreate': { verb: 'удалил', rest: 'строку {subject}', noun: 'удаление строки' },
  'plan.updateRow': { verb: 'изменил', rest: 'строку {subject}', noun: 'правка строки' },
  'plan.mark': { verb: 'отметил', rest: '{subject}', noun: 'отметка' },
  'plan.markMany': { verb: 'отметил', rest: '{subject}', noun: 'отметка' },
  'plan.markConfirm': {
    verb: 'подтвердил',
    rest: 'вручную {subject}',
    noun: 'ручное подтверждение',
  },
  'plan.markConfirmMany': {
    verb: 'подтвердил',
    rest: 'вручную {subject}',
    noun: 'ручное подтверждение',
  },
  'plan.unmark': { verb: 'снял', rest: 'отметку {subject}', noun: 'снятие отметки' },
  'plan.cancel': { verb: 'отменил', rest: 'строку {subject}', noun: 'отмена строки' },
  'plan.move': { verb: 'переставил', rest: 'строку {subject}', noun: 'перенос строки' },
  'plan.download': { verb: 'скачал', rest: 'архив плана {subject}', noun: 'архив плана' },
  'objects.alreadyUploaded': {
    verb: 'отметил',
    rest: 'залитым {subject}',
    noun: 'уже залито',
  },
  'objects.uploadNow': {
    verb: 'поставил',
    rest: 'на сегодня {subject} · залить сейчас',
    noun: 'залить сейчас',
  },
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
  'objectFiles.extractShoot': {
    verb: 'выделил',
    rest: '{subject}',
    noun: 'выделение в новый объект',
  },
  'objectFiles.move': { verb: 'перенёс', rest: 'файлы {subject}', noun: 'перенос файлов' },
  'objectFiles.copyOf': { verb: 'отметил', rest: 'копии в {subject}', noun: 'отметка копий' },
  'objectFiles.notContent': {
    verb: 'отклонил',
    rest: 'файлы {subject} как не контент',
    noun: 'не контент',
  },
  'objectFiles.masterVersion': {
    verb: 'сделал',
    rest: 'новую версию мастера {subject}',
    noun: 'новая версия мастера',
  },
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
  // Legacy import (stage 3): the runs, their inputs and the reserve the pass writes.
  'legacy.parse': { verb: 'запустил', rest: 'разбор старых имён', noun: 'разбор старых имён' },
  'legacy.plan': { verb: 'запустил', rest: 'сухой прогон импорта', noun: 'сухой прогон' },
  'legacy.inputs': {
    verb: 'изменил',
    rest: 'входы импорта: реестр PPV и альбомы vault',
    noun: 'входы импорта',
  },
  'legacy.reserve': {
    verb: 'записал',
    rest: 'старые номера и поднял счётчики: {subject}',
    noun: 'резерв номеров',
  },
  'legacy.bytes': {
    verb: 'запустил',
    rest: 'импорт файлов старого Я.Диска',
    noun: 'импорт файлов',
  },
  'legacy.reconcile': {
    verb: 'запустил',
    rest: 'сверку импорта со снимком диска',
    noun: 'сверка импорта',
  },
  'legacy.resolve': {
    verb: 'решил',
    rest: 'спор старого корпуса: {subject}',
    noun: 'спор импорта',
  },
  'legacy.unclear': {
    verb: 'отложил',
    rest: 'спор старого корпуса как неясный: {subject}',
    noun: 'спор импорта',
  },
  'legacy.saveLabels': {
    verb: 'подтвердил',
    rest: 'метку старых имён «{subject}»',
    noun: 'метка старых имён',
    tail: (after) => (after.get('Страница') ? `→ ${after.get('Страница')}` : null),
  },
  'legacy.settle_by_hand': {
    verb: 'разобрал',
    rest: 'вручную заявку старого имени {subject}',
    noun: 'разбор заявки',
  },
  'legacy.placements': {
    verb: 'записал',
    rest: 'размещения из старых имён',
    noun: 'размещения из старых имён',
    tail: (after) =>
      after.get('Новых размещений') ? `новых: ${after.get('Новых размещений')}` : null,
  },
  'legacy.accept': {
    verb: 'перенёс',
    rest: '{subject} со старого Я.Диска',
    noun: 'перенос со старого Я.Диска',
    tail: (after) =>
      joined(
        quoted(after.get('Откуда')),
        after.get('Старый номер') && after.get('Старый номер') !== '—'
          ? `старый номер ${after.get('Старый номер')}`
          : null,
      ),
  },
  'legacy.pack': {
    verb: 'записал',
    rest: 'прошлую передачу промо: {subject}',
    noun: 'прошлая передача',
  },
  // Приёмка: `{subject}` is the group's title or a word of the action.
  'draft.accept': { verb: 'принял', rest: '{subject}', noun: 'принятие', tail: acceptTail },
  'draft.accept_on_upload': {
    verb: 'принял',
    rest: '{subject}',
    noun: 'принятие при загрузке',
    tail: acceptTail,
  },
  'inbox.accept': { verb: 'принял', rest: '{subject}', noun: 'принятие' },
  'inbox.acceptMany': { verb: 'принял', rest: '{subject}', noun: 'принятие пачкой' },
  'draft.alias': {
    verb: 'записал',
    rest: 'дубль: такой файл уже есть в {subject}',
    noun: 'дубль',
  },
  'draft.copy': {
    verb: 'записал',
    rest: 'копию: такой ролик уже есть в {subject}',
    noun: 'копия ролика',
  },
  'inbox.update': { verb: 'изменил', rest: 'черновик «{subject}»', noun: 'правка черновика' },
  'inbox.files': {
    verb: 'изменил',
    rest: 'роли и порядок файлов «{subject}»',
    noun: 'роли файлов',
  },
  'inbox.download': { verb: 'скачал', rest: 'исходник «{subject}»', noun: 'скачивание исходника' },
  'inbox.decide': {
    verb: 'решил',
    rest: 'вопрос в «Приехало»',
    noun: 'решение в «Приехало»',
    tail: (after) => quoted(DECISION_LABEL[after.get('decision') as DecisionKind]),
  },
  'inbox.setType': {
    verb: 'сменил',
    rest: 'тип: {subject}',
    noun: 'смена типа черновиков',
    tail: (after) => ITEM_TYPE_INFO[after.get('type') as ItemType]?.noun ?? null,
  },
  'inbox.merge': {
    verb: 'слил',
    rest: 'группы в «Приехало»',
    noun: 'слияние групп',
    tail: (after) => (after.get('Групп') ? `${after.get('Групп')} в одну` : null),
  },
  'inbox.split': {
    verb: 'выделил',
    rest: 'файлы в новую группу',
    noun: 'выделение в новую группу',
    tail: (after) => files(after.get('Файлов')),
  },
  'inbox.reject': {
    verb: 'отклонил',
    rest: 'группу в «Приехало»',
    noun: 'отклонение',
    tail: (after) =>
      joined(
        files(after.get('Файлов')),
        after.get('Причина') && after.get('Причина') !== '—' ? after.get('Причина') : null,
      ),
  },
  'inbox.retry': { verb: 'повторил', rest: 'скачивание: {subject}', noun: 'повтор скачивания' },
  'inbox.restore': {
    verb: 'вернул',
    rest: 'группу в работу',
    noun: 'возврат в работу',
    tail: (after) => files(after.get('Файлов')),
  },
  'inbox.upload': { verb: 'загрузил', rest: 'файлы', noun: 'загрузка' },
  'upload.inbox': {
    verb: 'загрузил',
    rest: 'файлы',
    noun: 'загрузка',
    tail: (after) =>
      joined(files(after.get('Файлов')), after.get('Куда') ? `→ ${after.get('Куда')}` : null),
  },
  // Объект: `{subject}` is «PPV-073».
  'objects.saveFrameCheck': {
    verb: 'сохранил',
    rest: 'проверку кадров {subject}',
    noun: 'проверка кадров',
  },
  'objects.download': { verb: 'скачал', rest: '{subject}', noun: 'скачивание', tail: downloadTail },
  'objectFiles.download': {
    verb: 'скачал',
    rest: 'файлы {subject}',
    noun: 'скачивание',
    tail: downloadTail,
  },
  'objects.makePpv': { verb: 'сделал', rest: 'PPV из {subject}', noun: 'PPV из объекта' },
  'objectFiles.makePhotos': {
    verb: 'сделал',
    rest: 'фото из кадров {subject}',
    noun: 'фото из кадров',
  },
  'objectFiles.makeCover': { verb: 'сделал', rest: 'обложку {subject}', noun: 'обложка' },
  'objectFiles.buildFypVersions': {
    verb: 'запустил',
    rest: 'сборку версий {subject}',
    noun: 'версии фупа',
  },
  'objectFiles.makeMaster': {
    verb: 'сделал',
    rest: 'мастер из файлов {subject}',
    noun: 'мастер из сырья',
  },
  // План: `{subject}` is «PPV-073 · Fansly 1 · стена 22.09 20:00».
  'plan.checkRow': { verb: 'проверил', rest: 'строку {subject}', noun: 'проверка строки' },
  'plan.prepare': { verb: 'подготовил', rest: 'публикацию {subject}', noun: 'подготовка в Hub' },
  'plan.prepareMany': {
    verb: 'подготовил',
    rest: 'публикацию {subject}',
    noun: 'подготовка в Hub',
  },
  'plan.send': { verb: 'отправил', rest: 'в Hub {subject}', noun: 'отправка в Hub' },
  'plan.sendMany': { verb: 'отправил', rest: 'в Hub {subject}', noun: 'отправка в Hub' },
  'plan.cancelPublication': {
    verb: 'отменил',
    rest: 'публикацию {subject}',
    noun: 'отмена публикации',
  },
  // Сверка: `check.decide` keeps the decision in words — «Сверка: «Это оно»».
  'check.decide': { verb: 'решил', rest: '{subject}', noun: 'решение сверки' },
  'check.confirmPair': { verb: 'подтвердил', rest: 'пару в сверке', noun: '«Это оно»' },
  'check.reject': { verb: 'отклонил', rest: 'пару в сверке', noun: '«Не то»' },
  'check.bind': { verb: 'привязал', rest: 'пост без плана', noun: 'привязка поста' },
  'check.outside': { verb: 'отметил', rest: 'пост «Не наше»', noun: '«Не наше»' },
  'check.undo': { verb: 'отменил', rest: 'решение сверки', noun: 'отмена решения' },
  'check.confirmUnambiguous': {
    verb: 'подтвердил',
    rest: 'однозначные пары',
    noun: 'однозначные пары',
  },
  'orders.parseCard': { verb: 'разобрал', rest: 'карточку заказа', noun: 'разбор карточки' },
  'settings.addAiService': { verb: 'добавил', rest: 'поставщика ИИ {subject}', noun: 'ИИ' },
  'settings.updateAiService': { verb: 'изменил', rest: 'поставщика ИИ {subject}', noun: 'ИИ' },
  'settings.updateAiBudget': { verb: 'изменил', rest: 'бюджет ИИ {subject}', noun: 'бюджет ИИ' },
  'settings.resumeAi': { verb: 'возобновил', rest: 'ИИ {subject}', noun: 'возобновление ИИ' },
  'admin.verifyBlobs': { verb: 'запустил', rest: 'проверку байтов', noun: 'проверка байтов' },
  'admin.pauseQueue': { verb: 'переключил', rest: 'очередь «{subject}»', noun: 'пауза очереди' },
}

/** Why an object is in «Недавние»: «правка разметки», «подтверждение разметки». */
export function reasonOf(action: string): string {
  return WORDING[action]?.noun ?? action
}

/** «Что» of the journal filter by the action's prefix: route keys are `area.name`. */
const AREA_PREFIXES: readonly [JournalArea, readonly string[]][] = [
  ['inbox', ['inbox.', 'legacy.', 'draft.', 'upload.', 'source.']],
  ['catalog', ['objects.', 'objectFiles.', 'objectBatch.', 'markup.']],
  ['plan', ['plan.']],
  ['check', ['check.', 'hub.']],
  ['orders', ['orders.']],
  ['promo', ['promo.']],
  ['settings', ['settings.', 'admin.', 'policy.', 'integration.', 'agent.', 'person.']],
  ['system', ['auth.', 'principal.', 'work.', 'bootstrap', 'repair.', 'smoke.', 'fixtures.']],
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

/** Keys some writers keep in machine form, in words for «было → стало». */
const FIELD_WORD: Record<string, string> = {
  kind: 'Что',
  strip_metadata: 'Стереть метаданные',
  outcome: 'Итог',
  attempt: 'Попытка',
  generation: 'Поколение',
  error_code: 'Ошибка',
  decision: 'Решение',
  split: 'Разделить',
  type: 'Тип',
  title: 'Название',
  raw_purpose: 'Назначение',
  item: 'Объект',
  role: 'Роль',
  login: 'Логин',
  display_name: 'Имя',
  plan_row: 'Строка плана',
  zip: 'Архив',
  code: 'Код',
  status: 'Статус',
}

const VALUE_WORD: Record<string, string> = { true: 'да', false: 'нет' }

/** «было → стало» of the fields that differ; a new object has «—» before. */
export function changesOf(before: unknown, after: unknown): JournalEvent['changes'] {
  const was = snapshot(before)
  const now = snapshot(after)
  const fields = [...new Set([...now.keys(), ...was.keys()])]
  const word = (value: string) => VALUE_WORD[value] ?? value
  return fields.flatMap((field) => {
    const left = word(was.get(field) ?? '—')
    const right = word(now.get(field) ?? '—')
    return left === right ? [] : [{ field: FIELD_WORD[field] ?? field, before: left, after: right }]
  })
}

/**
 * The work queue's own bookkeeping (`work.<outcome>` of the runner, schema §9.3): hundreds of
 * thousands of rows a day nobody reads. The journal shows them only to «Кто: система»; the
 * literal is the predicate of the index `action_log_feed` — keep both the same.
 */
export const SERVICE_ACTION_PATTERN = 'work.%'

export function isServiceAction(action: string): boolean {
  return action.startsWith('work.')
}

/** Who a system row speaks for: the role of a process in words, never `worker-video`. */
const SYSTEM_NAME: Record<string, { name: string; gender: Gender }> = {
  worker: { name: 'Обработка файлов', gender: 'f' },
  'worker-video': { name: 'Обработка видео', gender: 'f' },
  'worker-image': { name: 'Обработка фото', gender: 'f' },
  scan: { name: 'Скан источника', gender: 'm' },
  import: { name: 'Импорт', gender: 'm' },
  импорт: { name: 'Импорт', gender: 'm' },
  hub: { name: 'Hub', gender: 'm' },
  ops: { name: 'Консоль ВМ', gender: 'f' },
  'smoke-setup': { name: 'Консоль ВМ', gender: 'f' },
  bootstrap: { name: 'Начальная настройка', gender: 'f' },
  seed: { name: 'Фикстуры', gender: 'm' },
}

/** Acceptance by a process is the import of the old corpus (`legacy/auto-accept.ts`). */
const IMPORT_ACTIONS = new Set(['draft.accept', 'legacy.accept', 'draft.alias'])

export function actorOf(row: Pick<LogRow, 'actor_type' | 'actor_label' | 'gender' | 'action'>): {
  name: string
  gender: Gender | null
} {
  if (row.actor_type !== 'system') return { name: row.actor_label, gender: row.gender }
  if (IMPORT_ACTIONS.has(row.action)) return { name: 'Импорт', gender: 'm' }
  return SYSTEM_NAME[row.actor_label] ?? { name: 'Система', gender: 'f' }
}

/** Kinds of works in words, for the rows of «Кто: система». */
const WORK_KIND: Record<string, string> = {
  scan: 'скан источника',
  fetch: 'скачивание с диска',
  hash: 'хэш файла',
  unpack_archive: 'распаковка архива',
  import_parse: 'разбор старых имён',
  register: 'регистрация байтов',
  propose: 'подсказки приёмки',
  export: 'сборка архива',
  hub_sync: 'получение из Hub',
  hub_history: 'проход по истории Hub',
  hub_publish: 'публикация через Hub',
  annotate: 'разметка',
  verify_blobs: 'проверка байтов',
  backup: 'бэкап',
  derive_video: 'превью видео',
  encode_master: 'сжатие мастера',
  verify_master: 'проверка мастера',
  render: 'копия для платформы',
  uniq_render: 'версия фупа',
  render_compat: 'копия, которая откроется везде',
  extract_frame: 'кадр из видео',
  derive_image: 'превью фото',
}

const WORK_OUTCOME: Record<string, string> = {
  succeeded: 'готово',
  retry: 'повтор после сбоя',
  failed: 'ошибка, попытки кончились',
  deferred: 'отложено, ждёт место или другую работу',
  returned: 'возвращено в очередь',
  paused: 'на паузе: выключатель',
}

function workPhrase(row: LogRow, after: Map<string, string>): string {
  const kind = after.get('kind') ?? row.subject_label.split(':')[0] ?? ''
  const outcome = row.action.slice('work.'.length)
  const what = WORK_KIND[kind] ?? kind
  const attempt = after.get('attempt')
  return [
    `${what.charAt(0).toUpperCase()}${what.slice(1)}: ${WORK_OUTCOME[outcome] ?? outcome}`,
    attempt && Number(attempt) > 1 ? `попытка ${attempt}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** System events that speak for themselves, without an actor in front (DESIGN §4.18). */
const SYSTEM_PHRASE: Record<string, (row: LogRow, after: Map<string, string>) => string> = {
  'hub.ads_hidden': (row, after) =>
    `Скрыто как реклама: ${after.get('скрыто как реклама') ?? '?'} ${plural(Number(after.get('скрыто как реклама') ?? 0), ['пост', 'поста', 'постов'])} · ${row.subject_label}${after.get('день') ? ` за ${after.get('день')}` : ''}`,
  'source.loss': (row) => `Пропал с источника: ${row.subject_label}`,
  'source.scan': (row) => `Скан источника: ${row.subject_label}`,
  'source.freeze': (row) => `Снимок диска: ${row.subject_label}`,
  'hub.sync': (row) => `Получение из Hub: ${row.subject_label}`,
  'hub.sync.failed': (row) => `Получение из Hub не удалось: ${row.subject_label}`,
  'hub.sync.rebuilt': (row) => `Hub: данные страницы собраны заново · ${row.subject_label}`,
  'hub.history': (row) => `Проход по истории Hub: ${row.subject_label}`,
  'hub.history.enqueue': (row) => `Проход по истории Hub поставлен в очередь: ${row.subject_label}`,
  'hub.match': (row) => `Автосверка Hub: ${row.subject_label}`,
  'hub.publish.checks': (row) => `Проверки публикации Hub: ${row.subject_label}`,
  'policy.ops': (row) => `Из консоли ВМ задано: ${row.subject_label}`,
  'integration.ops': (row) => `Из консоли ВМ переключено: ${row.subject_label}`,
  'agent.ops': (row, after) =>
    after.has('Токен')
      ? `Из консоли ВМ выдан токен агенту «${row.subject_label}»`
      : `Из консоли ВМ изменён агент «${row.subject_label}»`,
  'smoke.setup': (row) => `Из консоли ВМ заведены смоук-проверки: ${row.subject_label}`,
  'person.ops': (row) => `Из консоли ВМ заведён человек: ${row.subject_label}`,
  'contractor.ops': (row) => `Из консоли ВМ заведён подрядчик: ${row.subject_label}`,
  'upload.purge': (row) => `Из консоли ВМ удалены байты загрузки: ${row.subject_label}`,
  'repair.secondPersonUnchecked': (row) =>
    `Из консоли ВМ: второй человек в кадре снова «не проверено» у ${row.subject_label} ${plural(Number(row.subject_label), ['объекта', 'объектов', 'объектов'])}`,
  'repair.shotOnFromExif': (row) =>
    `Из консоли ВМ: дата съёмки из EXIF записана у ${row.subject_label} ${plural(Number(row.subject_label), ['объекта', 'объектов', 'объектов'])}`,
  bootstrap: () => 'Начальная настройка выполнена',
  'principal.create': (row) => `Заведён владелец: ${row.subject_label}`,
  'legacy.reserve': (row) => `Записаны старые номера, счётчики подняты: ${row.subject_label}`,
}

/** Codes of refusals in words: «нет прав», not `forbidden`. */
const PROBLEM_WORD: Record<string, string> = {
  forbidden: 'нет прав',
  unauthenticated: 'не выполнен вход',
  version_conflict: 'данные уже изменили',
  precondition_required: 'нет версии данных',
  not_found: 'не найдено',
  invalid_request: 'неверный запрос',
  idempotency_conflict: 'повтор с другим запросом',
  internal: 'сбой сервера',
}

export function describeEvent(row: LogRow): Pick<JournalEvent, 'phrase' | 'changes'> {
  const wording = WORDING[row.action]
  const after = snapshot(row.after)
  const actor = actorOf(row)
  if (row.result !== 'ok' && row.action === 'auth.signIn') {
    return { phrase: `Вход не удался: ${row.subject_label}`, changes: [] }
  }
  if (row.result !== 'ok') {
    const word = row.result === 'denied' ? 'отказ' : 'ошибка'
    const what = wording?.noun ?? nounOfArea(row.action)
    const why = PROBLEM_WORD[after.get('code') ?? '']
    return { phrase: `${actor.name}: ${word} — ${what}${why ? `: ${why}` : ''}`, changes: [] }
  }
  const changes = changesOf(row.before, row.after)
  if (isServiceAction(row.action)) return { phrase: workPhrase(row, after), changes }
  const own = row.actor_type === 'system' ? SYSTEM_PHRASE[row.action] : undefined
  if (own) return { phrase: own(row, after), changes }
  if (!wording) {
    // A kind with no words yet still reads as a sentence, never as `area.name`.
    return { phrase: `${actor.name}: ${nounOfArea(row.action)} · ${row.subject_label}`, changes }
  }
  const rest = wording.rest.replace('{subject}', row.subject_label)
  const tail = wording.tail?.(after, row.after) ?? null
  return {
    phrase: `${actor.name} ${pastVerb(wording.verb, actor.gender)} ${rest}${tail ? `: ${tail}` : ''}`,
    changes,
  }
}

/** «действие в приёмке» — the area of an action without words of its own. */
function nounOfArea(action: string): string {
  return `действие в разделе «${AREA_WORD[areaOf(action)]}»`
}

const AREA_WORD: Record<JournalArea, string> = {
  inbox: 'Приехало',
  catalog: 'Библиотека',
  plan: 'План',
  check: 'Сверка',
  orders: 'Заказы',
  promo: 'Промо',
  settings: 'Настройки',
  system: 'Система',
}
