import {
  formatNumber,
  formatWhen,
  type Model,
  type ModelCode,
  type Person,
  plural,
  ROLE_LABEL,
  type Role,
  RoleSchema,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ItemMenuButton } from '@contentops/ui/components/item-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentops/ui/components/select'
import { ConflictLine } from '@contentops/ui/components/state-lines'
import { HistoryIcon, UserXIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi, useClock } from '@/data/api-session'
import { queryKeys } from '@/data/query-keys'
import { GrantsList } from './grants-list'
import { ModelChecks } from './model-checks'
import { RevokeAccessDialog } from './revoke-access-dialog'
import { usePersonRights } from './use-person-rights'

interface PersonRowProps {
  person: Person
  models: readonly Model[]
  isMe: boolean
}

function sessionsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['сессия', 'сессии', 'сессий'])}`
}

/**
 * Человек: имя и когда был, роль, модели галочками, сессии с «Отозвать», «⋯» — история
 * прав и «Отозвать доступ…». Правка прав идёт с версией записи: чужая правка — строкой.
 */
export function PersonRow({ person, models, isMe }: PersonRowProps) {
  const api = useApi()
  const toast = useActionToast()
  const now = useClock().now()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const rights = usePersonRights(person)
  const roleLabelId = useId()

  const revokeSessions = useIntentMutation<void, unknown>({
    failed: 'Сессии не отозваны',
    run: (_, key) =>
      api.settings.revokePersonSessions({ params: { person: person.id }, idempotencyKey: key }),
    invalidates: () => [queryKeys.people()],
    onSuccess: () => toast.show({ message: `Сессии отозваны · ${person.name}` }),
  })

  const changeRole = (value: string) => {
    const role = RoleSchema.safeParse(value)
    if (role.success && role.data !== person.role) {
      rights.save({ role: role.data }, person.version)
    }
  }
  const toggleModel = (code: ModelCode, checked: boolean) => {
    const next = checked ? [...person.models, code] : person.models.filter((item) => item !== code)
    rights.save({ models: next }, person.version)
  }

  return (
    <div data-slot="settings-row" className="flex flex-col">
      <div className="flex min-h-18 items-center gap-6 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate">
            <span className="font-medium">{person.name}</span>
            <span className="ml-2 font-mono text-ink-3 text-xs">{person.login}</span>
            {isMe ? <span className="ml-2 text-ink-3 text-sm">это вы</span> : null}
          </p>
          <ModelChecks
            person={person}
            models={models}
            disabled={rights.isPending}
            onToggle={toggleModel}
          />
        </div>
        <span id={roleLabelId} className="sr-only">
          Роль: {person.name}
        </span>
        <Select value={person.role} onValueChange={changeRole} disabled={isMe || rights.isPending}>
          <SelectTrigger aria-labelledby={roleLabelId} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RoleSchema.options.map((role: Role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABEL[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex w-44 items-center justify-end gap-2 text-muted-foreground text-sm">
          {person.sessions > 0 && !isMe ? (
            <>
              <span className="tabular-nums">{sessionsWord(person.sessions)}</span>
              <Button
                variant="outline"
                size="sm"
                pending={revokeSessions.isPending}
                onClick={() => revokeSessions.start()}
              >
                Отозвать
              </Button>
            </>
          ) : (
            <span className="tabular-nums">
              {isMe
                ? sessionsWord(person.sessions)
                : person.last_seen_at
                  ? `был ${formatWhen(person.last_seen_at, now)}`
                  : 'не входил'}
            </span>
          )}
        </span>
        <ItemMenuButton
          label={`Ещё: ${person.name}`}
          menu={{
            actions: [
              {
                id: 'history',
                label: historyOpen ? 'Свернуть историю прав' : 'История прав',
                icon: HistoryIcon,
                onSelect: () => setHistoryOpen((open) => !open),
              },
            ],
            dangerActions: isMe
              ? []
              : [
                  {
                    id: 'revoke',
                    label: 'Отозвать доступ…',
                    icon: UserXIcon,
                    onSelect: () => setRevoking(true),
                  },
                ],
          }}
        />
      </div>
      {rights.conflict ? (
        <ConflictLine
          message={rights.conflict.message}
          theirsLabel={rights.conflict.theirsLabel}
          onShowTheirs={rights.showTheirs}
          onKeepMine={() => rights.keepMine()}
          className="mb-3"
        />
      ) : null}
      {historyOpen ? <GrantsList person={person} /> : null}
      <RevokeAccessDialog person={person} open={revoking} onOpenChange={setRevoking} />
    </div>
  )
}
