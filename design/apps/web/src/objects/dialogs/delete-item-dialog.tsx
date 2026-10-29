import {
  formatNumber,
  type ItemDetail,
  type ItemId,
  type Ok,
  type PlacementLevel,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys, useItem } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'

interface DeleteItemDialogProps {
  id: ItemId
  onClose: () => void
}

/** Строка в плане, по которой ещё ничего не отмечено: она снимется вместе с объектом. */
const UNMARKED_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'planned',
  'missed',
  'blocked_second_person',
])

function openRows(detail: ItemDetail): number {
  return detail.pages
    .flatMap((page) => page.surfaces)
    .filter((surface) => surface.plan_row_id !== null && UNMARKED_LEVELS.has(surface.verdict.level))
    .length
}

/** Подборки промо, куда объект уже положен ссылкой. */
function promoCollections(detail: ItemDetail): ItemId[] {
  return detail.provenance
    .filter((link) => link.direction === 'in' && link.item_type === 'promo')
    .map((link) => link.item_id)
}

/**
 * «Удалить…» (DESIGN §3.9): одно из трёх окон подтверждения. До нажатия видно, что станет
 * с объектом, строками плана и промо; номер не освобождается.
 */
export function DeleteItemDialog({ id, onClose }: DeleteItemDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const item = useItem(model, id)

  const remove = useIntentMutation<number, Ok>({
    failed: 'Не удалилось',
    run: (version, idempotencyKey) =>
      api.objects.remove({
        params: { model, id },
        body: { confirm: true },
        ifMatch: version,
        idempotencyKey,
      }),
    invalidates: () => itemQueryKeys(model, id),
    onSuccess: () => {
      onClose()
      toast.show({ message: `${id} удалён · его видно в «Удалённых объектах»` })
    },
  })

  const detail = item.data
  const rows = detail ? openRows(detail) : 0
  const promo = detail ? promoCollections(detail) : []

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-120">
        <DialogHeader>
          <DialogTitle>Удалить {id}?</DialogTitle>
          <DialogDescription className="sr-only">
            Что станет с объектом, планом и промо
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-base">
          <li>Объект уйдёт в «Удалённые объекты», номер {id} больше не выдаётся.</li>
          <li>
            {rows > 0
              ? `Снимутся строки плана без отметки: ${formatNumber(rows)}.`
              : 'Строк плана без отметки нет.'}
          </li>
          {promo.length > 0 ? (
            <li>
              Останется в {plural(promo.length, ['подборке', 'подборках', 'подборках'])} промо:{' '}
              {promo.join(', ')}.
            </li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={!detail}
            pending={remove.isPending}
            onClick={() => detail && remove.start(detail.version)}
          >
            Удалить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
