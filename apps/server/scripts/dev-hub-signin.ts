// The sign-in half of the fake Agency Hub (`DEV_FAKE_HUB=1 pnpm dev:server`, package C4): ContentOps' own entrance
// asks it as it asks Hub. Invented people only, passwords known to the stand:
//   kira / kira-dev-password — a content manager of Лора; admin — the owner (refused: the owner enters through Hub);
//   ivan / ivan-dev-password — a chatter without ContentOps; `/join#dev-invite-mila` — Mila's invitation.
// Five wrong passwords of one login lock it, as Hub does.
import { randomBytes } from 'node:crypto'
import type { LoggedRequest, Reply } from '@contentops/hub/testing'

interface Login {
  id: number
  username: string
  role: string
  password: string | null
  person: { code: string; displayName: string; role: string; models: string[]; products: string[] } | null
}

const FREE_FAILURES = 5

export class DevSignin {
  private readonly logins = new Map<string, Login>([
    ['kira', { id: 501, username: 'kira', role: 'content_manager', password: 'kira-dev-password', person: { code: 'kira', displayName: 'Кира', role: 'content_manager', models: ['lora'], products: ['contentops'] } }],
    ['admin', { id: 1, username: 'admin', role: 'owner', password: 'not-used-here', person: null }],
    ['ivan', { id: 502, username: 'ivan', role: 'chatter', password: 'ivan-dev-password', person: { code: 'ivan', displayName: 'Иван', role: 'chatter', models: ['lora'], products: ['workboard'] } }],
    ['mila', { id: 503, username: 'mila', role: 'content_manager', password: null, person: { code: 'mila', displayName: 'Мила', role: 'content_manager', models: ['lora'], products: ['contentops'] } }],
  ])
  private readonly links = new Map<string, { username: string; used: boolean }>([['dev-invite-mila', { username: 'mila', used: false }]])
  private readonly grants = new Map<string, string>()
  private readonly failures = new Map<string, number>()

  handle(req: LoggedRequest): Reply | null {
    const body = (req.json ?? {}) as Record<string, string>
    switch (req.path) {
      case '/api/v1/auth/sso/password':
        return this.password(body.username ?? '', body.password ?? '')
      case '/api/v1/auth/sso/link':
        return this.link(body.token ?? '', body.password ?? '')
      case '/api/v1/auth/sso/check': {
        const login = this.byGrant(body.grant)
        return { status: 200, body: login ? { active: true, ...this.person(login) } : { active: false } }
      }
      case '/api/v1/auth/sso/waiting':
        return { status: 200, body: this.byGrant(body.grant) ? { active: true, matters: [], serverNow: new Date().toISOString() } : { active: false } }
      case '/api/v1/auth/sso/logout':
        return { status: 200, body: { ended: body.grant !== undefined && this.grants.delete(body.grant) } }
      default:
        return null
    }
  }

  private byGrant(grant: string | undefined): Login | undefined {
    const username = grant === undefined ? undefined : this.grants.get(grant)
    return username === undefined ? undefined : this.logins.get(username)
  }

  private person(login: Login) {
    return {
      user: { id: login.id, username: login.username, role: login.role },
      owner: false,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      person: login.person && { ...login.person, state: 'working', customsModels: [] },
    }
  }

  private signedIn(login: Login): Reply {
    const grant = randomBytes(32).toString('base64url')
    this.grants.set(grant, login.username)
    return { status: 200, body: { result: 'signed_in', ...this.person(login), grant } }
  }

  private refused(reason: string): Reply {
    return { status: 200, body: { result: 'refused', reason } }
  }

  private password(username: string, password: string): Reply {
    const login = this.logins.get(username.trim().toLowerCase())
    if (login?.role === 'owner') return this.refused('owner')
    if ((this.failures.get(username) ?? 0) >= FREE_FAILURES) return this.refused('locked')
    if (!login || login.password === null || login.password !== password) {
      this.failures.set(username, (this.failures.get(username) ?? 0) + 1)
      return this.refused('wrong')
    }
    this.failures.delete(username)
    if (!login.person?.products.includes('contentops')) return this.refused('no_access')
    return this.signedIn(login)
  }

  private link(token: string, password: string): Reply {
    const link = this.links.get(token)
    if (!link) return this.refused('link_unknown')
    if (link.used) return this.refused('link_used')
    if (password.length < 12) return this.refused('weak')
    const login = this.logins.get(link.username)
    if (!login) return this.refused('link_unknown')
    link.used = true
    login.password = password
    return this.signedIn(login)
  }
}
