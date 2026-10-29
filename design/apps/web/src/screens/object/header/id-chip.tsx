import type { ItemId } from '@contentops/contracts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { useActionToast } from '@/actions/action-toast-context'

/** Серый чип ID 13 (DESIGN §4.4); нажатие копирует ID — его вставляют в чаты и в план. */
export function IdChip({ id }: { id: ItemId }) {
  const toast = useActionToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      toast.show({ message: `Скопировано · ${id}` })
    } catch (error) {
      toast.showFailure(error, { failed: 'Не скопировалось' })
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex h-6 shrink-0 items-center rounded-sm bg-secondary px-2 text-muted-foreground text-sm tabular-nums transition-colors duration-120 hover:bg-secondary-hover"
        >
          {id}
        </button>
      </TooltipTrigger>
      <TooltipContent>Скопировать ID</TooltipContent>
    </Tooltip>
  )
}
