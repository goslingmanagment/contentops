import {
  type Account,
  type AccountCode,
  type CatalogEntry,
  ITEM_TYPE_INFO,
  type ItemType,
  type LocalDate,
  type SurfaceKind,
} from '@contentops/contracts'
import type { ItemGroup } from '@contentops/ui/components/grouped-virtual-grid'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'
import { backlogWithoutFyp, type PageBacklog } from '../shared/not-uploaded-index'

/** Число на вкладке страницы — без фупов, как у папки на корне. */
export function backlogCount(backlog: PageBacklog): number {
  return backlogWithoutFyp(backlog).length
}

export interface BacklogGroup extends ItemGroup<CatalogEntry> {
  kind: ItemType | 'planned'
  /** Сколько в группе по фильтрам; у свёрнутых фупов плиток нет, число есть. */
  total: number
  collapsed: boolean
}

/** Заголовок группы: фупы здесь называются словами чаттеров, как в DESIGN §4.3. */
export function groupLabel(kind: BacklogGroup['kind']): string {
  if (kind === 'planned') {
    return 'Уже в плане'
  }
  return kind === 'fyp' ? 'Фупы' : ITEM_TYPE_INFO[kind].folder
}

interface GroupOptions {
  filter: (entries: readonly CatalogEntry[]) => CatalogEntry[]
  showFyp: boolean
  showPlanned: boolean
}

/**
 * Группы сетки: пустые по фильтрам не показываются; фупы последними и свёрнуты, пока их
 * не раскрыли; «Уже в плане» — только по нажатию на ссылку внизу.
 */
export function backlogGroups(
  backlog: PageBacklog,
  { filter, showFyp, showPlanned }: GroupOptions,
): BacklogGroup[] {
  const groups: BacklogGroup[] = []
  for (const [type, entries] of backlog.byType) {
    const visible = filter(entries)
    if (visible.length === 0) {
      continue
    }
    const collapsed = type === 'fyp' && !showFyp
    groups.push({
      key: type,
      kind: type,
      items: collapsed ? [] : visible,
      total: visible.length,
      collapsed,
    })
  }
  const planned = showPlanned ? filter(backlog.planned) : []
  if (planned.length > 0) {
    groups.push({
      key: 'planned',
      kind: 'planned',
      items: planned,
      total: planned.length,
      collapsed: false,
    })
  }
  return groups
}

/**
 * Куда подставить в окне «В план»: у всех выбранных одно место — vault у PPV, секстингов
 * и лайфа, стена у сетов, фуп у фупов; у смешанного выбора окно решает само.
 */
export function surfaceFor(entries: readonly CatalogEntry[]): SurfaceKind | undefined {
  const surfaces = new Set(entries.map((entry) => SURFACE_BY_TYPE[entry.type]))
  const [only] = surfaces
  return surfaces.size === 1 ? only : undefined
}

/**
 * Окно «В план» из «Ещё не залито» (DESIGN §6.5): страница вкладки, куда по типу и
 * сегодня — «Fansly 2 · vault · сегодня → Поставить 2».
 */
export function backlogPlanPreset(
  account: AccountCode,
  entries: readonly CatalogEntry[],
  today: LocalDate,
): PlanDialogPreset {
  return { accounts: [account], surface: surfaceFor(entries), date: today }
}

const SURFACE_BY_TYPE: Record<ItemType, SurfaceKind | undefined> = {
  ppv: 'vault',
  sexting: 'vault',
  life: 'vault',
  set: 'wall',
  fyp: 'fyp',
  custom: undefined,
  raw: undefined,
  promo: undefined,
}

/** Страница вкладки из адреса; без неё или с чужой — первая страница модели. */
export function accountOfTab(
  accounts: readonly Account[],
  page: string | undefined,
): Account | undefined {
  return accounts.find((account) => account.code === page) ?? accounts[0]
}
