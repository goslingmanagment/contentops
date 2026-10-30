import type { PlanRow } from '@contentops/contracts'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMarkActions } from '../shared/actions/use-mark-actions'
import { rememberedMarkKind, rowActionOf } from '../shared/row-action'

interface DayKeysOptions {
  /** Выбранная строка; клавиши действуют на одну строку. */
  row: PlanRow | null
  canAct: boolean
  onOpenPanel: () => void
  onUploadMontage: (row: PlanRow) => void
  /** `2` — «Отметить ▾» открывается у строки. */
  onOpenMarkMenu: (rowId: string) => void
}

/** Цифры действуют, только когда фокус в списке (DESIGN §3.12). */
function focusInList(): boolean {
  return document.activeElement?.closest('[role="listbox"]') != null
}

/**
 * Клавиши дня (DESIGN §4.11): `1` — главное действие строки («Отметить», «Отметить и
 * подтвердить», «Сверить», «Загрузить монтаж»), `2` — «Отметить ▾».
 */
export function useDayKeys({
  row,
  canAct,
  onOpenPanel,
  onUploadMontage,
  onOpenMarkMenu,
}: DayKeysOptions) {
  const marks = useMarkActions()
  const action = row ? rowActionOf(row, canAct) : null
  useKeyboardShortcut(
    { code: 'Digit1', enabled: action !== null && action.kind !== 'none' },
    () => {
      if (!row || !action || !focusInList()) {
        return
      }
      switch (action.kind) {
        case 'mark':
          marks.mark(row, action.timed ? 'posted' : rememberedMarkKind())
          return
        case 'mark_confirm':
          marks.markConfirm(row)
          return
        case 'check':
        // «Отправить»: человек сначала видит проверки Hub — в панели.
        case 'send':
          onOpenPanel()
          return
        case 'montage':
          onUploadMontage(row)
          return
        default:
          return
      }
    },
  )
  useKeyboardShortcut({ code: 'Digit2', enabled: action?.kind === 'mark' }, () => {
    if (row && focusInList()) {
      onOpenMarkMenu(row.id)
    }
  })
}
