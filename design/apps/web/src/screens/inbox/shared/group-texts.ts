import {
  DECISION_LABEL,
  type DraftErrorKind,
  type DraftHint,
  type DraftState,
  formatBytes,
  formatNumber,
  formatPercent,
  formatWhen,
  type InboxGroup,
  type Instant,
  type ItemType,
  type PreparingStage,
  type ReadyNote,
} from '@contentops/contracts'
import type { StatusKind } from '@contentops/ui/components/status-sign'

/** Слова «Приехало» (DESIGN §4.8, §5.3): тип, мета-строка, состояние, подсказки. */

/** Тип в строке группы: «Кастом · сегодня 11:02 · 1,9 ГБ». */
export const TYPE_WORD: Record<ItemType, string> = {
  ppv: 'PPV',
  fyp: 'FYP',
  custom: 'Кастом',
  set: 'Сет',
  sexting: 'Секстинг',
  life: 'Лайф',
  raw: 'Сырьё',
  promo: 'Промо',
}

/**
 * Размер группы: у архива, который ещё качается, файлов нет, и размер берётся из хода
 * скачивания («5,8 ГБ»); неизвестный или нулевой не пишется.
 */
function sizeOf(group: InboxGroup): number | null {
  if (group.size_bytes > 0) {
    return group.size_bytes
  }
  const total = group.state.kind === 'preparing' ? group.state.total_bytes : null
  return total !== null && total > 0 ? total : null
}

export function metaLine(group: InboxGroup, now: Instant): string {
  const size = sizeOf(group)
  return [
    group.fields.type ? TYPE_WORD[group.fields.type] : null,
    formatWhen(group.arrived_at, now),
    size === null ? null : formatBytes(size),
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

const GB = 1_000_000_000

/** «3,2 из 5,8 ГБ»: ход скачивания с одной цифрой после запятой, единица — один раз. */
export function bytesOf(done: number, total: number): string {
  if (total < GB) {
    return `${formatBytes(done)} из ${formatBytes(total)}`
  }
  const tenth = (bytes: number) => formatNumber(Math.floor((bytes / GB) * 10) / 10)
  return `${tenth(done)} из ${tenth(total)} ГБ`
}

type Preparing = Extract<DraftState, { kind: 'preparing' }>

const STAGE_TEXT: Record<PreparingStage, (state: Preparing) => string> = {
  discovered: (state) =>
    state.total_bytes === null ? 'качается' : `качается · ${formatBytes(state.total_bytes)}`,
  downloading: (state) =>
    state.done_bytes !== null && state.total_bytes !== null
      ? `качается ${bytesOf(state.done_bytes, state.total_bytes)}`
      : 'качается',
  preview: (state) => withShare('превью', state.progress),
  compressing: (state) => withShare('сжимается', state.progress),
  checking: () => 'проверяется',
}

function withShare(word: string, progress: number | null): string {
  return progress === null ? word : `${word} ${formatPercent(progress)}`
}

/** Короткое слово ▲ на плитке; в панели к нему добавляется подробность. */
export const ERROR_WORD: Record<DraftErrorKind, string> = {
  master_failed: 'Мастер не собрался',
  vanished: 'Пропал с Я.Диска',
  archive_unreadable: 'Архив не читается',
  upload_failed: 'Загрузка не прошла проверку',
}

/**
 * ▲ в панели — со словами, что не так: «Мастер не собрался: рассинхрон звука». У пропавшей
 * пачки и нечитаемого архива путь и размер уже стоят в шапке панели.
 */
const ERROR_DETAILED: Record<DraftErrorKind, boolean> = {
  master_failed: true,
  vanished: false,
  archive_unreadable: false,
  upload_failed: true,
}

export function errorPhrase(error: DraftErrorKind, detail: string): string {
  return ERROR_DETAILED[error] && detail ? `${ERROR_WORD[error]}: ${detail}` : ERROR_WORD[error]
}

/**
 * Что «готово» добавляет после слова (§5.3). На плитке и в строке — коротко: там решает
 * судьба группы, и слово должно влезть целиком («исправление CUS-195»).
 */
function readyDetail(
  note: ReadyNote,
  channelName: (id: string) => string,
  detailed: boolean,
): string | null {
  switch (note.kind) {
    case 'extends':
      return `дополнит ${note.item_id}`
    case 'order_part':
      return `часть заказа: ${note.part}`
    case 'fix_of':
      return `${detailed ? 'похоже на исправление' : 'исправление'} ${note.item_id}`
    case 'promo':
      return `Промо: ${channelName(note.channel)}`
    default:
      return null
  }
}

export interface GroupStateView {
  sign: StatusKind | null
  text: string
  /** Ход «готовится», 0–100: тонкая полоска под словом. */
  progress: number | null
}

/**
 * Состояние на плитке и в строке: ◆ и ▲ со словом, остальное — серым. У готовой группы с
 * уточнением плитка показывает одно уточнение («дополнит SET-074»): «готово» уже сказал
 * заголовок раздела; панель (`detailed`) пишет полностью.
 */
export function groupStateView(
  group: InboxGroup,
  channelName: (id: string) => string,
  detailed = false,
): GroupStateView {
  const state = group.state
  switch (state.kind) {
    case 'preparing':
      return {
        sign: null,
        text: STAGE_TEXT[state.stage](state),
        progress: state.progress === null ? null : Math.round(state.progress * 100),
      }
    case 'ready': {
      const detail = readyDetail(state.note, channelName, detailed)
      const changed = group.hints.some((hint) => hint.kind === 'changed_after_snapshot')
      const head = detailed ? ['готово', detail] : [detail ?? 'готово']
      const words = [...head, changed ? 'изменён после снимка' : null]
      return { sign: null, text: words.filter(Boolean).join(' · '), progress: null }
    }
    case 'decision':
      return { sign: 'turn', text: DECISION_LABEL[state.decision], progress: null }
    case 'error':
      return {
        sign: 'trouble',
        text: detailed ? errorPhrase(state.error, state.detail) : ERROR_WORD[state.error],
        progress: null,
      }
    case 'accepted':
      return { sign: 'done', text: `принято → ${state.item_id}`, progress: null }
    case 'rejected':
      return { sign: null, text: 'отклонено', progress: null }
  }
}

/** Подсказка одной строкой (вид «Список»): при нехватке места обрезается первой. */
export function hintText(hint: DraftHint): string {
  switch (hint.kind) {
    case 'row_change':
      return `было: ${hint.was} · стало: ${hint.now}`
    default:
      return hint.text
  }
}

/** Подсказка нужного вида с её полями. */
export function findHint<Kind extends DraftHint['kind']>(
  hints: readonly DraftHint[],
  kind: Kind,
): Extract<DraftHint, { kind: Kind }> | undefined {
  return hints.find((hint): hint is Extract<DraftHint, { kind: Kind }> => hint.kind === kind)
}
