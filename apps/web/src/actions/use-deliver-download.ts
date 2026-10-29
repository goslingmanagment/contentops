import type { DownloadAnswer, ModelCode, Operation } from '@contentops/contracts'
import { useCallback } from 'react'
import { useSaveFile } from '@/data/api-session'
import type { ServerFile } from '@/lib/save-file'
import { filesWord } from '@/lib/words'
import { useUploads } from '@/shell/upload/upload-context'
import { useActionToast } from './action-toast-context'
import { useWhenOperationEnds } from './when-operation-ends'

export interface DeliverOptions {
  /** Лоток, пока файл собирается (202): «Архив дня собирается», «Исходники собираются». */
  building?: string
  /** Своя полоска, когда файл отдан браузеру; по умолчанию «Скачивается · <имя>». */
  onSaved?: (files: readonly ServerFile[]) => void
  /** Долгая сборка не удалась: лоток уже пишет «не собралось», полоска — по желанию. */
  onFailed?: () => void
}

function readyFile(answer: DownloadAnswer): ServerFile | null {
  return answer.kind === 'ready'
    ? { url: answer.download_url, fileName: answer.file_name, sizeBytes: answer.size_bytes }
    : null
}

function resultFile(operation: Operation): ServerFile | null {
  const result = operation.result
  return operation.state === 'done' && result?.download_url && result.file_name
    ? { url: result.download_url, fileName: result.file_name, sizeBytes: result.size_bytes }
    : null
}

/** «Скачивается · PPV-073_birthday_master__lora-2_2026-09-22_0300.mp4», «Скачивается · 3 файла». */
export function savedMessage(files: readonly ServerFile[]): string {
  const [only] = files
  return `Скачивается · ${files.length === 1 && only ? only.fileName : filesWord(files.length)}`
}

/**
 * Один путь выдачи файла для всех «Скачать» (DESIGN §2.5, §3.7): готовый файл сразу уходит
 * браузеру (`saveFile` сеанса) и полоска называет его настоящим именем; долгая сборка (202)
 * встаёт в лоток, а когда готова — файл уходит браузеру сам, как у облачного диска.
 */
export function useDeliverDownload() {
  const saveFile = useSaveFile()
  const toast = useActionToast()
  const { trackOperation } = useUploads()
  const whenEnds = useWhenOperationEnds()

  return useCallback(
    (model: ModelCode, answers: readonly DownloadAnswer[], options: DeliverOptions = {}) => {
      const announce =
        options.onSaved ??
        ((files: readonly ServerFile[]) => toast.show({ message: savedMessage(files) }))
      const ready = answers.flatMap((answer) => readyFile(answer) ?? [])
      for (const file of ready) {
        saveFile(file)
      }
      if (ready.length > 0) {
        announce(ready)
      }
      for (const answer of answers) {
        if (answer.kind !== 'operation') {
          continue
        }
        trackOperation(model, answer.operation_id, options.building ?? 'Копия собирается')
        whenEnds(model, answer.operation_id, (operation) => {
          const file = resultFile(operation)
          if (file) {
            saveFile(file)
            announce([file])
          } else if (operation.state === 'failed') {
            options.onFailed?.()
          }
        })
      }
    },
    [saveFile, toast, trackOperation, whenEnds],
  )
}
