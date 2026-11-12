import {
  type Account,
  formatDate,
  formatWhen,
  type HubOrder,
  type HubOrderFile,
  type HubOrderMessage,
  isApiError,
  mskDate,
  pastVerb,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import {
  PanelFrame,
  type PanelFrameWidth,
  PanelMessage,
} from '@contentops/ui/components/panel-frame'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { cn } from '@contentops/ui/lib/utils'
import { ExternalLinkIcon } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { useHref } from '@/app/use-href'
import { useClock, useToday } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { useHubOrder } from '@/data/hub-orders'
import { useRole } from '@/data/session'
import { accountLabel } from '@/lib/words'
import { useItemCover } from '@/objects/use-item-cover'
import { useCurrentModel } from '@/shell/model/model-context'
import { FieldRow } from '../panel/field-editors'
import { LinkDeliveryPopover } from '../panel/link-delivery-popover'
import { ReasonForm } from '../panel/reason-form'
import { hubWantsText, reportWords } from './hub-order-text'
import type { HubOrderActions } from './use-hub-order-actions'

interface HubOrderPanelProps {
  code: string
  accounts: readonly Account[]
  width: PanelFrameWidth
  actions: HubOrderActions
  onClose: () => void
}

/**
 * Карточка заказа Hub (пакет N): что заказано — из Hub, файлы — из ContentOps. Заказ
 * двигают, отдают фану и закрывают в Hub; здесь к нему привязывают файлы, и Hub узнаёт об
 * этом сам. Пока сдача не дошла до Hub, карточка так и говорит.
 */
export function HubOrderPanel({ code, width, onClose, ...rest }: HubOrderPanelProps) {
  const model = useCurrentModel()
  const query = useHubOrder(model.code, code)
  if (query.data) {
    return <LoadedPanel order={query.data} width={width} onClose={onClose} {...rest} />
  }
  if (isApiError(query.error) && query.error.status === 404) {
    return (
      <PanelMessage label="Заказ" width={width} onClose={onClose}>
        Заказа {code} у {model.name_genitive} в последнем чтении Hub нет
      </PanelMessage>
    )
  }
  return (
    <PanelFrame
      label="Заказ"
      title={query.isError ? code : <Skeleton className="h-5 w-48 rounded-sm" />}
      width={width}
      onClose={onClose}
    >
      {query.isError ? (
        <ErrorLine message="Не загрузилось" onRetry={() => void query.refetch()} />
      ) : (
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-18 rounded-xl" />
          <Skeleton className="h-4 w-48 rounded-sm" />
          <Skeleton className="h-4 w-36 rounded-sm" />
        </div>
      )}
    </PanelFrame>
  )
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-primary-ink text-sm underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </a>
  )
}

interface LoadedPanelProps extends Omit<HubOrderPanelProps, 'code'> {
  order: HubOrder
}

function LoadedPanel({ order, accounts, width, actions, onClose }: LoadedPanelProps) {
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const [linkOpen, setLinkOpen] = useState(false)
  const openRevisions = order.messages.filter(
    (message) => message.kind === 'revision' && message.done_at === null,
  )
  return (
    <PanelFrame
      label="Заказ"
      title={`Кастом «${order.title}»`}
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
      actions={
        order.hub_url ? (
          <Button variant="outline" asChild>
            <a href={order.hub_url} target="_blank" rel="noreferrer">
              Открыть {order.code} в Hub
              <ExternalLinkIcon aria-hidden />
            </a>
          </Button>
        ) : null
      }
      width={width}
      onClose={onClose}
    >
      <OrderFacts order={order} accounts={accounts} />
      {openRevisions.length > 0 ? (
        <InfoSection title="Правки из Hub">
          <ul className="flex flex-col gap-2">
            {openRevisions.map((message, index) => (
              <MessageRow key={`${message.at}-${index}`} message={message} />
            ))}
          </ul>
        </InfoSection>
      ) : null}
      <FilesSection
        order={order}
        actions={actions}
        editable={editable}
        linkOpen={linkOpen}
        onLinkOpenChange={setLinkOpen}
      />
      <CardSection order={order} />
      <MessagesSection order={order} />
      <ArchiveLink order={order} />
    </PanelFrame>
  )
}

function OrderFacts({ order, accounts }: { order: HubOrder; accounts: readonly Account[] }) {
  const today = useToday()
  const done = order.parts_done.map((part) => (part === 'video' ? 'видео' : 'фото')).join(' и ')
  return (
    <InfoSection title="Заказ в Hub">
      <dl className="flex flex-col gap-2">
        <FieldRow label="Код">
          <span className="tabular-nums">{order.code}</span>
        </FieldRow>
        <FieldRow label="Страница">
          {order.account
            ? accountLabel(accounts, order.account)
            : (order.hub_page ?? <span className="text-ink-3">Hub не знает</span>)}
        </FieldRow>
        {order.buyer ? <FieldRow label="Покупатель">{order.buyer}</FieldRow> : null}
        {order.duration ? <FieldRow label="Длительность">{order.duration}</FieldRow> : null}
        <FieldRow label="Ждём">{hubWantsText(order)}</FieldRow>
        <FieldRow label="Срок">
          {order.deadline ? (
            `до ${formatDate(order.deadline, today)}`
          ) : (
            <span className="text-ink-3">не назначен</span>
          )}
        </FieldRow>
        <FieldRow label="Hub считает">
          {done ? `сдано целиком: ${done}` : <span className="text-ink-3">ничего не сдано</span>}
        </FieldRow>
      </dl>
    </InfoSection>
  )
}

const PART_WORD = { video: 'видео', photos: 'фото' } as const
const UNLINK_REASONS = ['ошибочная привязка', 'это другой заказ'] as const

function FileRow({
  order,
  file,
  actions,
  editable,
}: {
  order: HubOrder
  file: HubOrderFile
  actions: HubOrderActions
  editable: boolean
}) {
  const today = useToday()
  const now = useClock().now()
  const model = useCurrentModel().code
  const [unlinking, setUnlinking] = useState(false)
  const href = useHref()({ to: '/$model/i/$id', params: { model, id: file.item_id } })
  const title = useCatalogIndex(model).data?.byId.get(file.item_id)?.title
  const cover = useItemCover(file.item_id)
  const retracted = file.retracted
  const report = retracted ? file.retraction_report : file.report
  const words = report ? reportWords(report, now) : null
  return (
    <li className={retracted ? 'flex gap-3 opacity-60' : 'flex gap-3'}>
      <Thumb {...cover} showCaptions={false} className="w-10 shrink-0 self-start rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline justify-between gap-2">
          <UiLink href={href} className="min-w-0 truncate underline-offset-4 hover:underline">
            <span className="text-ink-3 tabular-nums">{file.item_id}</span>
            {title ? ` ${title}` : null}
          </UiLink>
          <span className="shrink-0 text-ink-3 text-sm tabular-nums">
            {PART_WORD[file.part]} · {formatDate(mskDate(file.delivered_at), today)}
          </span>
        </p>
        <p className="text-muted-foreground text-sm">
          {retracted
            ? `${pastVerb('отвязал', retracted.by.gender)}: ${retracted.by.name}${retracted.reason ? ` · ${retracted.reason}` : ''}`
            : [
                file.complete ? 'часть целиком' : 'не вся часть',
                `${pastVerb('связал', file.linked_by.gender)}: ${file.linked_by.name}`,
              ].join(' · ')}
        </p>
        {file.archive_order ? (
          <p className="text-ink-3 text-sm">в архивном заказе ContentOps, до Hub</p>
        ) : null}
        {words ? (
          <p
            className={cn(
              'text-sm',
              words.tone === 'ok' && 'text-ink-3',
              words.tone === 'wait' && 'text-attention-ink',
              words.tone === 'refused' && 'text-destructive',
            )}
          >
            {words.tone === 'ok' ? '✓ ' : null}
            {words.text}
          </p>
        ) : null}
        {editable && !retracted && !file.archive_order && !unlinking ? (
          <div>
            <Button variant="link" size="sm" onClick={() => setUnlinking(true)}>
              Отвязать…
            </Button>
          </div>
        ) : null}
        {unlinking ? (
          <ReasonForm
            label="Почему отвязываем файл — Hub получит отметку"
            choices={UNLINK_REASONS}
            submitLabel="Отвязать"
            pending={actions.unlinking}
            onCancel={() => setUnlinking(false)}
            onSubmit={(reason) => {
              actions.unlink(order, file, reason)
              setUnlinking(false)
            }}
          />
        ) : null}
      </div>
    </li>
  )
}

function FilesSection({
  order,
  actions,
  editable,
  linkOpen,
  onLinkOpenChange,
}: {
  order: HubOrder
  actions: HubOrderActions
  editable: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}) {
  const linked = useMemo(
    () => order.files.filter((file) => file.retracted === null).map((file) => file.item_id),
    [order.files],
  )
  return (
    <InfoSection
      title="Файлы в ContentOps"
      aside={
        order.pending_reports > 0 ? (
          <span className="text-attention-ink">не все в Hub</span>
        ) : undefined
      }
    >
      {order.files.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {order.files.map((file) => (
            <FileRow
              key={file.id}
              order={order}
              file={file}
              actions={actions}
              editable={editable}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Файлов пока нет</p>
      )}
      {editable ? (
        <div>
          <LinkDeliveryPopover
            linked={linked}
            open={linkOpen}
            onOpenChange={onLinkOpenChange}
            onPick={(item) => actions.link(order, item)}
            pending={actions.linking}
            label="Привязать файл…"
          />
        </div>
      ) : null}
    </InfoSection>
  )
}

const COLLAPSED_LINES = 4

function CardSection({ order }: { order: HubOrder }) {
  const [open, setOpen] = useState(false)
  const textId = useId()
  if (!order.card_text && !order.card_url) return null
  const lines = order.card_text?.split('\n').length ?? 0
  return (
    <InfoSection title="Карточка">
      {order.card_text ? (
        <div className="flex flex-col items-start gap-1.5">
          <div className="w-full rounded-xl bg-accent px-3 py-2.5 text-sm">
            <p id={textId} className={cn('whitespace-pre-line', !open && 'line-clamp-4')}>
              {order.card_text}
            </p>
          </div>
          {lines > COLLAPSED_LINES ? (
            <Button
              variant="link"
              size="sm"
              aria-expanded={open}
              aria-controls={textId}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? 'Свернуть' : 'Показать всю карточку'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {order.card_url ? <External href={order.card_url}>Карточка в Telegram</External> : null}
    </InfoSection>
  )
}

const KIND_WORD: Record<HubOrderMessage['kind'], string> = {
  repost: 'копия карточки',
  delivery: 'сдача',
  revision: 'правка',
  confirmation: 'подтверждение',
  note: 'заметка',
}

function MessageRow({ message }: { message: HubOrderMessage }) {
  const now = useClock().now()
  return (
    <li className="flex flex-col gap-0.5">
      <p className="text-ink-3 text-sm tabular-nums">
        {KIND_WORD[message.kind]}
        {message.part ? ` · ${PART_WORD[message.part]}` : ''}
        {message.author ? ` · ${message.author}` : ''}
        {message.at ? ` · ${formatWhen(message.at, now)}` : ''}
      </p>
      {message.excerpt ? <p className="text-sm">{message.excerpt}</p> : null}
      {message.url ? <External href={message.url}>в Telegram</External> : null}
    </li>
  )
}

function MessagesSection({ order }: { order: HubOrder }) {
  if (order.messages.length === 0) return null
  return (
    <InfoSection title="Сообщения заказа в Hub">
      <ul className="flex flex-col gap-3">
        {order.messages.slice(0, 12).map((message, index) => (
          <MessageRow key={`${message.at}-${index}`} message={message} />
        ))}
      </ul>
    </InfoSection>
  )
}

function ArchiveLink({ order }: { order: HubOrder }) {
  const model = useCurrentModel().code
  const href = useHref()
  if (!order.archive_order) return null
  return (
    <InfoSection title="До Hub">
      <UiLink
        href={href({
          to: '/$model/library/customs/orders/$order',
          params: { model, order: order.archive_order },
        })}
        className="text-primary-ink text-sm underline-offset-4 hover:underline"
      >
        Этот заказ в архиве ContentOps
      </UiLink>
    </InfoSection>
  )
}
