import { formatDate, type InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { useId } from 'react'
import { useToday } from '@/data/api-session'
import { useOrderList } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'
import { FieldRow } from './field-row'
import { OrderLine } from './order-line'
import type { DraftSave } from './use-draft-save'

interface OrderFieldProps {
  group: InboxGroup
  saver: DraftSave
}

/**
 * «Заказ» кастома (DESIGN §4.8, §6.6): своя загрузка становится сдачей заказа — заказ
 * выбирается здесь из открытых, и «Принять» становится «Принять как сдачу». Выбранный — строкой
 * с состоянием и частями; «Без заказа» снимает выбор. Пока ◆ «Какой заказ?» не решён, выбор
 * идёт в нём, здесь — «не выбран».
 */
export function OrderField({ group, saver }: OrderFieldProps) {
  const model = useCurrentModel().code
  const today = useToday()
  const selectId = useId()
  const orders = useOrderList(model, 'open').data?.items
  const orderId = group.fields.order_id
  const whichOrder = group.state.kind === 'decision' && group.state.decision === 'which_order'

  if (orderId) {
    return (
      <FieldRow
        label="Заказ"
        aside={
          <Button
            variant="link"
            size="inline"
            onClick={() => void saver.save({ order_id: null })}
            disabled={saver.savingField === 'order_id'}
          >
            Без заказа
          </Button>
        }
      >
        <OrderLine orderId={orderId} />
      </FieldRow>
    )
  }
  if (whichOrder) {
    return (
      <FieldRow label="Заказ">
        <span className="text-muted-foreground">не выбран</span>
      </FieldRow>
    )
  }
  return (
    <FieldRow label="Заказ" htmlFor={selectId}>
      <Select
        value=""
        onValueChange={(value) => void saver.save({ order_id: value })}
        disabled={!orders || orders.length === 0 || saver.savingField === 'order_id'}
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue
            placeholder={
              !orders ? 'Загружается…' : orders.length > 0 ? 'Без заказа' : 'Открытых заказов нет'
            }
          />
        </SelectTrigger>
        <SelectContent>
          {(orders ?? []).map((order) => (
            <SelectItem key={order.id} value={order.id}>
              «{order.title}»{order.deadline ? ` · до ${formatDate(order.deadline, today)}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  )
}
