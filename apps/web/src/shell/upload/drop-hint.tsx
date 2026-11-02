import { SearchIcon, UploadIcon } from 'lucide-react'
import { useFileOverSearch } from '../search/file-drop-store'
import type { UploadTarget } from './upload-target'

/**
 * Подсказка поверх окна, пока над ним держат файлы (DESIGN §3.7): куда они уйдут, если
 * отпустить.
 */
export function DropHint({ target }: { target: UploadTarget | null }) {
  const search = useFileOverSearch()
  const text = search
    ? 'Отпустите — найдём такой же файл'
    : target
      ? target.kind === 'plan-row'
        ? 'Отпустите — монтаж для этой строки'
        : 'Отпустите — станет тизером или новой версией'
      : 'Отпустите — откроется загрузка'
  const Icon = search ? SearchIcon : UploadIcon
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center bg-overlay/40 p-10 duration-120 animate-in fade-in-0"
    >
      <div className="flex h-12 items-center gap-3 rounded-xl bg-popover px-5 text-base shadow-md">
        <Icon className="size-4.5 text-primary" />
        {text}
      </div>
    </div>
  )
}
