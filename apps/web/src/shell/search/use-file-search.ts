import type { FileSearchResult, ModelCode } from '@contentops/contracts'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { useFileSearch } from '@/data/search'
import { hashFile } from '@/lib/hash-file'
import { carriesFiles } from '../upload/use-file-drag'
import { setFileOverSearch } from './file-drop-store'

export type FileSearchState =
  | { kind: 'idle' }
  | { kind: 'hashing'; name: string; share: number }
  | { kind: 'asking'; name: string }
  | { kind: 'done'; name: string; result: FileSearchResult }
  | { kind: 'failed'; name: string }

/**
 * Поиск по файлу (DESIGN §4.7): файл бросают на строку поиска — «Отпустите — найдём такой же
 * файл», хэш считается в фоне с долей в строке, итог — «Этот файл: …» или «Такого файла нет».
 * Брошенный сюда файл не уходит в загрузку.
 */
export function useFileSearchDrop(model: ModelCode) {
  const search = useFileSearch(model)
  const [over, setOver] = useState(false)
  const [state, setState] = useState<FileSearchState>({ kind: 'idle' })
  const depth = useRef(0)
  const running = useRef<AbortController | null>(null)

  const leave = () => {
    depth.current = 0
    setOver(false)
    setFileOverSearch(false)
  }

  // Отпустили мимо строки или нажали Esc посреди перетаскивания: подсветка гаснет.
  useEffect(() => {
    window.addEventListener('drop', leave, { capture: true })
    window.addEventListener('dragend', leave, { capture: true })
    return () => {
      window.removeEventListener('drop', leave, { capture: true })
      window.removeEventListener('dragend', leave, { capture: true })
      running.current?.abort()
    }
  }, [])

  const start = async (file: File) => {
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    const name = file.name
    setState({ kind: 'hashing', name, share: 0 })
    try {
      const sha256 = await hashFile(
        file,
        (share) =>
          setState((current) => (current.kind === 'hashing' ? { ...current, share } : current)),
        controller.signal,
      )
      setState({ kind: 'asking', name })
      const result = await search(sha256, controller.signal)
      if (!controller.signal.aborted) setState({ kind: 'done', name, result })
    } catch {
      if (!controller.signal.aborted) setState({ kind: 'failed', name })
    }
  }

  const clear = () => {
    running.current?.abort()
    running.current = null
    setState({ kind: 'idle' })
  }

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth.current += 1
      setOver(true)
      setFileOverSearch(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) {
        setOver(false)
        setFileOverSearch(false)
      }
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      leave()
      const file = event.dataTransfer.files[0]
      if (file) void start(file)
    },
  }

  return { over, state, handlers, clear }
}
