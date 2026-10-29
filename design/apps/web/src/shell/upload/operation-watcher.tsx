import { useEffect } from 'react'
import { useOperation } from '@/data/operations'
import type { OperationEntry, OperationUpdate } from './upload-store'

interface OperationWatcherProps {
  entry: OperationEntry
  onChange: (update: OperationUpdate) => void
}

/**
 * Следит за одной долгой сборкой (202) и переносит её ход в лоток; у готовой — файл,
 * который отдаёт «Скачать».
 */
export function OperationWatcher({ entry, onChange }: OperationWatcherProps) {
  const operation = useOperation(entry.model, entry.id).data
  useEffect(() => {
    if (
      operation &&
      (operation.progress !== entry.progress ||
        operation.state !== entry.state ||
        operation.label !== entry.label)
    ) {
      const result = operation.result
      onChange({
        id: entry.id,
        label: operation.label,
        progress: operation.progress,
        state: operation.state,
        download:
          result?.download_url && result.file_name
            ? { url: result.download_url, fileName: result.file_name, sizeBytes: result.size_bytes }
            : undefined,
      })
    }
  }, [operation, entry.id, entry.label, entry.progress, entry.state, onChange])
  return null
}
