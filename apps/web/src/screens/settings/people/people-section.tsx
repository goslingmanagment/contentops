import { Button } from '@contentops/ui/components/button'
import {
  SettingsSection,
  SettingsSectionSkeleton,
} from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { UserPlusIcon } from 'lucide-react'
import { useState } from 'react'
import { useModels, useSession } from '@/data/session'
import { usePeople } from '@/data/settings'
import { SettingsPage } from '../settings-layout'
import { AddPersonDialog } from './add-person-dialog'
import { PersonRow } from './person-row'

/**
 * «Люди и доступ» (DESIGN §4.19): роль и модели галочками, «Отозвать сессию», свёрнутая
 * история выдачи прав, «Добавить человека». Права выдаются на модель, не на страницу.
 */
export function PeopleSection() {
  const people = usePeople()
  const models = useModels()
  const me = useSession().data?.person.id
  const [adding, setAdding] = useState(false)

  return (
    <SettingsPage
      title="Люди и доступ"
      refreshing={people.isFetching && !people.isPending}
      actions={
        <Button onClick={() => setAdding(true)}>
          <UserPlusIcon />
          Добавить человека
        </Button>
      }
    >
      {people.isError && !people.data ? (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void people.refetch()} />
      ) : null}
      {people.isPending ? <SettingsSectionSkeleton rows={4} /> : null}
      {people.data && models.data ? (
        <SettingsSection>
          {people.data.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              models={models.data}
              isMe={person.id === me}
            />
          ))}
        </SettingsSection>
      ) : null}
      <AddPersonDialog open={adding} onOpenChange={setAdding} models={models.data ?? []} />
    </SettingsPage>
  )
}
