import type {
  AccountCode,
  CatalogEntry,
  IsoWeek,
  ItemId,
  ItemType,
  SlotGap,
  WeekNorm,
} from '@contentops/contracts'
import { useCatalogIndex, usePageSummaries } from '@/data/catalog'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'
import { normExpects } from '../dialog/rules'
import { drawerSurface, spreadSurface } from './drawer-candidates'
import { type DrawerState, WeekDrawer } from './week-drawer'

interface WeekDrawerSlotProps {
  state: DrawerState
  onStateChange: (next: DrawerState) => void
  week: IsoWeek
  norms: readonly WeekNorm[]
  /** Пустые места нормы этой недели: по ним выбирается место раскладки. */
  gaps: readonly SlotGap[]
  canAct: boolean
  onOpenDialog: (items: readonly ItemId[], preset: PlanDialogPreset) => void
  onClose: () => void
}

/**
 * Ящик недели с данными: каталог и сводка по страницам из индекса, «Разложить» открывает
 * окно «В план» для нескольких объектов с этой неделей и местом.
 */
export function WeekDrawerSlot({
  state,
  onStateChange,
  week,
  norms,
  gaps,
  canAct,
  onOpenDialog,
  onClose,
}: WeekDrawerSlotProps) {
  const model = useCurrentModel()
  const catalog = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  if (!catalog.data) {
    return null
  }
  const placeOf = (type: ItemType, accounts: readonly AccountCode[]) =>
    spreadSurface(type, accounts, gaps)
  // «Разложить ▾ → Fansly 1, 2, 3 · vault»: та же платформа, норма ждёт то же место.
  const samePlacePages = (code: AccountCode, type: ItemType) => {
    const platform = model.accounts.find((account) => account.code === code)?.platform
    const surface = placeOf(type, [code])
    return model.accounts.filter(
      (account) => account.platform === platform && normExpects(norms, account.code, surface),
    )
  }
  const spread = (entries: readonly CatalogEntry[], accounts: readonly AccountCode[]) => {
    const [first] = entries
    const surface = first
      ? first.type === 'ppv'
        ? drawerSurface(first)
        : placeOf(first.type, accounts)
      : undefined
    onOpenDialog(
      entries.map((entry) => entry.id),
      { accounts, surface, week },
    )
  }
  return (
    <WeekDrawer
      state={state}
      onStateChange={onStateChange}
      accounts={model.accounts}
      catalog={catalog.data.items}
      summaries={summaries.data}
      samePlacePages={samePlacePages}
      placeOf={(type, account) => placeOf(type, [account])}
      canAct={canAct}
      onSpread={spread}
      onClose={onClose}
    />
  )
}
