import {
  type AcceptCommand,
  DECISION_LABEL,
  type DraftErrorKind,
  type InboxGroup,
  type ReadyNote,
} from '@contentops/contracts'

/**
 * Кнопки панели решения (DESIGN §4.8): главная сверху, под ней «Дополнить…» и
 * «Отклонить…», ещё ниже одна строка — причина, если главная недоступна, или вторая
 * дорога («Принять отдельно»). У ▲ главная кнопка — то, что чинит беду.
 *
 * Вторая дорога не принимает сразу: она переключает панель на «отдельным объектом» —
 * появляется форма черновика, а главная кнопка принимает новым объектом. Обратная ссылка
 * возвращает к цели.
 */

export type PrimaryKind = 'accept' | 'retry' | 'wait' | 'reupload' | 'substitute'
export type SecondaryKind = 'extend' | 'reject' | 'keep_in_catalog'

export interface DraftActionModel {
  primary: { kind: PrimaryKind; label: string; enabled: boolean; command: AcceptCommand }
  secondary: readonly SecondaryKind[]
  note:
    | { kind: 'reason'; text: string }
    /** Переключить панель: `separate` — принять новым объектом, иначе — к цели. */
    | { kind: 'switch'; label: string; separate: boolean }
    | null
}

const DEFAULT: AcceptCommand = { as: 'default' }
const AS_IS: AcceptCommand = { as: 'default', as_is: true }
const SEPARATE: AcceptCommand = { as: 'separate' }
const REGULAR: readonly SecondaryKind[] = ['extend', 'reject']

const ACCEPT_LABEL: Record<ReadyNote['kind'], string> = {
  new: 'Принять',
  extends: 'Принять',
  order_part: 'Принять как сдачу',
  fix_of: 'Принять как исправление',
  promo: 'Принять',
}

/** Вторая дорога у «готово»: дополнение и исправление можно принять новым объектом. */
const ALTERNATIVE: Partial<Record<ReadyNote['kind'], string>> = {
  extends: 'Отдельным объектом',
  fix_of: 'Принять отдельно',
}

/** Главная кнопка, когда выбрана вторая дорога. */
const SEPARATE_LABEL: Partial<Record<ReadyNote['kind'], string>> = {
  extends: 'Принять отдельным объектом',
  fix_of: 'Принять отдельно',
}

/** Обратная ссылка к цели: «Дополнить SET-074», «Как исправление CUS-195». */
function backToTarget(note: ReadyNote): string {
  if (note.kind === 'extends') {
    return `Дополнить ${note.item_id}`
  }
  return note.kind === 'fix_of' ? `Как исправление ${note.item_id}` : 'Назад'
}

const ERROR_PRIMARY: Record<DraftErrorKind, { kind: PrimaryKind; label: string }> = {
  master_failed: { kind: 'retry', label: 'Повторить' },
  source_broken: { kind: 'accept', label: 'Принять как есть' },
  archive_unreadable: { kind: 'retry', label: 'Повторить' },
  vanished: { kind: 'wait', label: 'Ждать' },
  upload_failed: { kind: 'reupload', label: 'Загрузить заново' },
}

function blockedAccept(reason: string): DraftActionModel {
  return {
    primary: { kind: 'accept', label: 'Принять', enabled: false, command: DEFAULT },
    secondary: REGULAR,
    note: { kind: 'reason', text: reason },
  }
}

export function draftActionsOf(group: InboxGroup, separate = false): DraftActionModel {
  const state = group.state
  switch (state.kind) {
    case 'ready': {
      if (group.accept_block) {
        return blockedAccept(group.accept_block)
      }
      if (group.fields.type === null) {
        return blockedAccept('Сначала выберите тип')
      }
      const alternative = ALTERNATIVE[state.note.kind]
      const apart = separate ? SEPARATE_LABEL[state.note.kind] : undefined
      if (apart) {
        return {
          primary: { kind: 'accept', label: apart, enabled: true, command: SEPARATE },
          secondary: REGULAR,
          note: { kind: 'switch', label: backToTarget(state.note), separate: false },
        }
      }
      return {
        primary: {
          kind: 'accept',
          label: ACCEPT_LABEL[state.note.kind],
          enabled: true,
          command: DEFAULT,
        },
        secondary: REGULAR,
        note: alternative ? { kind: 'switch', label: alternative, separate: true } : null,
      }
    }
    case 'decision':
      if (state.decision === 'substitute_montage') {
        return {
          primary: { kind: 'substitute', label: 'Подставить', enabled: true, command: DEFAULT },
          secondary: ['keep_in_catalog'],
          note: null,
        }
      }
      return blockedAccept(group.accept_block ?? DECISION_LABEL[state.decision])
    case 'error':
      return {
        primary: {
          ...ERROR_PRIMARY[state.error],
          enabled: true,
          command: state.error === 'source_broken' ? AS_IS : DEFAULT,
        },
        secondary: ['reject'],
        note: null,
      }
    case 'preparing':
      return blockedAccept(group.accept_block ?? 'Готовится')
    default:
      return {
        primary: { kind: 'accept', label: 'Принять', enabled: false, command: DEFAULT },
        secondary: [],
        note: null,
      }
  }
}
