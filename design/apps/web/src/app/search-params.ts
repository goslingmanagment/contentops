import { DemoModeSchema, PrototypeRoleSchema } from '@contentops/contracts'
import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import { z } from 'zod'

/**
 * Параметры адреса, общие для всех экранов. Неверное значение не ломает экран, а
 * отбрасывается (`.catch`): адрес из чата с опечаткой всё равно откроется.
 */

/** Запасной вид «Фокус» (DESIGN §7.10) для сравнения с основным синим глазом. */
export const SkinSchema = z.enum(['focus'])
export type Skin = z.infer<typeof SkinSchema>

/** `?demo=`, `?as=` (DESIGN §9.1) и `?skin=` живут на корне и сохраняются при переходах. */
export const RootSearchSchema = z.object({
  demo: DemoModeSchema.optional().catch(undefined),
  as: PrototypeRoleSchema.optional().catch(undefined),
  skin: SkinSchema.optional().catch(undefined),
})
export type RootSearch = z.infer<typeof RootSearchSchema>

/** Вид раздела в адресе: `view=large|grid|list` (DESIGN §2.4, `?view=grid`). */
export const ViewParamSchema = z.enum(['large', 'grid', 'list'])
export type ViewParam = z.infer<typeof ViewParamSchema>

const TILE_VIEW: Record<ViewParam, ObjectTileView> = { large: 'large', grid: 'tile', list: 'row' }
const VIEW_PARAM: Record<ObjectTileView, ViewParam> = { large: 'large', tile: 'grid', row: 'list' }

export function tileViewOf(param: ViewParam): ObjectTileView {
  return TILE_VIEW[param]
}

export function viewParamOf(view: ObjectTileView): ViewParam {
  return VIEW_PARAM[view]
}

/**
 * Флаг в адресе: `?mine=1`. Разбор адреса маршрутизатором превращает `1` в число, ссылки
 * передают `true` — принимаются оба, на выходе `boolean`.
 */
export const SearchFlagSchema = z
  .union([z.boolean(), z.literal(1), z.literal(0), z.literal('1'), z.literal('0')])
  .transform((value) => value === true || value === 1 || value === '1')

/** Повторяемый параметр: одна строка или список (`where`, `tag`). */
export const SearchListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))
