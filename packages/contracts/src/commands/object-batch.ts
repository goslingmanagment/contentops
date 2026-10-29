import { z } from 'zod'
import { ItemIdSchema } from '../domain/item-type'

/** Commands for several objects of the Library at once (DESIGN §3.3, «⋯» полосы выделения). */

const ItemsSchema = z.array(ItemIdSchema).min(1)

/** «Теги…»: add and remove tags on every selected object, «по каждой записи». */
export const BatchTagsCommandSchema = z
  .object({
    items: ItemsSchema,
    add: z.array(z.string().trim().min(1)),
    remove: z.array(z.string().trim().min(1)),
  })
  .refine((command) => command.add.length + command.remove.length > 0, {
    message: 'Нечего менять',
  })
export type BatchTagsCommand = z.infer<typeof BatchTagsCommandSchema>

/**
 * «Второй человек в кадре…» for several objects. Rows on OnlyFans that are not marked yet
 * are cancelled only with consent: without it the answer is 422 with the number of rows.
 */
export const BatchSecondPersonCommandSchema = z.object({
  items: ItemsSchema,
  second_person: z.boolean(),
  cancel_onlyfans_rows: z.boolean(),
})
export type BatchSecondPersonCommand = z.infer<typeof BatchSecondPersonCommandSchema>
