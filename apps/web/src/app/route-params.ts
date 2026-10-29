import {
  AccountCodeSchema,
  IsoWeekSchema,
  ItemIdSchema,
  LocalDateSchema,
  ModelCodeSchema,
} from '@contentops/contracts'
import { notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { LibrarySectionSlugSchema } from '@/screens/library/search'
import { SettingsTabSchema } from '@/screens/settings/settings-tabs'

/**
 * Проверка сегментов адреса. Неверный сегмент — это 404 на месте поля (DESIGN §3.10),
 * а не падение экрана: разбор бросает `notFound()`.
 */
function segment<Schema extends z.ZodType<string>>(schema: Schema) {
  return (value: string): z.output<Schema> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw notFound()
    }
    return parsed.data
  }
}

/** Идентификаторы записей, которые приходят из API как есть: заказ, группа, случай. */
const RecordIdSchema = z.string().regex(/^[\w.:-]+$/)

export const parseSegment = {
  model: segment(ModelCodeSchema),
  section: segment(LibrarySectionSlugSchema),
  itemId: segment(ItemIdSchema),
  date: segment(LocalDateSchema),
  week: segment(IsoWeekSchema),
  account: segment(AccountCodeSchema),
  settingsTab: segment(SettingsTabSchema),
  recordId: segment(RecordIdSchema),
}
