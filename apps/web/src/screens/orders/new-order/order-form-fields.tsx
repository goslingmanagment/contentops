import {
  type Account,
  FAN_NAME_CHOICES,
  type OrderFields,
  parseDuration,
} from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { Input } from '@contentops/ui/components/input'
import { Label } from '@contentops/ui/components/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { Textarea } from '@contentops/ui/components/textarea'
import { type ReactNode, useId } from 'react'
import { Controller, type UseFormReturn, useWatch } from 'react-hook-form'
import { countOrZero, textOrNull, trimmed } from '../form-values'

interface RowProps {
  label: string
  htmlFor?: string
  children: ReactNode
  /** Сообщение проверки под полем. */
  error?: string
}

function Row({ label, htmlFor, children, error }: RowProps) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-x-4">
      <label htmlFor={htmlFor} className="text-ink-3 text-sm">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </div>
  )
}

/** «· 12–15 мин» после «видео»: так длительность понял сервер. */
function DurationHint({ raw }: { raw: string }) {
  if (!raw.trim()) return null
  const parsed = parseDuration(raw)
  if (!parsed || parsed.min_s === null || parsed.max_s === null) {
    return <span> · не разобрано</span>
  }
  const from = Math.round(parsed.min_s / 60)
  const to = Math.round(parsed.max_s / 60)
  return (
    <span className="tabular-nums"> · {from === to ? `${from} мин` : `${from}–${to} мин`}</span>
  )
}

interface OrderFormFieldsProps {
  form: UseFormReturn<OrderFields>
  accounts: readonly Account[]
}

/**
 * Разобранные поля заказа (DESIGN §4.16, п. 2): покупатель, страница, ТЗ; что ждём одним
 * рядом — видео с длительностью (исходным текстом и разобранной), число фото и срок;
 * «Имя фана в ролике». Всё правится. Примеров-заглушек в полях нет: пустое поле пусто.
 */
export function OrderFormFields({ form, accounts }: OrderFormFieldsProps) {
  const { register, control, formState } = form
  const ids = {
    buyer: useId(),
    brief: useId(),
    duration: useId(),
    video: useId(),
    photos: useId(),
    deadline: useId(),
  }
  const durationRaw = useWatch({ control, name: 'duration_raw' })
  return (
    <div className="flex flex-col gap-3">
      <Row label="Покупатель" htmlFor={ids.buyer}>
        <Input id={ids.buyer} {...register('buyer', { setValueAs: textOrNull })} />
      </Row>
      <Row label="Страница">
        <Controller
          control={control}
          name="account"
          render={({ field }) => (
            <Select value={field.value ?? undefined} onValueChange={field.onChange}>
              <SelectTrigger aria-label="Страница" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.code} value={account.code}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </Row>
      <Row label="ТЗ" htmlFor={ids.brief} error={formState.errors.brief?.message}>
        <Textarea
          id={ids.brief}
          rows={2}
          className="min-h-16"
          aria-invalid={formState.errors.brief ? true : undefined}
          {...register('brief', { setValueAs: trimmed })}
        />
      </Row>
      <Row label="Ждём">
        <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_8.75rem] items-center gap-x-2 gap-y-1">
          <Controller
            control={control}
            name="wants_video"
            render={({ field }) => (
              <Label htmlFor={ids.video} className="h-5 min-w-0 gap-1.5 text-ink-3 text-sm">
                <Checkbox
                  id={ids.video}
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                <span className="truncate">
                  видео
                  <DurationHint raw={durationRaw} />
                </span>
              </Label>
            )}
          />
          <label htmlFor={ids.photos} className="h-5 text-ink-3 text-sm">
            фото
          </label>
          <label htmlFor={ids.deadline} className="h-5 text-ink-3 text-sm">
            срок
          </label>
          <Input
            id={ids.duration}
            aria-label="Длительность видео"
            placeholder="длительность"
            {...register('duration_raw')}
          />
          <Input
            id={ids.photos}
            type="number"
            min={0}
            inputMode="numeric"
            {...register('wants_photos', { setValueAs: countOrZero })}
          />
          <Input
            id={ids.deadline}
            type="date"
            {...register('deadline', { setValueAs: textOrNull })}
          />
        </div>
      </Row>
      <Row label="Имя фана в ролике">
        <Controller
          control={control}
          name="fan_name"
          render={({ field }) => (
            <ChoiceChips
              label="Имя фана в ролике"
              choices={FAN_NAME_CHOICES}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
      </Row>
    </div>
  )
}
