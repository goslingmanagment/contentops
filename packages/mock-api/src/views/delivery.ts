import type { DownloadKind } from '@contentops/contracts/commands/objects'
import {
  type DeliveredFile,
  type DeliveryOptions,
  deliveryOf,
} from '@contentops/contracts/download-files'
import type { NameSlot } from '@contentops/contracts/download-name'
import { synthesizeFiles } from '../fixtures/item-files'
import type { ItemRecord, ModelWorld, PlanRowRecord } from '../fixtures/world-types'

/** Имя по строке плана: её страница, день и время, у фупа — версия строки (naming §6). */
export function rowOptions(model: ModelWorld, row: PlanRowRecord | undefined): DeliveryOptions {
  const slot: NameSlot | null = row
    ? { account: row.account, date: row.date, time: row.time }
    : null
  return { slot, uniq: row?.fyp_version?.no ?? null, model: model.model.code }
}

/** Выдача объекта заглушки: его файлы (или синтезированные из индекса) по виду скачивания. */
export function recordDelivery(record: ItemRecord, kind: DownloadKind, options: DeliveryOptions) {
  return deliveryOf(record.entry, record.files ?? synthesizeFiles(record.entry), kind, options)
}

/** Строка в образце: имя и, у кадров сета, какой кадр и обработан ли он. */
export function memberLine(member: DeliveredFile): string {
  return member.note ? `${member.name} — ${member.note}` : member.name
}
