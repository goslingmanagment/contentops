import type { Route } from '@contentops/contracts/api/route'
import { type Db, isSwitchOn } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, Authorize, ModelScope } from './context'
import { ApiProblem } from './errors'

/**
 * Who may call a route (SPEC §11.1, DESIGN §2.3, §4.19). Routes under a model (`/{model}/…`)
 * are read by everyone with the model and changed by the owner and managers; the rest of
 * `/admin/…` is the owner's, except what this table opens wider.
 */
export type Access = 'public' | 'signed' | 'human' | 'staff' | 'owner'

const ROUTE_ACCESS: Record<string, Access> = {
  'auth.signIn': 'public',
  // A person's own session and profile; agents have neither.
  'auth.signOutEverywhere': 'human',
  'admin.me': 'human',
  'settings.mySessions': 'human',
  'settings.revokeMySession': 'human',
  'settings.updateProfile': 'human',
  'settings.changePassword': 'human',
  'admin.counters': 'signed',
  'admin.models': 'signed',
  'admin.tags': 'signed',
  'admin.state': 'signed',
  'admin.operation': 'signed',
  // «Интеграции» — КМ только смотрит; пороги и подрядчики нужны его экранам.
  'admin.integrations': 'staff',
  'admin.thresholds': 'staff',
  'settings.contractors': 'staff',
}

export function accessOf(key: string, route: Route): Access | 'model' {
  const explicit = ROUTE_ACCESS[key]
  if (explicit) return explicit
  return route.path.startsWith('/api/v1/admin/') ? 'owner' : 'model'
}

const STAFF = new Set(['owner', 'manager'])

function forbidden(message: string): ApiProblem {
  return new ApiProblem('forbidden', message)
}

/** Agents work only while the owner keeps them on: all of them and this token (SPEC §8). */
async function agentSwitchedOn(db: Db, tokenId: string | null): Promise<boolean> {
  if (!(await isSwitchOn(db, 'agents.enabled'))) return false
  if (!tokenId) return false
  const { rows } = await db.execute<{ off: boolean }>(sql`
    SELECT value = 'false'::jsonb AS off FROM policy_settings
     WHERE key = ${`agents.token.${tokenId}`} AND model_id IS NULL`)
  return rows[0]?.off !== true
}

async function modelByCode(db: Db, code: string): Promise<ModelScope | undefined> {
  const { rows } = await db.execute<ModelScope & Record<string, unknown>>(sql`
    SELECT id, code, title AS name FROM models WHERE code = ${code} AND archived_at IS NULL`)
  return rows[0]
}

/**
 * 403 on a model without rights whether the object exists or not; 404 only inside the
 * allowed scope (SPEC §11.2). Only the owner learns that a model code does not exist.
 */
async function modelScope(db: Db, actor: Actor, code: string): Promise<ModelScope> {
  if (actor.role !== 'owner' && !actor.models.includes(code)) {
    throw forbidden('Нет доступа к этой модели')
  }
  const model = await modelByCode(db, code)
  if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
  return model
}

export function createAuthorize(db: Db): Authorize {
  return async ({ key, route, actor, params }) => {
    const access = accessOf(key, route)
    if (access === 'public') return null
    if (!actor) throw new ApiProblem('unauthenticated', 'Нужно войти')
    if (actor.type === 'agent' && !(await agentSwitchedOn(db, actor.tokenId))) {
      throw forbidden('Агенты выключены владельцем')
    }
    if (access === 'human' && actor.type !== 'person') throw forbidden('Только для людей')
    if (access === 'staff' && !STAFF.has(actor.role)) throw forbidden('Недостаточно прав')
    if (access === 'owner' && actor.role !== 'owner') throw forbidden('Это может только владелец')
    // «Только чтение» не меняет ничего, кроме своего профиля и сессий (DESIGN §2.3).
    if (access === 'model' && route.method !== 'GET' && !STAFF.has(actor.role)) {
      throw forbidden('Только чтение')
    }
    const code = params.model
    return code === undefined ? null : modelScope(db, actor, code)
  }
}
