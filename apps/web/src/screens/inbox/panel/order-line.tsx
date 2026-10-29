import { formatDate, formatNumber, type Order } from '@contentops/contracts'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { StatusWord } from '@contentops/ui/components/status-word'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useHref } from '@/app/use-href'
import { useToday } from '@/data/api-session'
import { useOrder } from '@/data/orders'
import { useCurrentModel } from '@/shell/model/model-context'

/** Части заказа словами: «видео есть, фото 0 из 20». */
function partsText(order: Order): string | null {
  const photos = order.parts.find((part) => part.kind === 'photos')
  if (!photos || photos.required === null) {
    return null
  }
  const video = order.parts.find((part) => part.kind === 'video')
  const videoText = video ? (video.delivered > 0 ? 'видео есть' : 'видео ждём') : null
  const photoText = `фото ${formatNumber(photos.delivered)} из ${formatNumber(photos.required)}`
  return [videoText, photoText].filter(Boolean).join(', ')
}

/**
 * Заказ кастома в панели (DESIGN §4.8, §5.5): название, срок, состояние и части — видно,
 * что сдача закроет, а что останется («фото 0 из 20»).
 */
export function OrderLine({ orderId }: { orderId: string }) {
  const today = useToday()
  const model = useCurrentModel().code
  const order = useOrder(model, orderId).data
  const href = useHref()({
    to: '/$model/library/customs/orders/$order',
    params: { model, order: orderId },
  })
  if (!order) {
    return <Skeleton className="h-10 w-full rounded-md" />
  }
  const parts = partsText(order)
  return (
    <div className="flex flex-col gap-0.5">
      <UiLink href={href} className="truncate text-primary-ink underline-offset-4 hover:underline">
        «{order.title}»{order.deadline ? ` · до ${formatDate(order.deadline, today)}` : ''}
      </UiLink>
      <StatusWord sign={order.status.sign ?? undefined} detail={parts ?? order.status.detail}>
        {order.status.word}
      </StatusWord>
    </div>
  )
}
