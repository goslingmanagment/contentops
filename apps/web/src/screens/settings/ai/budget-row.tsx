import type { AiSettings } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@contentops/ui/components/input-group'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { type FormEvent, useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { usdWords } from './usd-words'

interface BudgetRowProps {
  budget: number | null
  spent: number
}

/** Бюджет в месяц: пусто — лимита нет, так и написано; «Сохранить» — при правке. */
export function BudgetRow({ budget, spent }: BudgetRowProps) {
  const api = useApi()
  const toast = useActionToast()
  const inputId = useId()
  const [draft, setDraft] = useState(budget === null ? '' : String(budget))
  const save = useIntentMutation<number | null, AiSettings>({
    failed: 'Бюджет не сохранился',
    run: (value, key) =>
      api.settings.updateAiBudget({ body: { budget_month_usd: value }, idempotencyKey: key }),
    invalidates: () => [queryKeys.aiSettings()],
    onSuccess: (saved) =>
      toast.show({
        message:
          saved.budget_month_usd === null
            ? 'Лимита нет'
            : `Сохранено · ${usdWords(saved.budget_month_usd)} в месяц`,
      }),
  })
  const text = draft.trim().replace(',', '.')
  const value = text === '' ? null : Number(text)
  const valid = value === null || (Number.isFinite(value) && value > 0)
  const dirty = valid && value !== budget

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (dirty) {
      save.start(value)
    }
  }

  return (
    <SettingsRow
      label={<label htmlFor={inputId}>В месяц</label>}
      detail={`потрачено ${usdWords(spent)}${budget ? ` из ${usdWords(budget)}` : ''}`}
    >
      <form onSubmit={submit} className="flex items-center gap-3">
        <span className="text-ink-3 text-sm">
          {value === null ? 'не задано — лимита нет' : null}
        </span>
        {dirty ? (
          <Button type="submit" variant="outline" size="sm" pending={save.isPending}>
            Сохранить
          </Button>
        ) : null}
        <InputGroup className="w-32">
          <InputGroupAddon>
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            id={inputId}
            inputMode="decimal"
            value={draft}
            aria-invalid={!valid}
            placeholder="—"
            onChange={(event) => setDraft(event.target.value)}
            className="text-right tabular-nums"
          />
        </InputGroup>
      </form>
    </SettingsRow>
  )
}
