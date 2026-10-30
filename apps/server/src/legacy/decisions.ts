import type { ResolveDisputeCommand } from '@contentops/contracts/commands/settings'
import { ITEM_TYPE_INFO } from '@contentops/contracts/domain/item-type'
import { logAction, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { isUuid } from '../commands'
import { ApiProblem } from '../errors'
import { autoAcceptForObjects } from './auto-accept'
import { importPacks } from './promo'
import { collisions, type NumberUnit, numberUnits, registryOnly } from './review'

/**
 * Decisions of «Разбор старого» (DESIGN §4.9): a number of §6.4 (keep, a new number, a typo,
 * unclear), a review case of the pass (a name assigned or ignored, an SMM folder marked, a short
 * shoot merged or kept, a hole left or reserved by a find). Each one is a row change with its
 * author and an `action` row; «Неясно — оставить в разборе» changes nothing but the journal.
 */

export const PROPOSAL = 'proposal'
export const FOLDERS = 'folders'
export const UNCLEAR = 'unclear'

function notFound(): never {
  throw new ApiProblem('not_found', 'Такого случая нет')
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new ApiProblem('invalid_request', message, details)
}

type Decision = NumberUnit['decision']

/** Sets the decision of number claims and of the registry rows that follow them. */
async function decideUnits(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  changes: readonly { unit: NumberUnit; decision: Decision; assigned: number | null }[],
): Promise<void> {
  for (const { unit, decision, assigned } of changes) {
    await tx.execute(sql`
      UPDATE legacy_number_claims
         SET decision = ${decision}, assigned_number = ${assigned}, decided_at = now(),
             decided_by = ${actorId}::uuid, row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid
         AND (id = ${unit.id}::uuid
              OR (${unit.registry_claim_id}::uuid IS NOT NULL
                  AND claim_id = ${unit.registry_claim_id}::uuid))`)
  }
}

function folderChange(unit: NumberUnit, choice: string) {
  switch (choice) {
    case 'keep':
      return { unit, decision: 'keep' as const, assigned: unit.claimed }
    case 'new_number':
      return { unit, decision: 'renumber' as const, assigned: null }
    case 'typo': {
      const registry = unit.registry_number
      if (registry === null || registry === unit.claimed) {
        invalid(`У папки ${unit.name} нет строки реестра с другим номером`, { folder: unit.name })
      }
      return { unit, decision: 'typo' as const, assigned: registry }
    }
    case UNCLEAR:
      return { unit, decision: 'unclear' as const, assigned: null }
    default:
      return invalid(`Нет такого варианта: ${choice}`, { option: choice })
  }
}

async function resolveNumbers(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  id: string,
  body: ResolveDisputeCommand,
): Promise<string> {
  const units = await numberUnits(tx, modelId)
  const [kind, ...rest] = id.split('.')
  let group: NumberUnit[]
  let title: string
  if (kind === 'number') {
    group = collisions(units).get(rest.join(':')) ?? notFound()
    title = `${group[0]?.type}-${rest[1]} у нескольких папок`
  } else {
    const target = rest[0] ?? ''
    if (!isUuid(target)) notFound()
    const pool = kind === 'trace' ? registryOnly(units) : units.filter((u) => u.decision === 'typo')
    group = pool.filter((unit) => unit.id === target)
    if (group.length === 0) notFound()
    title = group[0]?.name ?? id
  }
  let changes: { unit: NumberUnit; decision: Decision; assigned: number | null }[]
  if (body.option === PROPOSAL) {
    changes = group.map((unit) => ({ unit, decision: unit.decision, assigned: unit.assigned }))
  } else if (body.option === UNCLEAR) {
    changes = group.map((unit) => ({ unit, decision: 'unclear', assigned: null }))
  } else if (body.option === FOLDERS && kind === 'number') {
    const folders = body.folders ?? {}
    changes = group.map((unit) => folderChange(unit, folders[unit.name] ?? 'keep'))
  } else if (body.option === 'keep' && kind !== 'number') {
    changes = group.map((unit) => ({ unit, decision: 'keep', assigned: unit.claimed }))
  } else {
    invalid(`Нет такого варианта: ${body.option}`, { option: body.option })
  }
  const keeping = new Set(
    changes.filter((change) => change.decision === 'keep').map((change) => change.unit.name),
  )
  if (kind === 'number' && keeping.size > 1) {
    invalid('Номер остаётся только у одной папки', { folders: [...keeping] })
  }
  await decideUnits(tx, modelId, actorId, changes)
  // Bytes waiting for this number may be accepted now (SPEC §6.4: the number decides first).
  const { rows: model } = await tx.execute<{ code: string; title: string }>(sql`
    SELECT code, title FROM models WHERE id = ${modelId}::uuid`)
  if (model[0]) {
    await autoAcceptForObjects(
      tx,
      { id: modelId, code: model[0].code, name: model[0].title },
      changes.map((change) => change.unit.object_id),
    )
  }
  return title
}

interface CaseRow extends Record<string, unknown> {
  id: string
  kind: string
  state: string
  source_object_id: string | null
  title: string | null
}

const CASE_OPTIONS: Record<string, readonly string[]> = {
  legacy_unparsed: ['assign', 'ignore'],
  unreadable_input: ['manual'],
  smm_folder: ['pack', 'vendor_shoot'],
  number_hole: ['leave_empty', 'reserve'],
  merge_split: ['merge', 'keep'],
}

async function resolveCase(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  caseId: string,
  body: ResolveDisputeCommand,
): Promise<string> {
  if (!isUuid(caseId)) notFound()
  const { rows } = await tx.execute<CaseRow>(sql`
    SELECT id, kind, state, source_object_id, details ->> 'title' AS title FROM review_cases
     WHERE model_id = ${modelId}::uuid AND id = ${caseId}::uuid FOR UPDATE`)
  const row = rows[0] ?? notFound()
  const title = row.title ?? row.kind
  if (body.option === UNCLEAR) return title
  if (row.state !== 'open') throw new ApiProblem('case_resolved', 'Случай уже разобран')
  const allowed = CASE_OPTIONS[row.kind] ?? []
  if (!allowed.includes(body.option)) {
    invalid(`Нет такого варианта: ${body.option}`, { option: body.option })
  }
  const resolution: Record<string, unknown> = { option: body.option }
  if (body.option === 'ignore' || body.option === 'reserve') {
    if (!body.reason) invalid('Нужна причина', { field: 'reason' })
    resolution.reason = body.reason
  }
  if (body.option === 'assign') {
    if (!body.type || !body.number) invalid('Нужны тип и номер', { field: 'type' })
    resolution.type = ITEM_TYPE_INFO[body.type].prefix
    resolution.number = body.number
  }
  // «Пак подрядчику…»: whose pack, by the name «Подрядчики» has (the handoff needs it).
  if (row.kind === 'smm_folder' && body.option === 'pack') {
    if (!body.contractor) invalid('Нужен подрядчик', { field: 'contractor' })
    const { rows: found } = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM contractors
       WHERE model_id = ${modelId}::uuid AND lower(name) = lower(${body.contractor})
         AND archived_at IS NULL`)
    const contractor = found[0]
    if (!contractor) invalid(`Нет такого подрядчика: ${body.contractor}`, { field: 'contractor' })
    resolution.contractor = contractor.name
    resolution.contractor_id = contractor.id
  }
  // «Игнорировать» a name: its unparsed fragments leave the queue with the case.
  const dismissed = body.option === 'ignore'
  await tx.execute(sql`
    UPDATE review_cases
       SET state = ${dismissed ? 'dismissed' : 'resolved'},
           resolution = ${JSON.stringify(resolution)}::jsonb, resolved_at = now(),
           resolved_by = ${actorId}::uuid, row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${caseId}::uuid`)
  if (dismissed && row.source_object_id) {
    await tx.execute(sql`
      UPDATE legacy_claims SET resolution = 'ignored', row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND source_object_id = ${row.source_object_id}::uuid
         AND claim_kind = 'unknown' AND resolution = 'pending'`)
  }
  // A pack whose collection is already imported becomes its handoff now.
  if (row.kind === 'smm_folder' && body.option === 'pack') {
    const { rows: model } = await tx.execute<{ code: string; title: string }>(sql`
      SELECT code, title FROM models WHERE id = ${modelId}::uuid`)
    await importPacks(tx, { id: modelId, code: model[0]?.code ?? '', name: model[0]?.title ?? '' })
  }
  return title
}

/** `POST /{model}/legacy/disputes/{dispute}:resolve`. */
export async function resolveDispute(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  disputeId: string,
  body: ResolveDisputeCommand,
): Promise<void> {
  const [kind, ...rest] = disputeId.split('.')
  let title: string
  if (kind === 'case') title = await resolveCase(tx, modelId, actorId, rest.join('.'), body)
  else if (kind === 'number' || kind === 'typo' || kind === 'trace') {
    title = await resolveNumbers(tx, modelId, actorId, disputeId, body)
  } else if (kind === 'foreign') {
    throw new ApiProblem('accept_blocked', 'Отложено до подключения модели')
  } else notFound()
  await logAction(tx, {
    modelId,
    action: body.option === UNCLEAR ? 'legacy.unclear' : 'legacy.resolve',
    subjectKind: 'legacy',
    subjectLabel: title,
    after: {
      Решение: body.option,
      ...(body.reason ? { Причина: body.reason } : {}),
      ...(body.type && body.number
        ? { Номер: `${ITEM_TYPE_INFO[body.type].prefix}-${body.number}` }
        : {}),
      ...(body.folders
        ? {
            Папки: Object.entries(body.folders)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; '),
          }
        : {}),
    },
  })
}
