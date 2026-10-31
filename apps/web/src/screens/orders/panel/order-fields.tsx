import {
  type Account,
  FAN_NAME_CHOICES,
  FAN_NAME_LABEL,
  formatDate,
  type Order,
  type UpdateOrderCommand,
} from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { InfoSection } from '@contentops/ui/components/info-panel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { type ReactNode, useState } from 'react'
import { conflictLine } from '@/actions/use-versioned-save'
import { useClock, useToday } from '@/data/api-session'
import { accountLabel } from '@/lib/words'
import { orderedWhat, parsedDuration } from '../order-text'
import { EditTrigger, FieldRow, TextEditor, Unset } from './field-editors'
import type { OrderFieldKey, OrderUpdate } from './use-order-update'
import { WantsEditor } from './wants-editor'

interface OrderFieldsProps {
  order: Order
  accounts: readonly Account[]
  update: OrderUpdate
  editable: boolean
}

type TextField = 'buyer' | 'brief' | 'duration_raw' | 'deadline'

/** Правка текстового поля — в тело запроса; пустое значение сохраняется как «нет». */
const TEXT_PATCH: Record<TextField, (value: string | null) => UpdateOrderCommand> = {
  buyer: (value) => ({ buyer: value }),
  // ТЗ обязательно: пустое не сохраняется, остаётся прежнее.
  brief: (value) => (value ? { brief: value } : {}),
  duration_raw: (value) => ({ duration_raw: value ?? '' }),
  deadline: (value) => ({ deadline: value }),
}

/**
 * Поля заказа (DESIGN §4.16, п. 2): покупатель, страница, ТЗ, длительность исходным
 * текстом и разобранная, что ждём, срок, «Имя фана в ролике». Всё правится на месте;
 * кто правил — видно в журнале.
 */
export function OrderFields({ order, accounts, update, editable }: OrderFieldsProps) {
  const today = useToday()
  const [editing, setEditing] = useState<OrderFieldKey | null>(null)
  const now = useClock().now()

  const save = (field: OrderFieldKey, patch: UpdateOrderCommand, previous: UpdateOrderCommand) =>
    update.save({ field, patch, previous, onSaved: () => setEditing(null) })
  const cancel = () => setEditing(null)

  const conflictBelow = (field: OrderFieldKey): ReactNode => {
    const conflict = update.conflict
    if (conflict?.field !== field) return null
    const line = conflictLine(conflict.details, 'заказ', now)
    return (
      <ConflictLine
        message={line.message}
        theirsLabel={line.theirsLabel}
        onShowTheirs={() => {
          update.showTheirs()
          setEditing(null)
        }}
        onKeepMine={update.keepMine}
      />
    )
  }

  const textRow = (
    field: TextField,
    label: string,
    value: string | null,
    display: ReactNode,
    options: { multiline?: boolean; type?: 'text' | 'date'; empty?: string } = {},
  ) => (
    <FieldRow label={label} below={conflictBelow(field)}>
      {editing === field ? (
        <TextEditor
          label={label}
          initial={value ?? ''}
          multiline={options.multiline}
          type={options.type}
          pending={update.pending}
          onCancel={cancel}
          onSave={(draft) => {
            const next = draft.trim() === '' ? null : draft.trim()
            save(field, TEXT_PATCH[field](next), TEXT_PATCH[field](value))
          }}
        />
      ) : (
        <EditTrigger editable={editable} onEdit={() => setEditing(field)}>
          {value ? display : <Unset>{options.empty}</Unset>}
        </EditTrigger>
      )}
    </FieldRow>
  )

  const duration = parsedDuration(order.duration)
  const wants = orderedWhat({ ...order, duration: { ...order.duration, raw: '' } })

  return (
    <InfoSection title="Заказ">
      <dl className="flex flex-col gap-2.5">
        {order.buyer !== null || editable
          ? textRow('buyer', 'Покупатель', order.buyer, order.buyer)
          : null}
        <FieldRow label="Страница" below={conflictBelow('account')}>
          {editable ? (
            <Select
              value={order.account ?? undefined}
              onValueChange={(account) => save('account', { account }, { account: order.account })}
            >
              <SelectTrigger size="sm" aria-label="Страница" className="-ml-1">
                <SelectValue placeholder="не заполнено" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.code} value={account.code}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : order.account ? (
            accountLabel(accounts, order.account)
          ) : (
            <Unset />
          )}
        </FieldRow>
        {order.brief !== null || editable
          ? textRow('brief', 'ТЗ', order.brief, order.brief, { multiline: true })
          : null}
        {textRow(
          'duration_raw',
          'Длительность',
          order.duration.raw || null,
          <>
            {order.duration.raw}
            {duration ? <span className="text-ink-3"> · {duration}</span> : null}
          </>,
        )}
        <FieldRow label="Ждём" below={conflictBelow('wants')}>
          {editing === 'wants' ? (
            <WantsEditor
              video={order.wants_video}
              photos={order.wants_photos}
              pending={update.pending}
              onCancel={cancel}
              onSave={(next) =>
                save('wants', next, {
                  wants_video: order.wants_video,
                  wants_photos: order.wants_photos,
                })
              }
            />
          ) : (
            <EditTrigger editable={editable} onEdit={() => setEditing('wants')}>
              {wants || <Unset />}
            </EditTrigger>
          )}
        </FieldRow>
        {textRow(
          'deadline',
          'Срок',
          order.deadline,
          order.deadline ? `до ${formatDate(order.deadline, today)}` : null,
          { type: 'date', empty: 'без срока' },
        )}
        <FieldRow label="Имя фана в ролике" below={conflictBelow('fan_name')}>
          {editable ? (
            <ChoiceChips
              label="Имя фана в ролике"
              choices={FAN_NAME_CHOICES}
              value={order.fan_name}
              onChange={(fanName) => {
                if (fanName !== order.fan_name) {
                  save('fan_name', { fan_name: fanName }, { fan_name: order.fan_name })
                }
              }}
            />
          ) : (
            FAN_NAME_LABEL[order.fan_name]
          )}
        </FieldRow>
      </dl>
    </InfoSection>
  )
}
