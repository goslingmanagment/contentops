import type { Person, UpdatePersonCommand } from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useVersionedSave } from '@/actions/use-versioned-save'
import { useApi } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'

const INVALIDATES = [queryKeys.people()]

/** Роль и модели человека — с `If-Match`; история выдачи прав перечитывается после. */
export function usePersonRights(person: Person) {
  const api = useApi()
  const toast = useActionToast()
  return useVersionedSave<UpdatePersonCommand, Person>({
    subject: 'права',
    failed: 'Права не сохранились',
    invalidates: [...INVALIDATES, queryKeys.personGrants(person.id)],
    run: (body, version, key) =>
      api.settings.updatePerson({
        params: { person: person.id },
        body,
        ifMatch: version,
        idempotencyKey: key,
      }),
    onSuccess: (updated) => toast.show({ message: `Сохранено · ${updated.name}` }),
  })
}
