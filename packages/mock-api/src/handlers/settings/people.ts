import { newIdempotencyKey } from '@contentops/contracts/api/idempotency-key'
import { settingsRoutes } from '@contentops/contracts/api/routes/settings'
import type { AccessGrant } from '@contentops/contracts/domain/admin'
import type { Gender, ModelCode } from '@contentops/contracts/domain/common'
import { type Person, ROLE_LABEL, type Role } from '@contentops/contracts/domain/people'
import { pastVerb } from '@contentops/contracts/format'
import { DomainError, notFound } from '../../domain-error'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { wholeList } from '../../views/paginate'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'
import { checkVersion } from './versions'

/** «Люди и доступ» (DESIGN §4.19): роль, модели галочками, сессии, история прав. */

function personOf(state: MockState, id: string): Person {
  const person = state.world.people.find((candidate) => candidate.id === id)
  if (!person) throw notFound('Такого человека нет')
  return person
}

function modelNames(state: MockState, codes: readonly ModelCode[]): string {
  return codes.map((code) => state.world.models.get(code)?.model.name ?? code).join(', ')
}

/** The owner sees every model; the others only what they were given. */
function modelsForRole(state: MockState, role: Role, models: readonly ModelCode[]): ModelCode[] {
  const all = [...state.world.models.keys()]
  return role === 'owner' ? all : all.filter((code) => models.includes(code))
}

/** Male names that end in «а» or «я» like feminine ones. */
const MALE_NAMES_IN_A = new Set(['никита', 'илья', 'лука', 'фома', 'кузьма', 'савва', 'данила'])

/** Russian names that end in «а» or «я» are feminine, except the male ones above. */
function genderOfName(name: string): Gender {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /[ая]$/.test(first) && !MALE_NAMES_IN_A.has(first) ? 'f' : 'm'
}

/** «k7m2-q9pd-3xa1»: shown once in the window and never stored in the clear. */
function temporaryPassword(): string {
  const key = newIdempotencyKey().replaceAll('-', '')
  return `${key.slice(0, 4)}-${key.slice(4, 8)}-${key.slice(8, 12)}`
}

function addGrant(state: MockState, person: Person, text: string): void {
  const entry: AccessGrant = { at: state.clock.now(), by: state.principal.name, text }
  state.world.admin.grants.set(person.id, [
    entry,
    ...(state.world.admin.grants.get(person.id) ?? []),
  ])
}

/** What changed in the rights, for the history and the journal: «сменил роль», «добавил Lily». */
function describeRightsChange(state: MockState, before: Person, after: Person): string[] {
  const verb = (masculine: string) => pastVerb(masculine, state.principal.gender)
  const lines: string[] = []
  if (before.role !== after.role) {
    lines.push(`${verb('сменил')} роль: ${ROLE_LABEL[before.role]} → ${ROLE_LABEL[after.role]}`)
  }
  const added = after.models.filter((code) => !before.models.includes(code))
  const removed = before.models.filter((code) => !after.models.includes(code))
  if (added.length > 0) lines.push(`${verb('добавил')} ${modelNames(state, added)}`)
  if (removed.length > 0) lines.push(`${verb('убрал')} ${modelNames(state, removed)}`)
  return lines
}

/** With `?demo=conflict` the other device takes the last model away (or gives Lily). */
function rivalRights(person: Person): void {
  person.models = person.models.length > 1 ? person.models.slice(0, -1) : [...person.models, 'lily']
}

export function peopleHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.addPerson, 'owner', ({ state, body, log }) => {
      if (state.world.people.some((person) => person.login === body.login)) {
        throw new DomainError('invalid_request', 'Такой логин уже есть', { field: 'login' })
      }
      const models = modelsForRole(state, body.role, body.models)
      const person: Person = {
        id: `p-${body.login}`,
        name: body.name,
        login: body.login,
        gender: genderOfName(body.name),
        role: body.role,
        models,
        posts_on: [],
        sessions: 0,
        last_seen_at: null,
        version: 1,
      }
      state.world.people.push(person)
      addGrant(
        state,
        person,
        `${pastVerb('выдал', state.principal.gender)} роль «${ROLE_LABEL[body.role]}» · ${modelNames(state, models)}`,
      )
      logSettingsChange(log, models, {
        action: 'person.add',
        phrase: `${actorSays(state, 'добавил')} человека: ${person.name} · ${ROLE_LABEL[person.role]}`,
      })
      return { person, temporary_password: temporaryPassword() }
    }),

    bind(settingsRoutes.updatePerson, 'owner', ({ state, params, body, if_match, log }) => {
      const person = personOf(state, params.person)
      if (person.id === state.principal.id && body.role && body.role !== person.role) {
        throw new DomainError('forbidden', 'Свою роль не меняют')
      }
      checkVersion(state, if_match, person, {
        field: `права ${person.name}`,
        rival: rivalRights,
        valueOf: (record) => ({ role: record.role, models: record.models }),
      })
      const before = { ...person }
      const role = body.role ?? person.role
      person.role = role
      person.models = modelsForRole(state, role, body.models ?? person.models)
      person.version += 1
      const lines = describeRightsChange(state, before, person)
      for (const line of lines) addGrant(state, person, line)
      logSettingsChange(log, [...new Set([...before.models, ...person.models])], {
        action: 'person.update',
        phrase: `${actorSays(state, 'изменил')} права: ${person.name}`,
        changes: [
          { field: 'Роль', before: ROLE_LABEL[before.role], after: ROLE_LABEL[person.role] },
          {
            field: 'Модели',
            before: modelNames(state, before.models) || 'нет',
            after: modelNames(state, person.models) || 'нет',
          },
        ].filter((change) => change.before !== change.after),
      })
      return person
    }),

    bind(settingsRoutes.revokePersonSessions, 'owner', ({ state, params, log }) => {
      const person = personOf(state, params.person)
      const count = person.sessions
      person.sessions = 0
      state.world.admin.sessions.set(person.id, [])
      logSettingsChange(log, person.models, {
        action: 'person.sessions.revoke',
        phrase: `${actorSays(state, 'отозвал')} сессии: ${person.name}`,
        changes: [{ field: 'Сессии', before: String(count), after: '0' }],
      })
      return person
    }),

    bind(settingsRoutes.revokeAccess, 'owner', ({ state, params, log }) => {
      const person = personOf(state, params.person)
      if (person.id === state.principal.id) {
        throw new DomainError('forbidden', 'Свой доступ не отзывают')
      }
      state.world.people = state.world.people.filter((candidate) => candidate.id !== person.id)
      state.world.admin.sessions.delete(person.id)
      logSettingsChange(log, person.models, {
        action: 'person.revoke',
        phrase: `${actorSays(state, 'отозвал')} доступ: ${person.name}`,
        changes: [{ field: 'Доступ', before: ROLE_LABEL[person.role], after: 'нет' }],
      })
      return { ok: true as const }
    }),

    bind(settingsRoutes.modelPeople, 'read', ({ state, model }) => {
      const code = model().model.code
      return wholeList(
        state.world.people
          .filter((person) => person.models.includes(code))
          .map((person) => ({ id: person.id, name: person.name })),
      )
    }),

    bind(settingsRoutes.personGrants, 'owner', ({ state, params }) => {
      const person = personOf(state, params.person)
      return wholeList(state.world.admin.grants.get(person.id) ?? [])
    }),
  ]
}
