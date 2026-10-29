import type {
  Account,
  AccountCode,
  CatalogEntry,
  ItemType,
  LocalTime,
  NormKind,
  PageSummaryEntry,
  Platform,
  SurfaceKind,
  WeekNorm,
} from '@contentops/contracts'

/**
 * Правила окна «В план» (DESIGN §4.13): какие места допустимы для типа и страницы, что
 * подставлено по норме, какие страницы отмечены сразу. Считает только браузер по
 * индексу; окончательное слово — у `rows:check` на сервере.
 */

/** Порядок мест в окне: стена / фуп / vault / сториз / рассылка. */
export const SURFACE_ORDER: readonly SurfaceKind[] = ['wall', 'fyp', 'vault', 'story', 'dm']

const TYPE_SURFACES: Record<ItemType, readonly SurfaceKind[]> = {
  ppv: ['wall', 'vault', 'story', 'dm'],
  fyp: ['fyp'],
  custom: ['vault', 'dm'],
  set: ['wall', 'story'],
  sexting: ['vault', 'dm'],
  life: ['wall', 'vault', 'story'],
  raw: [],
  promo: [],
}

/** Фупов на OnlyFans нет. */
function surfaceOnPlatform(surface: SurfaceKind, platform: Platform): boolean {
  return platform === 'fansly' || surface !== 'fyp'
}

export function allowedSurfaces(type: ItemType, platform?: Platform): SurfaceKind[] {
  return TYPE_SURFACES[type].filter((surface) => !platform || surfaceOnPlatform(surface, platform))
}

/** Общее для нескольких объектов: места, допустимые для каждого. */
export function commonSurfaces(types: readonly ItemType[]): SurfaceKind[] {
  return SURFACE_ORDER.filter((surface) =>
    types.every((type) => TYPE_SURFACES[type].includes(surface)),
  )
}

export function defaultSurface(entry: CatalogEntry): SurfaceKind | null {
  if (entry.type === 'ppv') {
    return entry.ppv_kind === 'dm' ? 'vault' : 'wall'
  }
  return allowedSurfaces(entry.type)[0] ?? null
}

const SURFACE_NORM_KIND: Record<SurfaceKind, NormKind | null> = {
  wall: 'wall',
  fyp: 'fyp',
  vault: 'life_vault',
  story: 'story',
  dm: null,
}

export function normKindOf(surface: SurfaceKind): NormKind | null {
  return SURFACE_NORM_KIND[surface]
}

export function normOf(norms: readonly WeekNorm[], account: AccountCode): WeekNorm | undefined {
  return norms.find((norm) => norm.account === account)
}

/** Время из нормы страницы для места: «фуп 03:00», «стена 20:00». */
export function normTime(
  norms: readonly WeekNorm[],
  account: AccountCode,
  surface: SurfaceKind,
): LocalTime | null {
  const kind = normKindOf(surface)
  return normOf(norms, account)?.cells.find((cell) => cell.kind === kind)?.time ?? null
}

/** Норма страницы вообще ждёт такое место (хоть раз в неделю). */
export function normExpects(
  norms: readonly WeekNorm[],
  account: AccountCode,
  surface: SurfaceKind,
): boolean {
  const kind = normKindOf(surface)
  const cell = normOf(norms, account)?.cells.find((candidate) => candidate.kind === kind)
  return cell?.per_day.some((count) => count > 0) ?? false
}

/** Жёсткое правило одно: второй человек в кадре не идёт на OnlyFans (§4.13). */
export function blockedReason(entry: CatalogEntry, account: Account): string | null {
  return entry.second_person && account.platform === 'onlyfans'
    ? 'нельзя: второй человек в кадре'
    : null
}

/**
 * Почему страница в окне серая: второй человек в кадре на OnlyFans (одно жёсткое правило)
 * или место, которого у платформы нет, — фупов на OnlyFans не бывает.
 */
export function pageBlockReason(
  entries: readonly CatalogEntry[],
  account: Account,
  surface: SurfaceKind | null,
): string | null {
  const blocked = entries.map((entry) => blockedReason(entry, account)).find(Boolean)
  if (blocked) {
    return blocked
  }
  return surface === 'fyp' && account.platform === 'onlyfans' ? 'фупов на OnlyFans нет' : null
}

/** Страница уже видела объект на этом месте (любой уровень размещения) или он там в плане. */
export function alreadyThere(summary: PageSummaryEntry | undefined, surface: SurfaceKind): boolean {
  return (
    summary !== undefined &&
    (summary.placed_on.includes(surface) || summary.planned_on.includes(surface))
  )
}

interface DefaultPagesInput {
  entry: CatalogEntry
  accounts: readonly Account[]
  surface: SurfaceKind
  norms: readonly WeekNorm[]
  summaries: readonly PageSummaryEntry[]
}

/** Страницы по умолчанию: по норме и где объекта ещё нет (§4.13). */
export function defaultPages({
  entry,
  accounts,
  surface,
  norms,
  summaries,
}: DefaultPagesInput): AccountCode[] {
  return accounts
    .filter(
      (account) =>
        !blockedReason(entry, account) &&
        allowedSurfaces(entry.type, account.platform).includes(surface) &&
        normExpects(norms, account.code, surface) &&
        !alreadyThere(
          summaries.find((summary) => summary.account === account.code),
          surface,
        ),
    )
    .map((account) => account.code)
}
