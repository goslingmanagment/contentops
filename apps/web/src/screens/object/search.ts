import { AccountCodeSchema } from '@contentops/contracts'
import { z } from 'zod'

/** Ключ файла внутри объекта: `master`, `teaser`, `ph07`, `ed12`, `u2` (версия фупа). */
export const FileKeySchema = z.string().regex(/^[\w-]+$/)

/** Вид кадров сета: все или отобранные (DESIGN §4.5). */
export const SetFramesViewSchema = z.enum(['all', 'picked'])
export type SetFramesView = z.infer<typeof SetFramesViewSchema>

/** Фильтр файлов секстинга по меткам. */
export const SextingFlagSchema = z.enum(['extra', 'optional'])

/**
 * Объект: вкладка, раскрытая страница «где залито», вид файлов и просмотр в адресе
 * (DESIGN §2.4): `?tab=history`, `?page=lora-3`, `?view=teaser`, `?view=master&t=410`,
 * `?view=master&v=1`, `?compare=v1,v2`, `?frames=picked`.
 */
export const objectSearchSchema = z.object({
  tab: z.enum(['history']).optional().catch(undefined),
  page: AccountCodeSchema.optional().catch(undefined),
  view: FileKeySchema.optional().catch(undefined),
  t: z.number().nonnegative().optional().catch(undefined),
  v: z.number().int().positive().optional().catch(undefined),
  compare: z.enum(['v1,v2']).optional().catch(undefined),
  frames: SetFramesViewSchema.optional().catch(undefined),
  flag: SextingFlagSchema.optional().catch(undefined),
})
export type ObjectSearch = z.infer<typeof objectSearchSchema>

/**
 * Какой файл в просмотре: `?compare=v1,v2` без `view` — сравнение версий мастера
 * (DESIGN §2.4, `/lora/i/PPV-073?compare=v1,v2`), то есть тоже просмотр мастера.
 */
export function viewerKeyOf(search: Pick<ObjectSearch, 'view' | 'compare'>): string | undefined {
  return search.view ?? (search.compare ? 'master' : undefined)
}
