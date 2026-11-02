import type { ItemId } from '@contentops/contracts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { useCopy } from '@/actions/use-copy'

/** Серый чип ID 13 (DESIGN §4.4); нажатие копирует ID — его вставляют в чаты и в план. */
export function IdChip({ id }: { id: ItemId }) {
  const copy = useCopy()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy(id, `Скопировано · ${id}`)}
          className="inline-flex h-6 shrink-0 items-center rounded-sm bg-secondary px-2 text-muted-foreground text-sm tabular-nums transition-colors duration-120 hover:bg-secondary-hover"
        >
          {id}
        </button>
      </TooltipTrigger>
      <TooltipContent>Скопировать ID</TooltipContent>
    </Tooltip>
  )
}
