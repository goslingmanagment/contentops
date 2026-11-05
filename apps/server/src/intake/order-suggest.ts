import type { Queryable, Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { openCustomGroups, openOrderFacts, unlinkedCustoms } from '../legacy/customs'
import {
  type Candidate,
  type CustomFacts,
  candidatesOf,
  decide,
  headSeconds,
  type MatchOptions,
} from '../legacy/customs-match'
import { mediaKindOf } from './grouping'

/**
 * Which order a new custom of «Приехало» was made for (PRD §6 п. 2, SPEC §8.2, DESIGN §2.5,
 * §6.1, §6.6). The rule is the import's (`legacy/customs-match.ts`), its words across alphabets
 * («го хард» is «go hard» of the brief):
 *
 * - one order alone matches and nothing speaks against it — an identity (the model's line under
 *   the card is the file's name, the buyer is in it), or the words of the brief together with a
 *   length not shorter than ordered — the order is chosen by itself, with what matched in a hint;
 *   a person links it with «Принять как сдачу», «Принять N» leaves it alone;
 * - that order was delivered and waits for a fix — «похоже на исправление CUS-195»: «Принять как
 *   исправление» makes a new master version and closes the revision;
 * - several orders, or one by words alone without the length — ◆ «Какой заказ?»;
 * - none — no order.
 *
 * It runs when a custom is discovered, when a group becomes a custom, and when an order is made or
 * gets the model's line. What the rule said itself it says again with the new orders (a second
 * order of the same words turns a choice into a question); a person's answer — «Этот заказ»,
 * «Без заказа», an order chosen in the field — ends it for the group.
 */

const OPTIONS: MatchOptions = { acrossAlphabets: true }

interface FileRow extends Record<string, unknown> {
  group_id: string
  draft_id: string
  grouping: string
  title: string | null
  folder: string | null
  order_id: string | null
  blocked: boolean
  path: string | null
  at: string | null
  resource_id: string | null
  duration_ms: string | null
  media_kind: string | null
}

/** What the rule said for a group: the order it chose, the orders it asked about, the fix. */
interface RuleState {
  chosen: string | null
  asked: string[]
  fix: string | null
}

interface IntakeCustom {
  groupId: string
  orderId: string | null
  /** The ◆ «Какой заказ?» is open on its drafts. */
  blocked: boolean
  drafts: string[]
  facts: CustomFacts
  evidence: string[]
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const stem = (name: string) => name.replace(/\.[\p{L}\p{N}]{2,5}$/u, '').trim()

/** Customs of «Приехало» that the import did not bring: open groups of type CUS. */
async function intakeCustoms(q: Queryable, modelId: string): Promise<IntakeCustom[]> {
  const { rows } = await q.execute<FileRow>(sql`
    SELECT g.id AS group_id, d.id AS draft_id, g.grouping, g.proposed_title AS title,
           g.evidence ->> 'path' AS folder, g.custom_order_id AS order_id,
           d.blocked_reason = 'ambiguous_order' AS blocked,
           d.path, r.remote_created_at::text AS at, so.resource_id,
           (SELECT max(p.duration_ms) FROM blob_probes p
             WHERE p.kind = 'ffprobe' AND p.sha256 IN (d.source_sha256, d.master_sha256))::text
             AS duration_ms,
           b.media_kind
      FROM inbox_groups g
      JOIN inbox_drafts d ON d.model_id = g.model_id AND d.group_id = g.id
                         AND d.state IN ('discovered', 'processing', 'ready')
      LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
      LEFT JOIN source_objects so ON so.model_id = r.model_id AND so.id = r.source_object_id
      LEFT JOIN blobs b ON b.sha256 = d.source_blob_sha256
     WHERE g.model_id = ${modelId}::uuid AND g.proposed_type = 'CUS'
       AND NOT coalesce(g.evidence ? 'legacy', false)
     ORDER BY g.id, d.path`)
  const byGroup = Map.groupBy(rows, (row) => row.group_id)
  return [...byGroup.values()].map((files) => {
    const first = files[0] as FileRow
    // A clip is named by its file («6-08 го хард.mov»: the time is its length); a folder of
    // photos by the folder.
    const name =
      first.grouping === 'single' || files.length === 1
        ? stem(baseName(first.path ?? ''))
        : (first.title ?? baseName(first.folder ?? first.path ?? ''))
    const kinds = files.map((file) => file.media_kind ?? mediaKindOf(file.path ?? '', null))
    const durations = files.flatMap((file) =>
      file.duration_ms === null ? [] : [Number(file.duration_ms) / 1000],
    )
    const times = files.flatMap((file) => (file.at ? [new Date(file.at).toISOString()] : []))
    return {
      groupId: first.group_id,
      orderId: first.order_id,
      blocked: files.some((file) => file.blocked),
      drafts: files.map((file) => file.draft_id),
      facts: {
        name,
        durationS: durations.length > 0 ? Math.max(...durations) : headSeconds(name),
        at: times.length > 0 ? (times.sort()[0] as string) : null,
        video: kinds.includes('video'),
        photos: kinds.filter((kind) => kind === 'image').length,
      },
      evidence: [
        ...new Set(files.flatMap((file) => [file.path, file.resource_id].filter(Boolean))),
      ] as string[],
    }
  })
}

/**
 * The order chosen by itself: the rule's link, or the only candidate by the words of its brief
 * when the length was checked against the order (not shorter) and no other open custom has a
 * claim on that order.
 */
function chosenBy(
  custom: IntakeCustom,
  decision: ReturnType<typeof decide>,
  others: readonly CustomFacts[],
): Candidate | null {
  if (decision.kind === 'link') return decision.candidate
  if (decision.kind !== 'ask' || decision.candidates.length !== 1) return null
  const [only] = decision.candidates
  if (!only || only.identity !== null) return null
  const byWords = only.signals.some((signal) => signal.startsWith('в ТЗ:'))
  const length = custom.facts.durationS !== null && only.order.minS !== null
  if (!byWords || !length) return null
  const rival = others.some(
    (other) => other !== custom.facts && candidatesOf(other, [only.order], OPTIONS).length > 0,
  )
  return rival ? null : only
}

/** A video delivered for the order and a revision of it still open: the fix it waits for. */
async function fixOf(
  tx: Tx,
  modelId: string,
  orderId: string,
): Promise<{ itemId: string; revisionId: string; requirement: string } | null> {
  const { rows } = await tx.execute<{ item_id: string; revision_id: string; requirement: string }>(
    sql`
    SELECT d.item_id, r.id AS revision_id, r.requirement
      FROM custom_order_deliveries d
      JOIN custom_order_revisions r ON r.model_id = d.model_id AND r.order_id = d.order_id
                                   AND NOT r.done
     WHERE d.model_id = ${modelId}::uuid AND d.order_id = ${orderId}::uuid AND d.part = 'video'
       AND d.retracts_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries x WHERE x.retracts_id = d.id)
     ORDER BY d.linked_at DESC, r.requested_at DESC LIMIT 1`,
  )
  const row = rows[0]
  return row
    ? { itemId: row.item_id, revisionId: row.revision_id, requirement: row.requirement }
    : null
}

const signalsOf = (candidate: Candidate) =>
  Object.fromEntries(candidate.signals.map((signal) => [signal, true]))

async function writeCandidate(
  tx: Tx,
  modelId: string,
  drafts: readonly string[],
  candidate: Candidate,
  evidence: readonly string[],
  chosen: boolean,
) {
  for (const draft of drafts) {
    await tx.execute(sql`
      INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, order_id, score, signals,
                                          evidence_refs, chosen, chosen_at)
      VALUES (${modelId}::uuid, ${draft}::uuid, 'order', ${candidate.order.id}::uuid,
              ${chosen ? 1 : null}, ${JSON.stringify(signalsOf(candidate))}::jsonb,
              ${JSON.stringify([...candidate.evidence, ...evidence])}::jsonb, ${chosen},
              ${chosen ? sql`now()` : sql`NULL`})
      ON CONFLICT (model_id, draft_id, kind, order_id, item_id, version_id)
      DO UPDATE SET dismissed_at = NULL, chosen = excluded.chosen, chosen_at = excluded.chosen_at,
                    chosen_by = NULL, score = excluded.score, signals = excluded.signals`)
  }
}

interface CandidateRow extends Record<string, unknown> {
  group_id: string
  kind: 'order' | 'existing_item'
  order_id: string | null
  item_id: string | null
  chosen: boolean
  by_person: boolean
  dismissed: boolean
}

/**
 * What the rule said for each custom, or `null` when a person answered: chose an order (in the
 * question or the field), or took «Без заказа» after the rule's candidates.
 */
async function ruleStates(
  tx: Tx,
  modelId: string,
  customs: readonly IntakeCustom[],
): Promise<Map<string, RuleState | null>> {
  const { rows } = await tx.execute<CandidateRow>(sql`
    SELECT d.group_id, c.kind, c.order_id, c.item_id, c.chosen,
           c.chosen_by IS NOT NULL AS by_person, c.dismissed_at IS NOT NULL AS dismissed
      FROM inbox_draft_candidates c
      JOIN inbox_drafts d ON d.model_id = c.model_id AND d.id = c.draft_id
     WHERE c.model_id = ${modelId}::uuid AND c.kind IN ('order', 'existing_item')
       AND d.group_id = ANY (${sql.param(customs.map((custom) => custom.groupId))}::uuid[])
       AND d.state <> 'resolved'`)
  const byGroup = Map.groupBy(rows, (row) => row.group_id)
  const states = new Map<string, RuleState | null>()
  for (const custom of customs) {
    const own = (byGroup.get(custom.groupId) ?? []).filter((row) => !row.dismissed)
    const ruleChosen = own.find((row) => row.kind === 'order' && row.chosen && !row.by_person)
    const personAnswered =
      own.some((row) => row.by_person) ||
      // An order chosen in the field, without the rule.
      (custom.orderId !== null && ruleChosen?.order_id !== custom.orderId) ||
      // «Без заказа» after the rule's question: candidates stay, the question is gone.
      (custom.orderId === null && !custom.blocked && own.length > 0)
    states.set(
      custom.groupId,
      personAnswered
        ? null
        : {
            chosen: ruleChosen?.order_id ?? null,
            asked: own
              .filter((row) => row.kind === 'order' && !row.chosen)
              .map((row) => row.order_id as string)
              .sort(),
            fix: own.find((row) => row.kind === 'existing_item')?.item_id ?? null,
          },
    )
  }
  return states
}

const sameState = (a: RuleState, b: RuleState) =>
  a.chosen === b.chosen && a.fix === b.fix && a.asked.join() === b.asked.join()

/** The rule's own word on a group is taken back before it speaks again. */
async function forget(tx: Tx, modelId: string, custom: IntakeCustom, state: RuleState) {
  await tx.execute(sql`
    UPDATE inbox_draft_candidates SET dismissed_at = now(), chosen = false, chosen_at = NULL
     WHERE model_id = ${modelId}::uuid AND draft_id = ANY (${sql.param(custom.drafts)}::uuid[])
       AND kind IN ('order', 'existing_item') AND dismissed_at IS NULL`)
  if (state.chosen) {
    await tx.execute(sql`
      UPDATE inbox_groups SET custom_order_id = NULL, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${custom.groupId}::uuid
         AND custom_order_id = ${state.chosen}::uuid`)
  }
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ANY (${sql.param(custom.drafts)}::uuid[])
       AND blocked_reason = 'ambiguous_order'`)
}

/**
 * Asks the rule for the customs of «Приехало» a person has not answered — `groupIds` only, or
 * all of them (an order was made or got the model's line). Returns how many changed.
 */
export async function suggestOrders(
  tx: Tx,
  modelId: string,
  groupIds: readonly string[] | null = null,
): Promise<number> {
  const customs = await intakeCustoms(tx, modelId)
  const scope = customs.filter((custom) => groupIds === null || groupIds.includes(custom.groupId))
  if (scope.length === 0) return 0
  const states = await ruleStates(tx, modelId, scope)
  const open = scope.filter((custom) => states.get(custom.groupId) !== null)
  if (open.length === 0) return 0
  const orders = await openOrderFacts(tx, modelId)
  if (orders.length === 0) return 0
  const others = [
    ...customs,
    ...(await openCustomGroups(tx, modelId)),
    ...(await unlinkedCustoms(tx, modelId)),
  ].map((custom) => custom.facts)
  let changed = 0
  for (const custom of open) {
    const decision = decide(custom.facts, orders, others, OPTIONS)
    const chosen = decision.kind === 'none' ? null : chosenBy(custom, decision, others)
    const fix = chosen && custom.facts.video ? await fixOf(tx, modelId, chosen.order.id) : null
    const asked =
      chosen || decision.kind === 'none'
        ? []
        : (decision.kind === 'ask' ? decision.candidates : [decision.candidate]).map(
            (candidate) => candidate.order.id,
          )
    const wanted: RuleState = {
      chosen: chosen?.order.id ?? null,
      asked: [...asked].sort(),
      fix: fix?.itemId ?? null,
    }
    const now = states.get(custom.groupId) as RuleState
    if (sameState(now, wanted)) continue
    changed += 1
    await forget(tx, modelId, custom, now)
    if (decision.kind === 'none') continue
    if (chosen) {
      await writeCandidate(tx, modelId, custom.drafts, chosen, custom.evidence, true)
      await tx.execute(sql`
        UPDATE inbox_groups SET custom_order_id = ${chosen.order.id}::uuid, updated_at = now(),
               row_version = row_version + 1
         WHERE model_id = ${modelId}::uuid AND id = ${custom.groupId}::uuid
           AND custom_order_id IS NULL`)
      if (fix) {
        for (const draft of custom.drafts) {
          await tx.execute(sql`
            INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, order_id, item_id,
                                                score, signals, evidence_refs, chosen, chosen_at)
            VALUES (${modelId}::uuid, ${draft}::uuid, 'existing_item', ${chosen.order.id}::uuid,
                    ${fix.itemId}::uuid, 1,
                    ${JSON.stringify({ revision_id: fix.revisionId, revision: fix.requirement })}::jsonb,
                    ${JSON.stringify(custom.evidence)}::jsonb, true, now())
            ON CONFLICT (model_id, draft_id, kind, order_id, item_id, version_id)
            DO UPDATE SET dismissed_at = NULL, chosen = true, chosen_at = now(), chosen_by = NULL,
                          signals = excluded.signals`)
        }
      }
      continue
    }
    const candidates = decision.kind === 'ask' ? decision.candidates : [decision.candidate]
    for (const candidate of candidates) {
      await writeCandidate(tx, modelId, custom.drafts, candidate, custom.evidence, false)
    }
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = 'ambiguous_order', updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ANY (${sql.param(custom.drafts)}::uuid[])
         AND blocked_reason IS NULL`)
  }
  return changed
}
