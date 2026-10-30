import { isApiError, type Model, type Order, type OrderFields } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { Input } from '@contentops/ui/components/input'
import { useNavigate } from '@tanstack/react-router'
import { useId } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useOrderCreated } from '@/data/orders'
import type { NewOrderSeed } from '@/shell/dialogs/order-dialog-context'
import { useShellModel } from '@/shell/model/use-shell-model'
import { trimmed } from './form-values'
import { CardTextField } from './new-order/card-text-field'
import { OrderFormFields } from './new-order/order-form-fields'
import { useContentBelow } from './new-order/use-content-below'
import { useNewOrderForm } from './new-order/use-new-order-form'

export interface NewOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  seed: NewOrderSeed
}

/**
 * Окно «Новый заказ» / «Завести заказ из карточки» (DESIGN §3.9, §4.16, 560): вставить
 * текст карточки → поля разобраны → проверить → «Сохранить». Ссылка на сообщение
 * сохраняется, но ничего не подтягивает: Telegram-клиента в продукте нет. Если поля не
 * помещаются в окно, они прокручиваются, а подвал с кнопками отбрасывает тень.
 */
export function NewOrderDialog(props: NewOrderDialogProps) {
  // Окно живёт в оболочке, над адресом модели: модель берётся та же, что в колонке.
  const { model } = useShellModel()
  return model ? <NewOrderForm model={model} {...props} /> : null
}

function NewOrderForm({ model, open, onOpenChange, seed }: NewOrderDialogProps & { model: Model }) {
  const api = useApi()
  const toast = useActionToast()
  const navigate = useNavigate()
  const created = useOrderCreated(model.code)
  const { form } = useNewOrderForm(model)
  const urlId = useId()
  const fields = useContentBelow()

  const openOrder = (order: string) =>
    void navigate({
      to: '/$model/library/customs/orders/$order',
      params: { model: model.code, order },
    })

  const create = useIntentMutation<OrderFields, Order>({
    failed: 'Заказ не сохранился',
    run: (body, key) =>
      api.orders.create({ params: { model: model.code }, body, idempotencyKey: key }),
    onSuccess: (order) => {
      created(order, seed.inboxGroupId)
      onOpenChange(false)
      toast.show({
        message: `Заказ заведён · ${order.title}`,
        action: { label: 'Открыть', onSelect: () => openOrder(order.id) },
      })
    },
    // По уже заведённой карточке второй заказ не создаётся — открывается прежний (§4.16).
    handleFailure: (error) => {
      if (!isApiError(error) || error.code !== 'order_exists') return false
      const existing = error.body.details?.order
      if (typeof existing !== 'string') return false
      onOpenChange(false)
      toast.show({ message: 'По этой карточке заказ уже есть' })
      openOrder(existing)
      return true
    },
  })

  const submit = form.handleSubmit((fields) => create.start(fields))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-140 gap-0 p-0">
        <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle>
              {seed.inboxGroupId ? 'Завести заказ из карточки' : 'Новый заказ'}
            </DialogTitle>
            <DialogDescription>Вставьте текст карточки — поля разберутся сами</DialogDescription>
          </DialogHeader>
          <div ref={fields.scrollerRef} className="flex min-h-0 flex-col overflow-y-auto">
            <div ref={fields.contentRef} className="flex flex-col gap-4 px-6 pb-2">
              <div className="flex flex-col gap-2">
                <CardTextField form={form} />
                <label htmlFor={urlId} className="sr-only">
                  Ссылка на карточку в Telegram
                </label>
                <Input
                  id={urlId}
                  placeholder="Ссылка на карточку в Telegram"
                  aria-invalid={form.formState.errors.message_url ? true : undefined}
                  {...form.register('message_url', { setValueAs: trimmed })}
                />
                {form.formState.errors.message_url ? (
                  <p className="text-destructive text-sm">
                    {form.formState.errors.message_url.message}
                  </p>
                ) : null}
              </div>
              <div className="border-border border-t pt-4">
                <OrderFormFields form={form} accounts={model.accounts} />
              </div>
            </div>
          </div>
          <DialogFooter
            data-below={fields.below || undefined}
            className="relative px-6 pt-4 pb-6 transition-shadow duration-120 data-below:shadow-[0_-10px_16px_-10px_rgb(16_24_40/0.22)]"
          >
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" pending={create.isPending}>
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
