import { type Account, isApiError, type Order } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  PanelFrame,
  type PanelFrameWidth,
  PanelMessage,
} from '@contentops/ui/components/panel-frame'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { CheckCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useOrder } from '@/data/orders'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'
import { type OrderPanelIntent, orderMenu } from '../order-menu'
import { orderTitle } from '../order-text'
import { CompleteRevisionMenu } from './complete-revision-menu'
import { OrderCardBlock } from './order-card-block'
import { OrderCloseNote } from './order-close-note'
import { OrderDeliveries } from './order-deliveries'
import { OrderFields } from './order-fields'
import { OrderMessages } from './order-messages'
import { OrderParts } from './order-parts'
import { OrderRevisions } from './order-revisions'
import { type OrderActions, useOrderActions } from './use-order-actions'
import { useOrderUpdate } from './use-order-update'

interface OrderPanelProps {
  orderId: string
  accounts: readonly Account[]
  width: PanelFrameWidth
  /** Пункт меню строки, с которым открыт заказ: форма правки или поиск сдачи. */
  intent: OrderPanelIntent | null
  onIntentHandled: () => void
  onClose: () => void
}

/**
 * Панель заказа 400 (DESIGN §4.16): карточка, поля, части, сдачи, правки, значимые
 * сообщения и «Закрыть заказ». Пока заказ идёт с сервера, панель стоит с заготовками —
 * из списка он приходит сразу.
 */
export function OrderPanel({ orderId, width, onClose, ...rest }: OrderPanelProps) {
  const model = useCurrentModel()
  const query = useOrder(model.code, orderId)
  if (query.data) {
    return <LoadedOrderPanel order={query.data} width={width} onClose={onClose} {...rest} />
  }
  if (isApiError(query.error) && query.error.status === 404) {
    return (
      <PanelMessage label="Заказ" width={width} onClose={onClose}>
        Такого заказа у {model.name_genitive} нет
      </PanelMessage>
    )
  }
  return (
    <PanelFrame
      label="Заказ"
      title={query.isError ? 'Заказ' : <Skeleton className="h-5 w-48 rounded-sm" />}
      width={width}
      onClose={onClose}
    >
      {query.isError ? (
        <ErrorLine message="Не загрузилось" onRetry={() => void query.refetch()} />
      ) : (
        <PanelSkeleton />
      )}
    </PanelFrame>
  )
}

function PanelSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <Skeleton className="h-18 rounded-xl" />
      {['buyer', 'page', 'brief', 'duration', 'wants', 'deadline'].map((field) => (
        <div key={field} className="grid grid-cols-[7rem_1fr] gap-3">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <Skeleton className="h-4 w-36 rounded-sm" />
        </div>
      ))}
    </div>
  )
}

interface LoadedOrderPanelProps extends Omit<OrderPanelProps, 'orderId'> {
  order: Order
}

/** Разделы, которые открыты в панели, сбрасываются при смене заказа. */
interface PanelSections {
  orderId: string
  adding: boolean
  linkOpen: boolean
}

function LoadedOrderPanel({
  order,
  accounts,
  width,
  intent,
  onIntentHandled,
  onClose,
}: LoadedOrderPanelProps) {
  const role = useRole()
  // Закрытый заказ только читается: правки и сдачи к нему не добавляются (§5.5).
  const editable = (role === 'owner' || role === 'manager') && order.state !== 'closed'
  const actions = useOrderActions()
  const update = useOrderUpdate(order)
  const [stored, setSections] = useState<PanelSections>({
    orderId: order.id,
    adding: false,
    linkOpen: false,
  })
  const sections =
    stored.orderId === order.id ? stored : { orderId: order.id, adding: false, linkOpen: false }
  const setAdding = (adding: boolean) => setSections({ ...sections, adding })
  const setLinkOpen = (linkOpen: boolean) => setSections({ ...sections, linkOpen })

  // Пункт меню строки открывает нужный раздел, как только заказ встал в панель.
  useEffect(() => {
    if (!intent) return
    setSections({
      orderId: order.id,
      adding: intent === 'revision',
      linkOpen: intent === 'link',
    })
    onIntentHandled()
  }, [intent, order.id, onIntentHandled])

  const openRevision = order.revisions.find((revision) => revision.done === null) ?? null
  const menu = orderMenu(order, {
    editable,
    intent: (kind) =>
      setSections({ ...sections, adding: kind === 'revision', linkOpen: kind === 'link' }),
    close: () => actions.close(order),
  })

  return (
    <PanelFrame
      label="Заказ"
      title={orderTitle(order)}
      subtitle={
        <StatusWord
          sign={order.status.sign ?? undefined}
          detail={order.status.detail}
          title={order.status.detail ? `${order.status.word} · ${order.status.detail}` : undefined}
          className="max-w-full"
        >
          {order.status.word}
        </StatusWord>
      }
      actions={editable ? mainAction(order, openRevision?.id ?? null, actions) : null}
      menu={menu}
      width={width}
      onClose={onClose}
    >
      <OrderCardBlock order={order} />
      <OrderFields
        key={order.id}
        order={order}
        accounts={accounts}
        update={update}
        editable={editable}
      />
      <OrderParts order={order} />
      <OrderDeliveries
        order={order}
        actions={actions}
        editable={editable}
        linkOpen={sections.linkOpen}
        onLinkOpenChange={setLinkOpen}
      />
      <OrderRevisions
        order={order}
        actions={actions}
        editable={editable}
        headerRevision={openRevision?.id ?? null}
        adding={sections.adding}
        onAddingChange={setAdding}
      />
      <OrderMessages order={order} />
      <OrderCloseNote order={order} />
    </PanelFrame>
  )
}

/**
 * Главная кнопка панели (DESIGN §3.4, §7.1): «Выполнена ▾» у открытой правки, «Закрыть
 * заказ», когда всё сдано. Пока ждём от модели, решать нечего — синей кнопки нет.
 */
function mainAction(order: Order, openRevision: string | null, actions: OrderActions) {
  if (openRevision) {
    return (
      <CompleteRevisionMenu
        variant="default"
        size="default"
        pending={actions.completing}
        onComplete={(basis) => actions.complete(order, openRevision, basis)}
      />
    )
  }
  if (order.state !== 'closed' && order.close_block === null) {
    return (
      <Button pending={actions.closing} onClick={() => actions.close(order)}>
        <CheckCheckIcon />
        Закрыть заказ
      </Button>
    )
  }
  return null
}
