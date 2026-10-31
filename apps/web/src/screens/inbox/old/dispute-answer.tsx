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
import { usePromoContractors } from '@/data/promo'
import { useCurrentModel } from '@/shell/model/model-context'

/** Типы, которые можно задать старому имени: подборки PRM из старых имён не бывает. */
const TYPES: readonly ItemType[] = ['ppv', 'sexting', 'set', 'custom', 'fyp', 'life', 'raw']

/**
 * Последний ответ на вариант со словами («Пак подрядчику…», «Игнорировать…»), пока открыта
 * вкладка: спорных одного вида сотни, и следующий случай чаще решается так же — ответ уже
 * подставлен, остаётся `Enter`.
 */
const lastAnswer = new Map<string, string>()

interface DisputeAnswerFormProps {
  option: DisputeOption
  pending: boolean
  onSubmit: (answer: DisputeAnswer) => void
  onCancel: () => void
}

/**
 * Слова к решению спорного (DESIGN §4.9): «Игнорировать…» и «Резерв по находке…» просят
 * причину, «Задать тип и номер…» — тип и номер, «Пак подрядчику…» — подрядчика из списка
 * модели. Прошлый ответ подставлен, и тогда фокус на кнопке; `Enter` — сохранить, `Esc` —
 * отмена.
 */
export function DisputeAnswerForm({ option, pending, onSubmit, onCancel }: DisputeAnswerFormProps) {
  const [reason, setReason] = useState(() => lastAnswer.get(option.key) ?? '')
  const [type, setType] = useState<ItemType | undefined>(undefined)
  const [number, setNumber] = useState('')
  const parsed = Number.parseInt(number, 10)
  const worded = option.input === 'reason' || option.input === 'contractor'
  const ready = worded
    ? reason.trim() !== ''
    : type !== undefined && Number.isInteger(parsed) && parsed > 0
  // Подставленный ответ подтверждается одним `Enter`.
  const [prefilled] = useState(() => worded && reason.trim() !== '')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready || pending) {
      return
    }
    if (worded) {
      lastAnswer.set(option.key, reason.trim())
    }
    onSubmit(
      option.input === 'reason'
        ? { reason: reason.trim() }
        : option.input === 'contractor'
          ? { contractor: reason.trim() }
          : { type, number: parsed },
    )
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
      {option.input === 'contractor' ? (
        <ContractorSelect value={reason} autoFocus={!prefilled} onChange={setReason} />
      ) : option.input === 'reason' ? (
        <Input
          autoFocus={!prefilled}
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
      <Button size="sm" type="submit" autoFocus={prefilled} disabled={!ready || pending}>
        {capitalize(option.label.replace(/…$/, ''))}
      </Button>
      <Button size="sm" variant="link" type="button" onClick={onCancel}>
        Отмена
      </Button>
    </form>
  )
}

/**
 * Подрядчик пака — из подрядчиков модели (Настройки › Модели и страницы): сервер ищет его
 * по имени, и опечатка в свободном поле дала бы отказ.
 */
function ContractorSelect({
  value,
  autoFocus,
  onChange,
}: {
  value: string
  autoFocus: boolean
  onChange: (name: string) => void
}) {
  const contractors = usePromoContractors(useCurrentModel().code).data
  if (contractors?.length === 0) {
    return (
      <span className="text-muted-foreground text-sm">
        Подрядчиков нет — добавьте в настройках модели
      </span>
    )
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger autoFocus={autoFocus} aria-label="Подрядчик" className="h-8 w-56">
        <SelectValue placeholder="Подрядчик" />
      </SelectTrigger>
      <SelectContent>
        {(contractors ?? []).map((contractor) => (
          <SelectItem key={contractor.id} value={contractor.name}>
            {contractor.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
