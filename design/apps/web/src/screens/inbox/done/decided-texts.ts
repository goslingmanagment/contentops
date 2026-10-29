import {
  type ActorRef,
  formatClock,
  formatDate,
  formatNumber,
  type InboxGroup,
  type LocalDate,
  lowerFirst,
  mskDate,
  plural,
} from '@contentops/contracts'
import { groupSource } from '../shared/group-source'

/** Слова «Решённого» (DESIGN §4.10): кто принял, откуда, сколько осталось до удаления. */

type Accepted = Extract<InboxGroup['state'], { kind: 'accepted' }>
type Rejected = Extract<InboxGroup['state'], { kind: 'rejected' }>

/** «Диана», «агент приёмки», «при загрузке · Диана», «сам (дубль)». */
function acceptedBy(state: Accepted): string {
  if (state.how === 'duplicate') {
    return 'сам (дубль)'
  }
  if (state.how === 'upload') {
    return `при загрузке · ${state.by.name}`
  }
  return actorName(state.by)
}

function actorName(actor: ActorRef): string {
  if (actor.type === 'system') {
    return 'сам'
  }
  return actor.type === 'agent' ? lowerFirst(actor.name) : actor.name
}

/** «22.09 11:40», в другом году — «22.09.2025 11:40». */
function when(instant: string, today: LocalDate): string {
  return `${formatDate(mskDate(instant), today)} ${formatClock(instant)}`
}

export function acceptedTitle(group: InboxGroup, state: Accepted): string {
  if (state.how === 'duplicate') {
    const target = state.file_key ? `${state.item_id}/${state.file_key}` : state.item_id
    return `${group.title} → уже есть ${target}`
  }
  return `${state.item_id} · ${group.fields.title || group.title}`
}

/** Откуда пришло: «из 1. PPV/…» моноширинным, загрузка через браузер — обычным серым. */
export function acceptedSource(group: InboxGroup): { text: string; path: boolean } {
  const source = groupSource(group)
  return source.path ? { text: `из ${source.text.replaceAll(' / ', '/')}`, path: true } : source
}

export function acceptedLine(state: Accepted, today: LocalDate): string {
  return `принял: ${acceptedBy(state)} · ${when(state.at, today)}`
}

/** «не контент: скриншот · Диана · 04.09 12:00»; без причины звено опускается. */
export function rejectedLine(state: Rejected, today: LocalDate): string {
  return [state.reason, actorName(state.by), when(state.at, today)].filter(Boolean).join(' · ')
}

/** «осталось 12 дней». */
export function daysLeft(state: Rejected): string {
  const days = state.days_left
  return `${plural(days, ['остался', 'осталось', 'осталось'])} ${formatNumber(days)} ${plural(days, ['день', 'дня', 'дней'])}`
}
