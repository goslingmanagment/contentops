import type { AccountCode, LocalDate, LocalTime } from '../domain/common'
import type { ItemId } from '../domain/item-type'
import { deliveryOf } from '../download-files'
import { synthesizeFiles } from './item-files'
import type { ItemRecord } from './world-types'

/**
 * Имя файла, выданного по строке плана, для улик Hub «по имени файла» (naming §6): первый
 * файл «Для заливки» с кодом страницы, днём и временем строки, у фупа — `_uN`; у
 * давней выдачи — версия мастера на тот день.
 */
export function issuedNames(records: ReadonlyMap<ItemId, ItemRecord>) {
  return (
    item: ItemId,
    account: AccountCode,
    date: LocalDate,
    time: LocalTime | null,
    at: { uniq?: number; version?: number } = {},
  ): string => {
    const record = records.get(item)
    if (!record) return item
    const files = record.files ?? synthesizeFiles(record.entry)
    const delivery = deliveryOf(record.entry, files, 'platform', {
      slot: { account, date, time },
      uniq: at.uniq ?? null,
      version: at.version ?? null,
    })
    return delivery.files[0]?.name ?? delivery.name
  }
}
