import type { Threshold } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@contentops/ui/components/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { draftOf, parseDraft, type ScopeOption, type ScopeOptionGroup } from './threshold-value'

interface AddExceptionFormProps {
  base: Threshold
  groups: readonly ScopeOptionGroup[]
  onClose: () => void
}

interface NewException {
  option: ScopeOption
  value: number | null
}

/**
 * «+ для страницы или типа…» раскрыт: страница или тип, значение (сначала — как для всего),
 * «Добавить». Строкой под порогом, без окна (§3.9).
 */
export function AddExceptionForm({ base, groups, onClose }: AddExceptionFormProps) {
  const api = useApi()
  const toast = useActionToast()
  const [optionId, setOptionId] = useState('')
  const [draft, setDraft] = useState(() => draftOf(base.value))
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => triggerRef.current?.focus(), [])

  const add = useIntentMutation<NewException, Threshold>({
    failed: 'Исключение не добавилось',
    run: ({ option, value }, key) =>
      api.admin.updateThreshold({
        body: { key: base.key, scope: option.scope, scope_value: option.scope_value, value },
        idempotencyKey: key,
      }),
    invalidates: () => [queryKeys.thresholds()],
    onSuccess: (saved, { option }) => {
      onClose()
      toast.show({ message: `Сохранено · ${saved.label} · ${option.fullName}` })
    },
  })

  const option = groups.flatMap((group) => group.options).find((item) => item.id === optionId)
  const parsed = parseDraft(draft)
  const ready = option !== undefined && parsed !== undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (option && parsed !== undefined) {
      add.start({ option, value: parsed })
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-12 items-center gap-6 py-1.5">
      <Select value={optionId} onValueChange={setOptionId}>
        <SelectTrigger ref={triggerRef} aria-label="Страница или тип" className="w-56">
          <SelectValue placeholder="Страница или тип">{option?.fullName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <div className="ml-auto flex items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" variant="outline" size="sm" disabled={!ready} pending={add.isPending}>
          Добавить
        </Button>
        <InputGroup className="w-32">
          <InputGroupInput
            aria-label={`${base.label}: значение исключения`}
            inputMode="decimal"
            value={draft}
            aria-invalid={parsed === undefined}
            placeholder="—"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose()
              }
            }}
            className="text-right tabular-nums"
          />
          {base.unit ? (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{base.unit}</InputGroupText>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
    </form>
  )
}
