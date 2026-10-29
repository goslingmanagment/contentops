import { z } from 'zod'
import { ItemIdSchema } from './item-type'
import { MarkupFieldSchema } from './markup'

/**
 * Строка папки «Разметка на проверку» (DESIGN §4.20): объект и его поля разметки с
 * версиями. Массовое «Подтвердить всю разметку» несёт ровно эти версии — то, что видел
 * человек; пришедшее позже остаётся черновиком.
 */
export const MarkupReviewItemSchema = z.object({
  item_id: ItemIdSchema,
  fields: z.array(MarkupFieldSchema),
})
export type MarkupReviewItem = z.infer<typeof MarkupReviewItemSchema>
