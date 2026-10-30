import { logAction, type Tx, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { acceptGroup } from '../intake/accept'
import { acceptedDuplicate, resolveAlias } from '../intake/fetch'
import { channelOf, importPacks, linkDuplicates } from './promo'
import { collisions, numberUnits } from './review'

/**
 * Acceptance of the old corpus by itself (SPEC §6.3–6.4, DESIGN §4.9 «черновики импорта без
 * спора в «Новое» не попадают»): a group of the import whose files are ready is accepted when
 * nothing about it is in dispute — its type is known from the section, and its old number, if
 * the name claims one, is settled: kept with no other folder on it, or decided by a person
 * (a new number, a typo). Anything else waits in a queue: «Разбор старого» for the number,
 * «Приехало» for a ◆ of acceptance. Fields of the claims go to the object with the origin
 * «импорт»; the claims point at it.
 */

/** Who accepts: the import itself; the journal context names it. */
export const IMPORT_ACTOR: Actor = {
  type: 'agent',
  id: null as unknown as string,
  role: 'manager',
  models: [],
  name: 'импорт',
  gender: null,
  sessionId: null,
  tokenId: null,
}

export interface UnitNumber {
  type: string
  number: number
  claimKey: string
  anchor: string
}

interface GroupRow extends Record<string, unknown> {
  id: string
  closed_at: string | null
  proposed_type: string | null
  proposed_title: string | null
  evidence: {
    legacy?: { unit: string; anchor: string }
    number?: UnitNumber | null
    queue?: string
    promo?: { channel: string | null; folder: string }
  } | null
}

export type AutoOutcome =
  | { kind: 'accepted'; item: string }
  | { kind: 'alias' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'queue'; reason: string }

interface NumberClaim extends Record<string, unknown> {
  id: string
  claim_id: string
  registry_claim_id: string | null
  decision: 'keep' | 'renumber' | 'typo' | 'unclear' | null
  assigned: number | null
  claimed: number
  decided_by: string | null
}

async function numberClaimOf(tx: Tx, modelId: string, unit: UnitNumber) {
  const { rows } = await tx.execute<NumberClaim>(sql`
    SELECT n.id, n.claim_id, n.registry_claim_id, n.decision, n.assigned_number AS assigned,
           n.claimed_number AS claimed, n.decided_by
      FROM legacy_claims c
      JOIN legacy_number_claims n ON n.model_id = c.model_id AND n.claim_id = c.id
     WHERE c.model_id = ${modelId}::uuid AND c.source_object_id = ${unit.anchor}::uuid
       AND c.claim_key = ${unit.claimKey} AND c.resolution <> 'ignored'
     ORDER BY c.created_at DESC LIMIT 1`)
  return rows[0] ?? null
}

/** The number the object gets: kept, the registry's, the counter's (`null`) — or why it waits. */
async function numberFor(
  tx: Tx,
  modelId: string,
  unit: UnitNumber | null | undefined,
): Promise<{ number: number | null; claim: NumberClaim | null } | { queue: string }> {
  if (!unit) return { number: null, claim: null }
  const claim = await numberClaimOf(tx, modelId, unit)
  if (!claim) return { queue: 'number_without_claim' }
  const disputed =
    claim.decision === 'typo' ||
    claim.decision === 'renumber' ||
    [...collisions(await numberUnits(tx, modelId)).values()].some((group) =>
      group.some((u) => u.id === claim.id),
    )
  if (claim.decision === 'unclear' || claim.decision === null) return { queue: 'number_unclear' }
  // §6.4 decided by the rules; what renumbers or corrects a number waits for a person.
  if (disputed && claim.decided_by === null) return { queue: 'number_to_confirm' }
  if (claim.decision === 'renumber') return { number: null, claim }
  return { number: claim.assigned ?? claim.claimed, claim }
}

const BLOCKED = new Set<string>(values.draftBlockedReasons)

/**
 * One group: accepted, an alias of accepted bytes, waiting for its files, or left in a queue
 * with the reason on the group. Runs in a savepoint: a refusal changes nothing else.
 */
export async function autoAcceptGroup(
  tx: Tx,
  model: ModelScope,
  groupId: string,
): Promise<AutoOutcome> {
  const { rows } = await tx.execute<GroupRow>(sql`
    SELECT id, closed_at, proposed_type, proposed_title, evidence FROM inbox_groups
     WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
  const group = rows[0]
  if (!group?.evidence?.legacy) return { kind: 'waiting', reason: 'not_legacy' }
  const { rows: drafts } = await tx.execute<{
    id: string
    state: string
    blocked_reason: string | null
    ready: boolean
    sha: string | null
  }>(sql`
    SELECT id, state, blocked_reason, master_verified_at IS NOT NULL AS ready,
           encode(source_sha256, 'hex') AS sha
      FROM inbox_drafts
     WHERE model_id = ${model.id}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'`)
  // An SMM folder: a collection of its channel (SPEC §6.3); its duplicates are links.
  let channelId: string | null = null
  if (group.proposed_type === 'PRM') {
    channelId = await channelOf(tx, model.id, group.evidence.promo?.channel)
    if (!channelId) return queue(tx, model.id, groupId, 'promo_channel_unknown')
    if (drafts.length === 0) return promoOfDuplicates(tx, model, group, channelId)
  }
  if (drafts.length === 0) return { kind: 'waiting', reason: 'nothing_open' }
  // A file changed in the cloud after the snapshot (SPEC §6.3): the group goes on with the
  // current revision, marked «изменён после снимка»; the frozen one keeps its outcome aside.
  if (await setAsideChanged(tx, model.id, groupId)) return autoAcceptGroup(tx, model, groupId)
  const blocked = drafts.find((d) => d.blocked_reason)
  if (blocked) return { kind: 'queue', reason: blocked.blocked_reason as string }
  // The same bytes as an accepted file (two copies of one archive): an alias, not an object.
  let aliased = 0
  for (const draft of drafts) {
    if (!draft.sha) continue
    const dup = await acceptedDuplicate(tx, model.id, draft.sha)
    if (dup) {
      await resolveAlias(tx, model.id, draft.id, dup, null)
      aliased += 1
    }
  }
  if (aliased === drafts.length) {
    return channelId ? promoOfDuplicates(tx, model, group, channelId) : { kind: 'alias' }
  }
  if (drafts.some((d) => !d.ready)) return { kind: 'waiting', reason: 'not_ready' }
  if (!group.proposed_type) return queue(tx, model.id, groupId, 'needs_type')
  const number = await numberFor(tx, model.id, group.evidence.number)
  if ('queue' in number) return queue(tx, model.id, groupId, number.queue)
  try {
    const result = await tx.transaction((inner) =>
      acceptGroup(inner, model, IMPORT_ACTOR, groupId, {
        as: 'default',
        legacy: { number: number.number, promoChannelId: channelId },
      }),
    )
    await settleClaims(tx, model.id, groupId, result.item_id, number.claim, group.evidence.number)
    if (channelId) {
      const { rows: made } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM content_items
         WHERE model_id = ${model.id}::uuid AND created_from_group_id = ${groupId}::uuid`)
      await linkDuplicates(tx, model, groupId, channelId, made[0]?.id ?? null, null)
      await importPacks(tx, model)
    }
    return { kind: 'accepted', item: result.item_id }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '23505') return markBlocked(tx, model.id, groupId, 'id_collision')
    if (!(error instanceof ApiProblem)) throw error
    const reason = (error.details?.reason as string | undefined) ?? error.code
    if (BLOCKED.has(reason)) return markBlocked(tx, model.id, groupId, reason)
    return queue(tx, model.id, groupId, reason)
  }
}

/**
 * Drafts of frozen revisions whose next revision has a draft: moved to a group of their own
 * (`changed:<revision>`, out of «Новое»), the group remembers the change. `true` — moved some.
 */
async function setAsideChanged(tx: Tx, modelId: string, groupId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string; revision_id: string }>(sql`
    SELECT d.id, d.source_revision_id AS revision_id FROM inbox_drafts d
     WHERE d.model_id = ${modelId}::uuid AND d.group_id = ${groupId}::uuid
       AND d.state <> 'resolved' AND d.blocked_reason = 'source_unavailable'
       AND EXISTS (SELECT 1 FROM source_revisions n
                    JOIN inbox_drafts nd ON nd.model_id = n.model_id AND nd.source_revision_id = n.id
                   WHERE n.model_id = d.model_id AND n.previous_id = d.source_revision_id)`)
  for (const row of rows) {
    const { rows: created } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, evidence)
      SELECT model_id, source_id, ${`changed:${row.revision_id}`}, 'single',
             jsonb_build_object('legacy', evidence -> 'legacy', 'superseded', true,
                                'changed_from', ${groupId}::text)
        FROM inbox_groups WHERE model_id = ${modelId}::uuid AND id = ${groupId}::uuid
      ON CONFLICT (model_id, source_id, group_key) DO UPDATE SET updated_at = now()
      RETURNING id`)
    await tx.execute(sql`
      UPDATE inbox_drafts SET group_id = ${(created[0] as { id: string }).id}::uuid,
             error = 'изменён после снимка', updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${row.id}::uuid`)
    await tx.execute(sql`
      UPDATE inbox_groups
         SET evidence = coalesce(evidence, '{}'::jsonb)
               || jsonb_build_object('changed_after_snapshot',
                    coalesce(evidence -> 'changed_after_snapshot', '[]'::jsonb)
                      || to_jsonb(${row.revision_id}::text)),
             updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${groupId}::uuid`)
  }
  return rows.length > 0
}

/** A folder all of whose files the catalog has: a collection of links only. */
async function promoOfDuplicates(
  tx: Tx,
  model: ModelScope,
  group: GroupRow,
  channelId: string,
): Promise<AutoOutcome> {
  const { rows } = await tx.execute<{ id: string; label: string }>(sql`
    SELECT id, public_item_id(type, number) AS label FROM content_items
     WHERE model_id = ${model.id}::uuid AND created_from_group_id = ${group.id}::uuid`)
  const existing = rows[0]
  const id = await linkDuplicates(
    tx,
    model,
    group.id,
    channelId,
    existing?.id ?? null,
    group.proposed_title,
  )
  if (!id) return { kind: 'waiting', reason: 'nothing_open' }
  await importPacks(tx, model)
  if (existing) return { kind: 'alias' }
  const { rows: made } = await tx.execute<{ label: string }>(sql`
    SELECT public_item_id(type, number) AS label FROM content_items
     WHERE model_id = ${model.id}::uuid AND id = ${id}::uuid`)
  return { kind: 'accepted', item: made[0]?.label ?? '' }
}

async function queue(tx: Tx, modelId: string, groupId: string, reason: string) {
  await tx.execute(sql`
    UPDATE inbox_groups
       SET evidence = coalesce(evidence, '{}'::jsonb) || jsonb_build_object('queue', ${reason}::text),
           updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${groupId}::uuid
       AND evidence ->> 'queue' IS DISTINCT FROM ${reason}`)
  return { kind: 'queue' as const, reason }
}

/** A refusal of acceptance a person answers in «Приехало» (◆), e.g. three videos in a PPV. */
async function markBlocked(tx: Tx, modelId: string, groupId: string, reason: string) {
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = ${reason}, updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'
       AND blocked_reason IS NULL`)
  return queue(tx, modelId, groupId, reason)
}

/**
 * The claims whose useful part went into the object point at it (schema §3.4): the number, the
 * title, the tags, the roles and the registry row of the unit; the number claims get their
 * target; the old number and the folder name become aliases of the object.
 */
async function settleClaims(
  tx: Tx,
  modelId: string,
  groupId: string,
  publicId: string,
  number: NumberClaim | null,
  unit: UnitNumber | null | undefined,
) {
  const { rows } = await tx.execute<{ id: string; anchor: string | null; unit: string | null }>(sql`
    SELECT i.id, g.evidence -> 'legacy' ->> 'anchor' AS anchor,
           g.evidence -> 'legacy' ->> 'unit' AS unit
      FROM content_items i JOIN inbox_groups g ON g.model_id = i.model_id AND g.id = ${groupId}::uuid
     WHERE i.model_id = ${modelId}::uuid AND public_item_id(i.type, i.number) = ${publicId}`)
  const item = rows[0]
  if (!item) return
  await tx.execute(sql`
    UPDATE legacy_claims c
       SET resolution = 'resolved', resolved_item_id = ${item.id}::uuid, resolved_at = now(),
           row_version = c.row_version + 1
     WHERE c.model_id = ${modelId}::uuid AND c.resolution = 'pending'
       AND ((c.claim_kind IN ('title', 'tag', 'role')
             AND (c.source_object_id = ${item.anchor}::uuid
                  OR c.source_object_id IN (
                    SELECT r.source_object_id FROM inbox_drafts d
                      JOIN source_revisions r ON r.model_id = d.model_id
                       AND r.id = d.source_revision_id
                     WHERE d.model_id = ${modelId}::uuid AND d.applied_item_id = ${item.id}::uuid)))
            OR (c.claim_kind = 'number' AND c.source_object_id = ${item.anchor}::uuid
                AND c.claim_key = ${unit?.claimKey ?? null})
            OR c.id = ${number?.registry_claim_id ?? null}::uuid)`)
  if (number) {
    await tx.execute(sql`
      UPDATE legacy_number_claims
         SET target_item_id = ${item.id}::uuid, row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND target_item_id IS NULL
         AND (id = ${number.id}::uuid OR claim_id = ${number.registry_claim_id}::uuid)`)
  }
  const aliases: { kind: string; value: string }[] = []
  if (item.unit)
    aliases.push({ kind: 'legacy_name', value: item.unit.slice(item.unit.lastIndexOf('/') + 1) })
  if (unit) {
    const old = `${unit.type}-${String(unit.number).padStart(unit.type === 'FYP' || unit.type === 'RAW' ? 4 : 3, '0')}`
    if (old !== publicId) aliases.push({ kind: 'legacy_id', value: old })
  }
  for (const alias of aliases) {
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, item_id)
      VALUES (${modelId}::uuid, ${alias.kind}, ${alias.value}, ${item.id}::uuid)
      ON CONFLICT DO NOTHING`)
  }
  await logAction(tx, {
    modelId,
    action: 'legacy.accept',
    subjectKind: 'content_items',
    subjectId: item.id,
    itemId: item.id,
    subjectLabel: publicId,
    after: { Откуда: item.unit ?? '—', 'Старый номер': unit ? `${unit.type}-${unit.number}` : '—' },
  })
}

/** After a draft is ready (the media works) or a number is decided: its group may go now. */
export async function autoAcceptForDraft(tx: Tx, modelId: string, draftId: string) {
  const { rows } = await tx.execute<{ group_id: string; code: string; title: string }>(sql`
    SELECT d.group_id, m.code, m.title FROM inbox_drafts d
      JOIN inbox_groups g ON g.model_id = d.model_id AND g.id = d.group_id
      JOIN models m ON m.id = d.model_id
     WHERE d.model_id = ${modelId}::uuid AND d.id = ${draftId}::uuid AND g.evidence ? 'legacy'`)
  const row = rows[0]
  if (!row) return null
  return autoAcceptGroup(tx, { id: modelId, code: row.code, name: row.title }, row.group_id)
}

/** Groups of the import over these source objects (a decided number): try them again. */
export async function autoAcceptForObjects(
  tx: Tx,
  model: ModelScope,
  objectIds: readonly string[],
) {
  if (objectIds.length === 0) return
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT g.id FROM inbox_groups g
     WHERE g.model_id = ${model.id}::uuid AND g.closed_at IS NULL AND g.evidence ? 'legacy'
       AND (g.evidence -> 'legacy' ->> 'anchor')::uuid = ANY (${sql.param([...objectIds])}::uuid[])`)
  for (const row of rows) await tx.transaction((inner) => autoAcceptGroup(inner, model, row.id))
}
