import { formatBytes, formatNumber, formatPercent, plural } from '@contentops/contracts'
import type { UploadTrayItem } from '@contentops/ui/components/upload-tray'
import type { ServerFile } from '@/lib/save-file'
import type { OperationEntry, UploadBatch, UploadEntry, UploadState } from './upload-store'
import { batchOf, isUploadActive } from './upload-store'

/** «1,2 из 3,4 ГБ»: единица пишется один раз, если она общая. */
export function formatBytesProgress(loaded: number, total: number): string {
  const loadedText = loaded > 0 ? formatBytes(loaded) : '0'
  const totalText = formatBytes(total)
  const unit = totalText.split(' ').at(-1) ?? ''
  const sameUnit = loadedText.endsWith(` ${unit}`)
  return `${sameUnit ? loadedText.slice(0, -unit.length - 1) : loadedText} из ${totalText}`
}

/** Итог по ответу сервера: «в Приехало · ◆ Что это?», «принято → PPV-089», «не принято: …». */
function outcomeDetail(batch: UploadBatch | undefined): string {
  const outcome = batch?.outcome
  switch (outcome?.kind) {
    case 'inbox':
      return outcome.decision ? 'в Приехало · Что это?' : 'в Приехало'
    case 'attached':
      return `принято → ${outcome.itemId}`
    case 'failed':
      return `не принято: ${outcome.message}`
    default:
      return 'проверяется'
  }
}

function uploadDetail(entry: UploadEntry, batch: UploadBatch | undefined): string {
  switch (entry.phase) {
    case 'queued':
      return 'в очереди'
    case 'uploading':
    case 'interrupted':
      return formatBytesProgress(entry.loadedBytes, entry.sizeBytes)
    case 'checking':
      return 'проверяется'
    case 'done':
    case 'failed':
      return outcomeDetail(batch)
  }
}

function uploadItem(entry: UploadEntry, batch: UploadBatch | undefined): UploadTrayItem {
  return {
    id: entry.id,
    name: entry.fileName,
    nameIsFile: true,
    detail: uploadDetail(entry, batch),
    progress: entry.sizeBytes > 0 ? (entry.loadedBytes / entry.sizeBytes) * 100 : 0,
    state:
      entry.phase === 'done'
        ? 'done'
        : entry.phase === 'failed'
          ? 'failed'
          : entry.phase === 'interrupted'
            ? 'interrupted'
            : 'running',
  }
}

/**
 * Сборка: пока идёт — «Архив дня собирается · Fansly 1» и проценты; готовая — «Архив дня
 * готов · Fansly 1», размер и «Скачать», если это файл.
 */
function operationItem(
  entry: OperationEntry,
  saveFile: (file: ServerFile) => void,
): UploadTrayItem {
  const download = entry.state === 'done' ? entry.download : undefined
  return {
    id: entry.id,
    name: entry.label,
    detail:
      entry.state === 'failed'
        ? 'не собралось'
        : entry.state === 'done'
          ? download?.sizeBytes
            ? formatBytes(download.sizeBytes)
            : 'готово'
          : formatPercent(entry.progress),
    progress: entry.progress * 100,
    state: entry.state === 'running' ? 'running' : entry.state === 'done' ? 'done' : 'failed',
    action: download ? { label: 'Скачать', onSelect: () => saveFile(download) } : undefined,
  }
}

export function trayItems(
  state: UploadState,
  saveFile: (file: ServerFile) => void,
): UploadTrayItem[] {
  return [
    ...state.uploads.map((entry) => uploadItem(entry, batchOf(state, entry))),
    ...state.operations.map((entry) => operationItem(entry, saveFile)),
  ]
}

/** «Загружается 3 из 5 · 1,2 из 3,4 ГБ», «Копия для платформы собирается · 40 %», «Загружено 5 файлов». */
export function trayTitle(state: UploadState): string {
  const active = state.uploads.filter(isUploadActive)
  // Все байты уже на месте — идёт только проверка: «Загружается 1 из 2 · 32 из 32 МБ» врёт.
  if (active.length > 0 && active.every((entry) => entry.phase === 'checking')) {
    return `Проверяется ${formatNumber(active.length)} ${plural(active.length, ['файл', 'файла', 'файлов'])}`
  }
  if (active.length > 0) {
    const total = state.uploads.length
    const current = Math.min(total, total - active.length + 1)
    const size = state.uploads.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    const loaded = state.uploads.reduce((sum, entry) => sum + entry.loadedBytes, 0)
    return `Загружается ${formatNumber(current)} из ${formatNumber(total)} · ${formatBytesProgress(loaded, size)}`
  }
  const running = state.operations.find((entry) => entry.state === 'running')
  if (running) {
    return `${running.label} · ${formatPercent(running.progress)}`
  }
  const count = state.uploads.length
  if (count > 0) {
    return `Загружено ${formatNumber(count)} ${plural(count, ['файл', 'файла', 'файлов'])}`
  }
  return 'Готово'
}
