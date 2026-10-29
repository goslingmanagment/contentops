import { formatBytes, formatNumber, type InboxGroup, needsOwnAccept } from '@contentops/contracts'
import { groupsWord } from './accept-texts'

/**
 * «Принять N» берёт только готовые: тип выбран и номер можно выдать. «Похоже на
 * исправление» пакет не трогает: новая версия мастера и закрытая правка — только после
 * того, как ролик посмотрели и приняли по одной (§4.8).
 */
export function isAcceptable(group: InboxGroup): boolean {
  return (
    group.state.kind === 'ready' &&
    group.accept_block === null &&
    group.fields.type !== null &&
    !needsOwnAccept(group)
  )
}

/**
 * Сливаются только готовые группы одного вида (§4.8): мастер, который не собрался, или
 * архив, который ещё качается, в чужую пачку не вливаются.
 */
export function canMergeGroups(groups: readonly InboxGroup[]): boolean {
  const [first] = groups
  return (
    first !== undefined &&
    groups.length >= 2 &&
    groups.every(
      (group) =>
        group.state.kind === 'ready' &&
        group.fields.type !== null &&
        group.fields.type === first.fields.type,
    )
  )
}

/**
 * Что можно сделать с несколькими выбранными группами (DESIGN §3.3): «Принять N» —
 * только готовые, «Тип ▾» — у «Что это?», «Куда видео ▾» — у «Видео среди фото»,
 * «Слить N» — готовые одного вида. Неприменимые кнопки не показываются.
 */
export interface BatchModel {
  acceptable: readonly InboxGroup[]
  whatIsIt: readonly InboxGroup[]
  videoInSet: readonly InboxGroup[]
  canMerge: boolean
  rejectable: readonly InboxGroup[]
}

function hasDecision(group: InboxGroup, decision: 'what_is_it' | 'video_in_set'): boolean {
  return group.state.kind === 'decision' && group.state.decision === decision
}

export function batchModelOf(groups: readonly InboxGroup[]): BatchModel {
  return {
    acceptable: groups.filter(isAcceptable),
    whatIsIt: groups.filter((group) => hasDecision(group, 'what_is_it')),
    videoInSet: groups.filter((group) => hasDecision(group, 'video_in_set')),
    canMerge: canMergeGroups(groups),
    rejectable: groups.filter(
      (group) => group.state.kind !== 'accepted' && group.state.kind !== 'rejected',
    ),
  }
}

/** «5 групп · 275 фото · 1,2 ГБ» — сводка выбранного в панели. */
export function batchSummary(groups: readonly InboxGroup[]): string {
  const files = groups.flatMap((group) => group.files)
  const photos = files.filter((file) => file.media === 'photo').length
  const videos = files.length - photos
  const bytes = groups.reduce((sum, group) => sum + group.size_bytes, 0)
  return [
    groupsWord(groups.length),
    photos > 0 ? `${formatNumber(photos)} фото` : null,
    videos > 0 ? `${formatNumber(videos)} видео` : null,
    formatBytes(bytes),
  ]
    .filter((part) => part !== null)
    .join(' · ')
}
