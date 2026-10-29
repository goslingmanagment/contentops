import {
  AccountCodeSchema,
  FanNameSchema,
  ItemIdSchema,
  MarkupStateSchema,
  PpvKindSchema,
  RawPurposeSchema,
} from '@contentops/contracts'
import { z } from 'zod'
import { SearchFlagSchema, SearchListSchema, ViewParamSchema } from '@/app/search-params'
import { ordersSearchShape } from '@/screens/orders/search'

/** Разделы-типы, открытые одним адресом `#/<модель>/library/<раздел>`. */
export const LIBRARY_SECTION_SLUGS = ['ppv', 'fyp', 'sets', 'sextings', 'life', 'raw'] as const
export const LibrarySectionSlugSchema = z.enum(LIBRARY_SECTION_SLUGS)
export type LibrarySectionSlug = z.infer<typeof LibrarySectionSlugSchema>

/** Корень Библиотеки (DESIGN §4.1): только крупная плитка и список, сортировки нет. */
export const LibraryRootViewSchema = z.enum(['large', 'list'])
export type LibraryRootView = z.infer<typeof LibraryRootViewSchema>

export const libraryRootSearchSchema = z.object({
  view: LibraryRootViewSchema.optional().catch(undefined),
})

/** «Дата ▾»: пришло за неделю, месяц, три месяца, год. */
export const PeriodSchema = z.enum(['week', 'month', 'quarter', 'year'])
export type Period = z.infer<typeof PeriodSchema>

const flag = SearchFlagSchema.optional().catch(undefined)

/**
 * Фильтры каталога в адресе (DESIGN §2.4, §4.2) — те же имена, что у
 * `GET /api/v1/<модель>/items`: `?where=lora-2:no&kind=dm`. Общие чипы и чипы по типу.
 */
export const catalogFilterShape = {
  /** «Где залито ▾»: `lora-2:no`, `lora-1:yes`, можно дважды. */
  where: SearchListSchema.optional().catch(undefined),
  tag: SearchListSchema.optional().catch(undefined),
  markup: MarkupStateSchema.optional().catch(undefined),
  period: PeriodSchema.optional().catch(undefined),
  /** «Второй человек». */
  second: flag,
  /** PPV: «Бандл» / «В личку». */
  kind: PpvKindSchema.optional().catch(undefined),
  /** PPV: «Без тизера», «Без фото». */
  noteaser: flag,
  nophotos: flag,
  /** FYP: «Версий нет на ▾». */
  nover: AccountCodeSchema.optional().catch(undefined),
  /** FYP: «SteadyContent». */
  steady: flag,
  /** Кастомы: «Имя: есть / нет / не знаю», «Фото-кастомы». */
  name: FanNameSchema.optional().catch(undefined),
  photo: flag,
  /** Сеты: «Не отобран». */
  unpicked: flag,
  /** Лайф: «Без назначения», «В ленту» / «В чаты». */
  unassigned: flag,
  use: z.enum(['feed', 'chats']).optional().catch(undefined),
  /** Сырьё: «Назначение ▾». */
  purpose: RawPurposeSchema.optional().catch(undefined),
}

export const CatalogFiltersSchema = z.object(catalogFilterShape)
export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>

/**
 * Вид, сортировка и фильтры раздела живут в адресе (`?where=lora-2:no&kind=dm&view=grid`),
 * просмотр поверх сетки — тоже (`?preview=PPV-073`): «Назад» его закрывает.
 */
export const librarySectionSearchSchema = z.object({
  view: ViewParamSchema.optional().catch(undefined),
  /** `number`, `arrived`, `stale:lora-2`, `best:lora-1` — варианты зависят от типа. */
  sort: z.string().optional().catch(undefined),
  preview: ItemIdSchema.optional().catch(undefined),
  ...catalogFilterShape,
})

/** «Кастомы»: вид раздела или «Заказы» и «Переделка в PPV» (`?view=orders`, `?view=to-ppv`). */
export const CustomsViewSchema = z.enum(['large', 'grid', 'list', 'orders', 'to-ppv'])

export const customsSearchSchema = librarySectionSearchSchema.extend({
  view: CustomsViewSchema.optional().catch(undefined),
  ...ordersSearchShape,
})

export const notUploadedSearchSchema = z.object({
  /** Вкладка страницы: `?page=lora-2`. */
  page: z.string().optional().catch(undefined),
  view: ViewParamSchema.optional().catch(undefined),
  /** Раскрыта группа «Фупы». */
  fyp: flag,
  /** Показано и то, что уже стоит в плане на эту страницу. */
  planned: flag,
  ...catalogFilterShape,
})
