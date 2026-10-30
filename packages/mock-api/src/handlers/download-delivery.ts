import type { DownloadCommand, DownloadKind } from '@contentops/contracts/commands/objects'
import type { DownloadAnswer } from '@contentops/contracts/domain/operations'
import type { Delivery } from '@contentops/contracts/download-files'
import { accountOf } from '../fixtures/facts'
import { PLATFORM_PHOTO_BYTES, PLATFORM_VIDEO_BYTES_PER_SECOND } from '../fixtures/plan-builder'
import type { ItemRecord, ModelWorld, PlanRowRecord } from '../fixtures/world-types'
import { registerSample } from '../sample-files'
import type { MockState } from '../state'
import { memberLine, recordDelivery, rowOptions } from '../views/delivery'

/** «Скачать» объекта и строки плана: имя, состав, образец и квитанция (DESIGN §4.4). */

/** «Вид копии» в образце скачивания (DESIGN §2.5, «Скачивания»). */
const SAMPLE_KIND: Record<DownloadKind, string> = {
  platform: 'Для заливки — копия для платформы',
  master: 'Мастер — исходное качество, для монтажа',
  compat: 'Копия, которая откроется везде',
  photos: 'Фото 100 % — полный размер, архив',
  fan: 'Для фана — копия для покупателя',
  source: 'Исходник — как лежит на Я.Диске',
  teaser: 'Тизер',
}

/** Копия для платформы весит по длительности, мастер и фото 100 % — как лежат. */
function memberBytes(kind: DownloadKind, file: Delivery['files'][number]['file']): number {
  const copy = kind === 'platform' || kind === 'teaser' || kind === 'fan'
  if (!copy) return file.size_bytes
  return file.media === 'video'
    ? Math.round((file.duration_s ?? 20) * PLATFORM_VIDEO_BYTES_PER_SECOND)
    : PLATFORM_PHOTO_BYTES
}

export function deliveryBytes(delivery: Delivery, kind: DownloadKind): number {
  return delivery.files.reduce((sum, member) => sum + memberBytes(kind, member.file), 0)
}

/** «Скачать»: готово сразу, если копия есть, иначе 202 и долгая операция. */
export function startDownload(
  state: MockState,
  model: ModelWorld,
  record: ItemRecord,
  command: DownloadCommand,
  row: PlanRowRecord | undefined,
): DownloadAnswer {
  const entry = record.entry
  const delivery = recordDelivery(record, command.kind, rowOptions(model, row))
  const fileName = delivery.name
  const sizeBytes = deliveryBytes(delivery, command.kind)
  const url = `/api/v1/${model.model.code}/a/${entry.id}/${command.kind}?name=${encodeURIComponent(fileName)}`
  const page = command.account ? ` · ${accountOf(model, command.account).label}` : ''
  registerSample(state, url, {
    file_name: fileName,
    kind: `${SAMPLE_KIND[command.kind]}${page}`,
    size_bytes: sizeBytes,
    source: `${entry.id} «${entry.title}» · Я.Диск: ${record.ydisk_path}`,
    meta_stripped: command.strip_metadata,
    members: delivery.archive ? delivery.files.map(memberLine) : [],
  })
  record.receipts.unshift({
    id: `rc-${entry.id}-${record.receipts.length + 1}`,
    file_name: fileName,
    by: state.actor,
    at: state.clock.now(),
    meta_stripped: command.strip_metadata,
    plan_row_id: row?.id ?? null,
  })
  const ready =
    command.kind !== 'platform' && command.kind !== 'compat'
      ? true
      : entry.type === 'fyp' || delivery.archive || (entry.duration_s ?? 0) < 60
  if (ready) return { kind: 'ready', download_url: url, file_name: fileName, size_bytes: sizeBytes }
  const compat = command.kind === 'compat'
  const operation = state.operations.start({
    model: model.model.code,
    kind: compat ? 'compat_copy' : 'platform_copy',
    label: compat
      ? `Копия, которая откроется везде, собирается · ${entry.id}`
      : `Копия для платформы собирается · ${entry.id}`,
    done_label: compat
      ? `Копия, которая откроется везде, готова · ${entry.id}`
      : `Копия для платформы готова · ${entry.id}`,
    result: { download_url: url, file_name: fileName, size_bytes: sizeBytes },
  })
  return { kind: 'operation', operation_id: operation.id, status_url: operation.status_url }
}
