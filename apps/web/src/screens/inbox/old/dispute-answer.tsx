import type { DisputeOption } from '@contentops/contracts'
import { capitalize, ITEM_TYPE_INFO, type ItemType } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { type FormEvent, useState } from 'react'
import type { DisputeAnswer } from '@/data/inbox'

/** Типы, которые можно задать старому имени: подборки PRM из старых имён не бывает. */
const TYPES: readonly ItemType[] = ['ppv', 'sexting', 'set', 'custom', 'fyp', 'life', 'raw']

interface DisputeAnswerFormProps {
  option: DisputeOption
  pending: boolean
  onSubmit: (answer: DisputeAnswer) => void
  onCancel: () => void
}

/**
 * Слова к решению спорного (DESIGN §4.9): «Игнорировать…» и «Резерв по находке…» просят
 * причину, «Задать тип и номер…» — тип и номер. Поле сразу в фокусе, `Enter` — сохранить,
 * `Esc` — отмена.
 */
export function DisputeAnswerForm({ option, pending, onSubmit, onCancel }: DisputeAnswerFormProps) {
  const [reason, setReason] = useState('')
  const [type, setType] = useState<ItemType | undefined>(undefined)
  const [number, setNumber] = useState('')
  const parsed = Number.parseInt(number, 10)
  const ready =
    option.input === 'reason'
      ? reason.trim() !== ''
      : type !== undefined && Number.isInteger(parsed) && parsed > 0
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || pending) {
      return
    }
    onSubmit(option.input === 'reason' ? { reason: reason.trim() } : { type, number: parsed })
  }
  return (
    <form
      onSubmit={submit}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          onCancel()
        }
      }}
      className="flex flex-wrap items-center gap-2"
    >
      {option.input === 'reason' ? (
        <Input
          autoFocus
          aria-label="Причина"
          placeholder="Причина"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="h-8 w-72"
        />
      ) : (
        <>
          <Select value={type} onValueChange={(value) => setType(value as ItemType)}>
            <SelectTrigger aria-label="Тип" className="h-8 w-40">
              <SelectValue placeholder="Тип" />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((item) => (
                <SelectItem key={item} value={item}>
                  {ITEM_TYPE_INFO[item].prefix}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Номер"
            placeholder="Номер"
            inputMode="numeric"
            value={number}
            onChange={(event) => setNumber(event.target.value.replace(/\D/g, ''))}
            className="h-8 w-28 tabular-nums"
          />
        </>
      )}
      <Button size="sm" type="submit" disabled={!ready || pending}>
        {capitalize(option.label.replace(/…$/, ''))}
      </Button>
      <Button size="sm" variant="link" type="button" onClick={onCancel}>
        Отмена
      </Button>
    </form>
  )
}
