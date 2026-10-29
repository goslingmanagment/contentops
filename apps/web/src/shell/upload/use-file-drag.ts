import { useEffect, useEffectEvent, useState } from 'react'

/** Тащат ли файлы с диска (а не строку или плитку внутри окна). */
export function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/**
 * Файлы, которые тащат поверх окна (DESIGN §3.7). Пока их держат над окном — подсказка,
 * отпустили — `onDrop`. Счётчик входов нужен, потому что `dragleave` приходит и при
 * переходе между вложенными элементами.
 *
 * Сброс подсказки слушает `drop` и `dragend` в фазе перехвата: зона, которая сама
 * принимает файлы (слот тизера), гасит всплытие `drop`, и без перехвата счётчик
 * оставался бы ненулевым — экран так и стоял затемнённым.
 */
export function useFileDrag(onDrop: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const handleDrop = useEffectEvent(onDrop)

  useEffect(() => {
    let depth = 0
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return
      }
      depth += 1
      setDragging(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return
      }
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        setDragging(false)
      }
    }
    const onDragOver = (event: DragEvent) => {
      if (carriesFiles(event)) {
        event.preventDefault()
      }
    }
    const reset = () => {
      depth = 0
      setDragging(false)
    }
    // Всплытие доходит сюда, только если файлы не приняла зона на экране.
    const onWindowDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) {
        return
      }
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) {
        handleDrop(files)
      }
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onWindowDrop)
    window.addEventListener('drop', reset, { capture: true })
    window.addEventListener('dragend', reset, { capture: true })
    return () => {
      window.removeEventListener('drop', reset, { capture: true })
      window.removeEventListener('dragend', reset, { capture: true })
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onWindowDrop)
    }
  }, [])

  return dragging
}
