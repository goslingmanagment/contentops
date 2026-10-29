import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { SettingsRow } from '@contentops/ui/components/settings-section'
import { type FormEvent, useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

/** Имя правится на месте: «Сохранить» появляется, когда есть что сохранять. */
export function NameRow({ name }: { name: string }) {
  const api = useApi()
  const toast = useActionToast()
  const [draft, setDraft] = useState(name)
  const inputId = useId()
  const save = useIntentMutation<string, unknown>({
    failed: 'Имя не сохранилось',
    run: (next, key) => api.settings.updateProfile({ body: { name: next }, idempotencyKey: key }),
    invalidates: () => [queryKeys.session()],
    onSuccess: () => toast.show({ message: 'Сохранено' }),
  })
  const trimmed = draft.trim()
  const dirty = trimmed !== name && trimmed.length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (dirty) {
      save.start(trimmed)
    }
  }

  return (
    <SettingsRow label={<label htmlFor={inputId}>Имя</label>}>
      <form onSubmit={submit} className="flex items-center gap-2">
        {dirty ? (
          <Button type="submit" variant="outline" size="sm" pending={save.isPending}>
            Сохранить
          </Button>
        ) : null}
        <Input
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-64"
        />
      </form>
    </SettingsRow>
  )
}
