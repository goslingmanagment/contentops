import { formatDate, type InboxGroup } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { useId } from 'react'
import { useToday } from '@/data/api-session'
import { useHubOrderList } from '@/data/hub-orders'
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
 * выбирается здесь, и «Принять» становится «Принять как сдачу». Сверху — заказы Hub в
 * производстве (пакет N: дом заказа — Hub, сдача уходит туда), ниже под «Архив» — открытые
 * заказы ContentOps до Hub. Выбранный — строкой с состоянием; «Без заказа» снимает выбор. Пока
 * ◆ «Какой заказ?» не решён, выбор идёт в нём, здесь — «не выбран».
 */
export function OrderField({ group, saver }: OrderFieldProps) {
  const model = useCurrentModel().code
  const today = useToday()
  const selectId = useId()
  const orders = useOrderList(model, 'open').data?.items
  const hubOrders = useHubOrderList(model).data?.items
  const orderId = group.fields.order_id
  const whichOrder = group.state.kind === 'decision' && group.state.decision === 'which_order'
  const count = (orders?.length ?? 0) + (hubOrders?.length ?? 0)

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
        disabled={!orders || count === 0 || saver.savingField === 'order_id'}
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue
            placeholder={
              !orders ? 'Загружается…' : count > 0 ? 'Без заказа' : 'Открытых заказов нет'
            }
          />
        </SelectTrigger>
        <SelectContent>
          {(hubOrders ?? []).length > 0 ? (
            <SelectGroup>
              <SelectLabel>Заказы Hub</SelectLabel>
              {(hubOrders ?? []).map((order) => (
                <SelectItem key={order.code} value={order.code}>
                  {order.code} · «{order.title}»
                  {order.deadline ? ` · до ${formatDate(order.deadline, today)}` : ''}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {(orders ?? []).length > 0 ? (
            <SelectGroup>
              <SelectLabel>Архив</SelectLabel>
              {(orders ?? []).map((order) => (
                <SelectItem key={order.id} value={order.id}>
                  «{order.title}»
                  {order.deadline ? ` · до ${formatDate(order.deadline, today)}` : ''}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
    </FieldRow>
  )
}
