import { authRoutes, settingsRoutes } from '@contentops/contracts/api/routes/settings'
import type { Session } from '@contentops/contracts/domain/admin'
import { DomainError, notFound } from '../../domain-error'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { wholeList } from '../../views/paginate'

/** «Профиль и сессии» and sign-in (DESIGN §4.19, §4.21). */

function mySessions(state: MockState): Session[] {
  return state.world.admin.sessions.get(state.principal.id) ?? []
}

export function profileHandlers(): BoundRoute[] {
  return [
    bind(settingsRoutes.mySessions, 'read', ({ state }) => wholeList(mySessions(state))),

    bind(settingsRoutes.revokeMySession, 'read', ({ state, params }) => {
      const sessions = mySessions(state)
      const target = sessions.find((session) => session.id === params.session)
      if (!target) throw notFound('Такой сессии нет')
      if (target.current) {
        throw new DomainError('invalid_request', 'Этот браузер закрывается кнопкой «Выйти»')
      }
      const rest = sessions.filter((session) => session.id !== target.id)
      state.world.admin.sessions.set(state.principal.id, rest)
      state.principal.sessions = rest.length
      return wholeList(rest)
    }),

    bind(settingsRoutes.updateProfile, 'read', ({ state, body }) => {
      state.principal.name = body.name
      return state.principal
    }),

    bind(settingsRoutes.changePassword, 'read', () => ({ ok: true as const })),

    // Any non-empty password opens a known login: the prototype keeps no passwords.
    bind(authRoutes.signIn, 'read', ({ state, body }) => {
      const person = state.world.people.find((candidate) => candidate.login === body.login)
      if (!person) {
        throw new DomainError('unauthenticated', 'Логин или пароль не подходят')
      }
      state.signed_out = false
      return { person }
    }),

    bind(authRoutes.signOutEverywhere, 'read', ({ state }) => {
      state.world.admin.sessions.set(state.principal.id, [])
      state.principal.sessions = 0
      state.signed_out = true
      return { ok: true as const }
    }),
  ]
}
