import { ROLE_LABEL } from '@contentops/contracts'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useModels, useSession } from '@/data/session'
import { SettingsPage } from '../settings-layout'
import { modelNamesOf } from '../shared/model-names'
import { NameRow } from './name-row'
import { PasswordRow } from './password-row'
import { SessionsSection } from './sessions-section'
import { SkinRow } from './skin-row'

/** «Профиль и сессии» (DESIGN §4.19): имя, пароль, вид, свои сессии, «Выйти везде». Видят все. */
export function ProfileSection() {
  const session = useSession()
  const models = useModels()
  const person = session.data?.person

  return (
    <SettingsPage title="Профиль и сессии" refreshing={session.isFetching && !session.isPending}>
      <SettingsSection title="Профиль">
        {person ? <NameRow key={person.name} name={person.name} /> : null}
        <SettingsRow label="Логин">
          <span className="font-mono text-muted-foreground text-xs">{person?.login}</span>
        </SettingsRow>
        <SettingsRow
          label="Роль"
          detail={person ? modelNamesOf(person.models, models.data ?? []) : undefined}
        >
          <span className="text-muted-foreground">{person ? ROLE_LABEL[person.role] : null}</span>
        </SettingsRow>
        <PasswordRow />
        {session.data ? <SkinRow skin={session.data.ui_skin} /> : null}
      </SettingsSection>
      <SessionsSection />
    </SettingsPage>
  )
}
