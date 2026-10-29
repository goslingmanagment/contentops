import {
  type Account,
  type AccountCode,
  type CatalogEntry,
  formatNumber,
  type ItemType,
  type PageSummaryEntry,
  plural,
  type SlotGap,
  type SurfaceKind,
} from '@contentops/contracts'
import type { PageSummariesView } from '@/data/catalog'
import { allowedSurfaces, blockedReason } from '../dialog/rules'

/** Чипы типа в ящике «Ещё не залито» (DESIGN §4.12), по порядку раскладки недели. */
const DRAWER_TYPES: readonly ItemType[] = ['fyp', 'set', 'life', 'ppv', 'sexting']

const DRAWER_TYPE_FORMS: Partial<Record<ItemType, readonly [string, string, string]>> = {
  fyp: ['фуп', 'фупа', 'фупов'],
  set: ['сет', 'сета', 'сетов'],
  life: ['лайф', 'лайфа', 'лайфов'],
  ppv: ['PPV', 'PPV', 'PPV'],
  sexting: ['секстинг', 'секстинга', 'секстингов'],
}

/** «488 фупов», «12 лайфов» — число в ящике со словом. */
export function drawerCountText(type: ItemType, count: number): string {
  const forms = DRAWER_TYPE_FORMS[type]
  return forms ? `${formatNumber(count)} ${plural(count, forms)}` : formatNumber(count)
}

export const DRAWER_TYPE_LABEL: Partial<Record<ItemType, string>> = {
  fyp: 'фупы',
  set: 'сеты',
  life: 'лайф',
  ppv: 'PPV',
  sexting: 'секстинги',
}

/** Куда встаёт плитка из ящика: фуп — в ленту, сет и лайф — на стену, остальное — в vault. */
export function drawerSurface(entry: CatalogEntry): SurfaceKind {
  switch (entry.type) {
    case 'fyp':
      return 'fyp'
    case 'set':
    case 'life':
      return 'wall'
    case 'ppv':
      return entry.ppv_kind === 'dm' ? 'vault' : 'wall'
    default:
      return 'vault'
  }
}

/**
 * Куда «Разложить» ставит тип на этой неделе (§4.12): по пустым местам нормы. Лайф — в
 * vault, если на этих страницах норма ждёт на неделе лайф в vault, иначе на стену; фуп —
 * в ленту, секстинг — в vault, остальное — на стену.
 */
export function spreadSurface(
  type: ItemType,
  accounts: readonly AccountCode[],
  gaps: readonly SlotGap[],
): SurfaceKind {
  switch (type) {
    case 'fyp':
      return 'fyp'
    case 'sexting':
      return 'vault'
    case 'life':
      return gaps.some((gap) => gap.kind === 'life_vault' && accounts.includes(gap.account))
        ? 'vault'
        : 'wall'
    default:
      return 'wall'
  }
}

/** Тип, который ящик показывает для места нормы: фуп → фупы, стена → сеты. */
export function drawerTypeFor(surface: SurfaceKind | null): ItemType {
  if (surface === 'fyp') {
    return 'fyp'
  }
  return surface === 'vault' ? 'life' : 'set'
}

export function drawerTypes(account: Account): ItemType[] {
  return DRAWER_TYPES.filter((type) => allowedSurfaces(type, account.platform).length > 0)
}

function views(entries: readonly PageSummaryEntry[] | undefined): number {
  return (entries ?? []).reduce((best, entry) => Math.max(best, entry.views ?? 0), 0)
}

/**
 * Что ещё не залито на страницу: следов на ней нет, в плане тоже нет (уже поставленное
 * на эту неделю ящик не показывает). Фупы — сверху те, что лучше зашли на других
 * страницах, остальное — свежее сверху.
 */
export function drawerCandidates(
  catalog: readonly CatalogEntry[],
  summaries: PageSummariesView | undefined,
  account: Account,
  type: ItemType,
): CatalogEntry[] {
  const fresh = catalog.filter((entry) => {
    if (entry.type !== type || blockedReason(entry, account)) {
      return false
    }
    const summary = summaries?.byItem.get(entry.id)?.find((item) => item.account === account.code)
    return !summary || (summary.placed_on.length === 0 && summary.planned_on.length === 0)
  })
  return type === 'fyp'
    ? fresh.sort(
        (left, right) =>
          views(summaries?.byItem.get(right.id)) - views(summaries?.byItem.get(left.id)),
      )
    : fresh.sort((left, right) => right.arrived_on.localeCompare(left.arrived_on))
}
