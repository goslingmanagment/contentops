import { ROLE_LABEL, type Role } from '@contentops/contracts/domain/people'
import { logAction, type Tx } from '@contentops/db'
import type { HubPerson } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { genderOfName } from '../handlers/people'

/**
 * People come from Agency Hub (products plan 15.11.2026 §4.1, package C1). Hub is the home of people: a
 * content manager or a person who leads customs signs in through Hub, and ContentOps makes ITS person
 * from Hub's answer — at the sign-in and at every re-check (a minute at most) — and closes it when Hub
 * has closed the person. Nobody types a second registry here.
 *
 * - a content manager → «Контент-менеджер» on the models of their working pages in Hub;
 * - a person who leads customs (and is not a content manager) → «Только кастомы» on those models;
 * - the owner → as before (`HUB_SIGNIN_OWNER`), only the switcher's products follow Hub;
 * - anyone else, or a person Hub has closed (left) → no access: the person made from Hub is closed.
 *
 * Hub's model slugs are ContentOps' model codes, except where `HUB_MODEL_MAP` says otherwise: Hub's
 * test model maps to `smoke`, so a test person never sees a real model.
 */

/** What ContentOps gives a Hub person; null — nothing. */
export interface HubPersonPlan {
  role: Extract<Role, 'manager' | 'customs'>
  /** ContentOps' model codes, unique. */
  models: string[]
}

/** `test=smoke,lora=lora` → `{ test: 'smoke', lora: 'lora' }`; slugs and codes in lower case. */
export function parseModelMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const [from, to] = pair.split('=').map((part) => part.trim().toLowerCase())
    if (from && to) map[from] = to
  }
  return map
}

/** The role and the models Hub's answer gives a person here, before the models are checked. */
export function planOf(
  person: HubPerson | null | undefined,
  modelMap: Record<string, string>,
): HubPersonPlan | null {
  if (!person || person.state === 'left') return null
  const codes = (slugs: readonly string[]) => [
    ...new Set(slugs.map((slug) => modelMap[slug.toLowerCase()] ?? slug.toLowerCase())),
  ]
  if (person.role === 'content_manager') return { role: 'manager', models: codes(person.models) }
  if (person.customsModels.length > 0)
    return { role: 'customs', models: codes(person.customsModels) }
  return null
}

interface PrincipalRow extends Record<string, unknown> {
  id: string
  login: string
  display_name: string
  role: Role
  disabled_at: string | null
  hub_login: string | null
  hub_person_code: string | null
}

const COLUMNS = sql`id, login, display_name, role, disabled_at, hub_login, hub_person_code`

/** The live models among `codes`: a model ContentOps does not hold is no right. */
async function liveModels(
  tx: Tx,
  codes: readonly string[],
): Promise<{ id: string; code: string }[]> {
  if (codes.length === 0) return []
  const { rows } = await tx.execute<{ id: string; code: string }>(sql`
    SELECT id, code FROM models
     WHERE code = ANY(${sql.param([...codes])}::text[]) AND archived_at IS NULL ORDER BY id`)
  return rows
}

/** The person's live grants become exactly these models; granted by nobody (Hub, by the system). */
async function grantExactly(tx: Tx, principalId: string, models: readonly { id: string }[]) {
  await tx.execute(sql`
    UPDATE principal_grants SET revoked_at = now()
     WHERE principal_id = ${principalId}::uuid AND revoked_at IS NULL
       AND NOT (model_id = ANY(${sql.param(models.map((model) => model.id))}::uuid[]))`)
  for (const model of models) {
    await tx.execute(sql`
      INSERT INTO principal_grants (model_id, principal_id)
      VALUES (${model.id}::uuid, ${principalId}::uuid)
      ON CONFLICT (principal_id, model_id) WHERE revoked_at IS NULL DO NOTHING`)
  }
}

async function liveGrantCodes(tx: Tx, principalId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ code: string }>(sql`
    SELECT m.code FROM principal_grants g JOIN models m ON m.id = g.model_id
     WHERE g.principal_id = ${principalId}::uuid AND g.revoked_at IS NULL ORDER BY m.code`)
  return rows.map((row) => row.code)
}

/** A person made from Hub is closed: no sign-in, no session, no grant. Hub's word, in the journal. */
export async function closeHubPerson(
  tx: Tx,
  principalId: string,
  reason: string,
): Promise<boolean> {
  const { rows } = await tx.execute<PrincipalRow>(sql`
    UPDATE principals SET disabled_at = now(), row_version = row_version + 1
     WHERE id = ${principalId}::uuid AND hub_person_code IS NOT NULL AND disabled_at IS NULL
    RETURNING ${COLUMNS}`)
  const row = rows[0]
  if (!row) return false
  await tx.execute(sql`
    UPDATE sessions SET revoked_at = now() WHERE principal_id = ${row.id}::uuid AND revoked_at IS NULL`)
  await tx.execute(sql`
    UPDATE principal_grants SET revoked_at = now()
     WHERE principal_id = ${row.id}::uuid AND revoked_at IS NULL`)
  await logAction(tx, {
    action: 'auth.hubPersonClosed',
    modelId: null,
    subjectKind: 'principals',
    subjectId: row.id,
    subjectLabel: row.display_name,
    before: { Доступ: ROLE_LABEL[row.role] },
    after: { Доступ: 'нет', Причина: reason },
  })
  return true
}

export interface HubPersonInput {
  hubUserId: number
  hubLogin: string
  person: HubPerson | null | undefined
  /** `HUB_MODEL_MAP`. */
  modelMap: Record<string, string>
}

/**
 * The person Hub names, made or brought up to Hub's answer, inside the caller's transaction. Returns
 * the principal, or null when Hub's answer gives no access here (and a person made from Hub is then
 * closed). A principal made here (the owner, linked by `HUB_SIGNIN_OWNER`) keeps its role and models:
 * only the products of its switcher follow Hub.
 *
 * Linking: the principal already linked to the Hub login; else a person made here with Hub's code as
 * its login and no link yet (the content manager entered by hand before Hub knew her); else a new one.
 */
export async function applyHubPerson(
  tx: Tx,
  linked: { id: string } | null,
  input: HubPersonInput,
): Promise<{ id: string } | null> {
  const { person } = input
  const products = person ? person.products : null
  if (linked) {
    const { rows } = await tx.execute<PrincipalRow>(sql`
      SELECT ${COLUMNS} FROM principals WHERE id = ${linked.id}::uuid FOR UPDATE`)
    const row = rows[0]
    if (!row) return null
    if (row.hub_person_code === null) {
      if (products !== null) {
        await tx.execute(sql`UPDATE principals SET hub_products = ${sql.param(products)}::text[]
          WHERE id = ${row.id}::uuid AND hub_products IS DISTINCT FROM ${sql.param(products)}::text[]`)
      }
      return row
    }
    return bringUp(tx, row, input)
  }
  const plan = planOf(person, input.modelMap)
  if (!person || !plan) return null
  const models = await liveModels(tx, plan.models)
  if (models.length === 0) return null
  // The person entered here by hand before Hub knew them: their login is Hub's code.
  const { rows: byCode } = await tx.execute<PrincipalRow>(sql`
    UPDATE principals SET hub_user_id = ${input.hubUserId}, hub_login = ${input.hubLogin},
           hub_person_code = ${person.code}, row_version = row_version + 1
     WHERE login = ${person.code} AND kind = 'human' AND role <> 'owner'
       AND hub_user_id IS NULL AND disabled_at IS NULL
    RETURNING ${COLUMNS}`)
  if (byCode[0]) {
    await logAction(tx, {
      action: 'auth.hubLink',
      modelId: null,
      subjectKind: 'principals',
      subjectId: byCode[0].id,
      subjectLabel: byCode[0].display_name,
      before: { Хаб: 'нет связи' },
      after: { Хаб: input.hubLogin },
    })
    return bringUp(tx, byCode[0], input)
  }
  const login = await freeLogin(tx, person.code)
  const { rows: made } = await tx.execute<PrincipalRow>(sql`
    INSERT INTO principals (kind, login, display_name, gender, role, hub_user_id, hub_login,
                            hub_person_code, hub_products)
    VALUES ('human', ${login}, ${person.displayName}, ${genderOfName(person.displayName)},
            ${plan.role}, ${input.hubUserId}, ${input.hubLogin}, ${person.code},
            ${sql.param(person.products)}::text[])
    RETURNING ${COLUMNS}`)
  const row = made[0]
  if (!row) throw new Error('principal insert returned nothing')
  await grantExactly(tx, row.id, models)
  await logAction(tx, {
    action: 'auth.hubPersonMade',
    modelId: null,
    subjectKind: 'principals',
    subjectId: row.id,
    subjectLabel: row.display_name,
    after: {
      Логин: login,
      Роль: ROLE_LABEL[plan.role],
      Модели: models.map((model) => model.code).join(', '),
      Откуда: 'из Hub',
    },
  })
  return row
}

/** Hub's code as the login, or with `-hub` and a number when taken here by someone else. */
async function freeLogin(tx: Tx, code: string): Promise<string> {
  for (const candidate of [code, `${code}-hub`, `${code}-hub-2`, `${code}-hub-3`]) {
    const { rows } = await tx.execute(sql`SELECT 1 FROM principals WHERE login = ${candidate}`)
    if (rows.length === 0) return candidate
  }
  return `${code}-hub-${Date.now()}`
}

/** A person from Hub brought up to Hub's answer: role, name, models, products; or closed. */
async function bringUp(
  tx: Tx,
  row: PrincipalRow,
  input: HubPersonInput,
): Promise<PrincipalRow | null> {
  const plan = planOf(input.person, input.modelMap)
  const models = plan ? await liveModels(tx, plan.models) : []
  if (!plan || !input.person || models.length === 0) {
    if (row.disabled_at !== null) return null
    await closeHubPerson(
      tx,
      row.id,
      input.person?.state === 'left' ? 'ушёл по реестру Hub' : 'Hub не даёт доступа к ContentOps',
    )
    return null
  }
  const before = await liveGrantCodes(tx, row.id)
  const after = models.map((model) => model.code).sort()
  const reopened = row.disabled_at !== null
  const changed =
    reopened ||
    row.role !== plan.role ||
    row.display_name !== input.person.displayName ||
    before.join(',') !== after.join(',')
  await tx.execute(sql`
    UPDATE principals SET role = ${plan.role}, display_name = ${input.person.displayName},
           hub_login = ${input.hubLogin}, hub_products = ${sql.param(input.person.products)}::text[],
           disabled_at = NULL, row_version = row_version + ${changed ? 1 : 0}
     WHERE id = ${row.id}::uuid`)
  if (changed) {
    await grantExactly(tx, row.id, models)
    await logAction(tx, {
      action: 'auth.hubPersonUpdated',
      modelId: null,
      subjectKind: 'principals',
      subjectId: row.id,
      subjectLabel: input.person.displayName,
      before: {
        Роль: reopened ? 'нет доступа' : ROLE_LABEL[row.role],
        Модели: before.join(', ') || 'нет',
      },
      after: { Роль: ROLE_LABEL[plan.role], Модели: after.join(', ') },
    })
  }
  return row
}
