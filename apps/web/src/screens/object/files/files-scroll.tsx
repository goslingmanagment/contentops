import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useObjectPage } from '../object-context'

const FilesScrollContext = createContext<RefObject<HTMLElement | null> | undefined>(undefined)

/** Прокрутка файлов объекта: внутри неё большие сетки рисуют только видимые ряды. */
export function useFilesScrollRef(): RefObject<HTMLElement | null> | undefined {
  return useContext(FilesScrollContext)
}

/**
 * Прокрутка файлов объекта: разделы идут друг под другом, место прокрутки живёт в
 * `history.state` — возврат из просмотра и «Назад» ставят его обратно (§3.13).
 */
export function FilesScroll({ children }: { children: ReactNode }) {
  const { detail } = useObjectPage()
  const scroll = useHistoryScroll(`object:${detail.entry.id}:scroll`)
  const ref = useRef<HTMLDivElement>(null)
  const initial = scroll.initialOffset
  useLayoutEffect(() => {
    if (initial && ref.current) {
      ref.current.scrollTop = initial
    }
  }, [initial])
  return (
    <div
      ref={ref}
      onScroll={(event) => scroll.onScrollOffsetChange(event.currentTarget.scrollTop)}
      className="-mx-7 min-h-0 flex-1 overflow-y-auto px-7 pt-1 pb-8"
    >
      <FilesScrollContext value={ref}>
        <div className="flex flex-col gap-6">{children}</div>
      </FilesScrollContext>
    </div>
  )
}
