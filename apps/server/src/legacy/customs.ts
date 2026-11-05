import { randomUUID } from 'node:crypto'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { type Queryable, SYSTEM_ACTOR, setJournalContext, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { mediaKindOf } from '../intake/grouping'
import { linkDelivery } from '../orders/writes'
import {
  type Candidate,
  type CustomFacts,
  decide,
  headSeconds,
  type OrderFacts,
  type OrderLine,
} from './customs-match'

/**
 * Old customs and their orders in the database (SPEC §6.3, §8.2; the rule — `customs-match.ts`).
 * Three moments ask the rule:
 *
 * - a group of `3. Customs` (or a custom of `BG`) of the import is about to be accepted by itself:
 *   one order — the custom is accepted and linked to it; several, or one without identity —
 *   ◆ «Какой заказ?» with the candidates and the group waits for a person; none — accepted alone;
 * - an order is made, or the model's line comes to an order, after the custom was accepted
 *   (the files came first): an accepted custom of the import that the rule links to it is linked;
 * - a repeat of the import: the same for every accepted custom without an order.
 *
 * A custom a person already answered (◆ «Какой заказ?», «Без заказа», «Отвязать…») is not asked
 * again: candidates of its drafts or any delivery of it, even retracted, end the rule for it. A
 * link is a delivery of the order with what matched (`linkDelivery`), written as the import's.
 */

interface OrderRow extends Record<string, unknown> {
  id: string
  buyer_name: string | null
  brief: string
  card_at: string
  duration_min_s: number | null
  ordered_duration_raw: string | null
  expects_video: boolean
  expects_photos: boolean
  photo_count: number | null
  card_text: string | null
  lines: OrderLine[]
}

/** The orders a custom may still be delivered for: open ones, with the card and the model's lines. */
export async function openOrderFacts(q: Queryable, modelId: string): Promise<OrderFacts[]> {
  const { rows } = await q.execute<OrderRow>(sql`
    SELECT o.id, o.buyer_name, o.brief, o.card_at::text AS card_at, o.duration_min_s,
           o.ordered_duration_raw, o.expects_video, o.expects_photos, o.photo_count,
           (SELECT m.excerpt FROM custom_order_messages m
             WHERE m.model_id = o.model_id AND m.order_id = o.id AND m.kind = 'card'
             ORDER BY m.message_at LIMIT 1) AS card_text,
           coalesce((SELECT jsonb_agg(jsonb_build_object('text', m.excerpt, 'ref', m.tg_ref)
                                      ORDER BY m.message_at, m.id)
                       FROM custom_order_messages m
                      WHERE m.model_id = o.model_id AND m.order_id = o.id AND m.kind = 'delivery'),
                    '[]'::jsonb) AS lines
      FROM custom_orders o
     WHERE o.model_id = ${modelId}::uuid AND o.status IN ('open', 'delivered')
     ORDER BY o.card_at, o.id`)
  return rows.map((row) => ({
    id: row.id,
    buyer: row.buyer_name,
    brief: row.brief,
    cardText: row.card_text,
    cardAt: new Date(row.card_at.replace(' ', 'T').replace(/([+-]\d\d)$/u, '$1:00')).toISOString(),
    minS: row.duration_min_s,
    durationRaw: row.ordered_duration_raw,
    wantsVideo: row.expects_video,
    wantsPhotos: row.expects_photos ? (row.photo_count ?? 1) : 0,
    lines: row.lines,
  }))
}

interface FileRow extends Record<string, unknown> {
  key: string
  public_id: string | null
  grouping: string
  unit: string | null
  /** A custom of a folder of the answer (`order_folder`): its files name the order too. */
  order_folder: string | null
  order_id: string | null
  asked: boolean
  path: string | null
  at: string | null
  resource_id: string | null
  duration_ms: string | null
}

export interface OpenCustom {
  /** The group (not accepted yet) or the object (accepted). */
  key: string
  publicId: string | null
  orderId: string | null
  /** A person already answered «Какой заказ?» for it. */
  asked: boolean
  facts: CustomFacts
  /** Paths and resource ids of its files, kept with the delivery. */
  evidence: string[]
}

const stemOf = (path: string) =>
  path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.[\p{L}\p{N}]{2,5}$/u, '')
    .trim()

/** `3. Customs/12:40 гимнастика.mov` → `12:40 гимнастика`; a folder keeps its name. */
function unitName(unit: string, grouping: string): string {
  return grouping === 'single' ? stemOf(unit) : unit.slice(unit.lastIndexOf('/') + 1).trim()
}

/**
 * The other names of a custom of a folder of the answer (`05.10.26 <покупатель> <что>`, `4
 * Видео`): the folder's custom is also called by the names of its files — what the model's reply
 * to the card named (SPEC §6.3); a clip that still is a custom by itself, by its folder.
 */
function otherNames(files: readonly FileRow[], grouping: string): string[] {
  const folder = files[0]?.order_folder
  if (!folder) return []
  if (grouping === 'single') return [folder.slice(folder.lastIndexOf('/') + 1).trim()]
  return [...new Set(files.flatMap((file) => (file.path ? [stemOf(file.path)] : [])))]
}

function customsOf(rows: readonly FileRow[]): OpenCustom[] {
  const byKey = new Map<string, FileRow[]>()
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
  return [...byKey.values()].map((files) => {
    const first = files[0] as FileRow
    const name = unitName(first.unit ?? first.path ?? '', first.grouping)
    const alsoNamed = otherNames(files, first.grouping)
    const kinds = files.map((file) => mediaKindOf(file.path ?? '', null))
    const durations = files.flatMap((file) =>
      file.duration_ms === null ? [] : [Number(file.duration_ms) / 1000],
    )
    const times = files.flatMap((file) => (file.at ? [new Date(file.at).toISOString()] : []))
    return {
      key: first.key,
      publicId: first.public_id,
      orderId: first.order_id,
      asked: files.some((file) => file.asked),
      facts: {
        name,
        ...(alsoNamed.length > 0 ? { alsoNamed } : {}),
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

const FILE_FACTS = sql`
  d.path, r.remote_created_at::text AS at, so.resource_id,
  (SELECT max(p.duration_ms) FROM blob_probes p
    WHERE p.kind = 'ffprobe' AND p.sha256 IN (d.source_sha256, d.master_sha256))::text AS duration_ms`

const FILE_SOURCE = sql`
  LEFT JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
  LEFT JOIN source_objects so ON so.model_id = r.model_id AND so.id = r.source_object_id`

/** Customs of the import not accepted yet: the open groups of type CUS. */
export async function openCustomGroups(q: Queryable, modelId: string): Promise<OpenCustom[]> {
  const { rows } = await q.execute<FileRow>(sql`
    SELECT g.id AS key, NULL AS public_id, g.grouping, g.evidence -> 'legacy' ->> 'unit' AS unit,
           g.evidence -> 'legacy' ->> 'order_folder' AS order_folder,
           g.custom_order_id AS order_id,
           EXISTS (SELECT 1 FROM inbox_draft_candidates c
                    WHERE c.model_id = d.model_id AND c.draft_id = d.id AND c.kind = 'order') AS asked,
           ${FILE_FACTS}
      FROM inbox_groups g
      JOIN inbox_drafts d ON d.model_id = g.model_id AND d.group_id = g.id AND d.state <> 'resolved'
      ${FILE_SOURCE}
     WHERE g.model_id = ${modelId}::uuid AND g.closed_at IS NULL AND g.evidence ? 'legacy'
       AND g.proposed_type = 'CUS'
     ORDER BY g.id, d.path`)
  return customsOf(rows)
}

/**
 * Accepted customs of the import that no order holds: no delivery at all (a retracted one is a
 * person's «not this order») and no answer of a person to «Какой заказ?».
 */
export async function unlinkedCustoms(q: Queryable, modelId: string): Promise<OpenCustom[]> {
  const { rows } = await q.execute<FileRow>(sql`
    SELECT i.id AS key, public_item_id(i.type, i.number) AS public_id, g.grouping,
           g.evidence -> 'legacy' ->> 'unit' AS unit,
           g.evidence -> 'legacy' ->> 'order_folder' AS order_folder, NULL AS order_id,
           EXISTS (SELECT 1 FROM inbox_draft_candidates c JOIN inbox_drafts x
                     ON x.model_id = c.model_id AND x.id = c.draft_id
                    WHERE c.model_id = i.model_id AND x.applied_item_id = i.id AND c.kind = 'order')
             AS asked,
           ${FILE_FACTS}
      FROM content_items i
      JOIN inbox_groups g ON g.model_id = i.model_id AND g.id = i.created_from_group_id
      JOIN inbox_drafts d ON d.model_id = i.model_id AND d.applied_item_id = i.id
                         AND d.outcome IN ('new_item', 'append')
      ${FILE_SOURCE}
     WHERE i.model_id = ${modelId}::uuid AND i.type = 'CUS' AND i.deleted_at IS NULL
       AND g.evidence ? 'legacy'
       AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries x
                        WHERE x.model_id = i.model_id AND x.item_id = i.id)
     ORDER BY i.number, d.path`)
  return customsOf(rows).filter((custom) => !custom.asked)
}

export type GroupOrder =
  | { kind: 'link'; candidate: Candidate; evidence: string[] }
  | { kind: 'ask' }
  | { kind: 'none' }

/**
 * The order of a group of the import before it is accepted by itself; `ask` has written the
 * question: the candidates of its drafts and the block «Какой заказ?».
 */
export async function orderForGroup(tx: Tx, modelId: string, groupId: string): Promise<GroupOrder> {
  const groups = await openCustomGroups(tx, modelId)
  const own = groups.find((group) => group.key === groupId)
  if (!own || own.orderId || own.asked) return { kind: 'none' }
  const orders = await openOrderFacts(tx, modelId)
  const others = [...groups, ...(await unlinkedCustoms(tx, modelId))].map((one) => one.facts)
  const decision = decide(own.facts, orders, others)
  if (decision.kind === 'link') {
    return { kind: 'link', candidate: decision.candidate, evidence: own.evidence }
  }
  if (decision.kind === 'none') return { kind: 'none' }
  const { rows: drafts } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM inbox_drafts
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'`)
  for (const draft of drafts) {
    for (const candidate of decision.candidates) {
      await tx.execute(sql`
        INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, order_id, signals,
                                            evidence_refs)
        VALUES (${modelId}::uuid, ${draft.id}::uuid, 'order', ${candidate.order.id}::uuid,
                ${JSON.stringify(Object.fromEntries(candidate.signals.map((s) => [s, true])))}::jsonb,
                ${JSON.stringify(candidate.evidence)}::jsonb)
        ON CONFLICT DO NOTHING`)
    }
  }
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = 'ambiguous_order', updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND state <> 'resolved'
       AND blocked_reason IS NULL`)
  return { kind: 'ask' }
}

/**
 * The journal names the import as the author of a link, also inside a person's request (an
 * order made after its custom): the context is switched for `fn` and given back.
 */
async function asImport<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const { rows } = await tx.execute<{
    type: string
    id: string
    label: string
    action: string
    request_id: string
    item_id: string
    work_id: string
  }>(sql`
    SELECT current_setting('app.actor_type', true) AS type, current_setting('app.actor_id', true) AS id,
           current_setting('app.actor_label', true) AS label, current_setting('app.action', true) AS action,
           current_setting('app.request_id', true) AS request_id,
           current_setting('app.item_id', true) AS item_id, current_setting('app.work_id', true) AS work_id`)
  const was = rows[0]
  const requestId = was?.request_id || randomUUID()
  const workId = was?.work_id || undefined
  await setJournalContext(tx, {
    actor: SYSTEM_ACTOR('импорт'),
    action: 'legacy.order',
    requestId,
    ...(workId ? { workId } : {}),
  })
  const result = await fn()
  if (was?.type && was.label && was.action) {
    await setJournalContext(tx, {
      actor: {
        type: was.type as 'human' | 'agent' | 'system',
        id: was.id || null,
        label: was.label,
      },
      action: was.action,
      requestId,
      ...(was.item_id ? { itemId: was.item_id } : {}),
      ...(workId ? { workId } : {}),
    })
  }
  return result
}

/** The custom is a delivery of the order: what matched, the line and the files as evidence. */
export async function linkCustom(
  tx: Tx,
  model: ModelScope,
  publicId: string,
  candidate: Candidate,
  evidence: readonly string[],
  actor: Actor,
): Promise<void> {
  await asImport(tx, () =>
    linkDelivery(
      tx,
      model,
      candidate.order.id,
      {
        item_id: publicId as ItemId,
        matched: candidate.signals,
        evidence: [...candidate.evidence, ...evidence],
      },
      actor,
    ),
  )
}

/**
 * Accepted customs of the import without an order, linked where the rule finds one order; with
 * `orderId` — only to that order (it was just made, or got the model's line). Returns how many.
 */
export async function attachAcceptedCustoms(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  orderId: string | null = null,
): Promise<number> {
  const items = await unlinkedCustoms(tx, model.id)
  if (items.length === 0) return 0
  const orders = await openOrderFacts(tx, model.id)
  if (orders.length === 0) return 0
  const others = [...items, ...(await openCustomGroups(tx, model.id))].map((one) => one.facts)
  let linked = 0
  for (const item of items) {
    const decision = decide(item.facts, orders, others)
    if (decision.kind !== 'link' || !item.publicId) continue
    if (orderId !== null && decision.candidate.order.id !== orderId) continue
    await linkCustom(tx, model, item.publicId, decision.candidate, item.evidence, actor)
    linked += 1
  }
  return linked
}
