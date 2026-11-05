import type { DecideCommand, UpdateDraftFilesCommand } from '@contentops/contracts/commands/inbox'
import type { FileRole } from '@contentops/contracts/domain/files'
import { enqueueWork, type Tx, type values } from '@contentops/db'
import { components } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { splitArchive } from '../legacy/split'
import { lockOrder } from '../orders/writes'
import { acceptGroup, lockGroupForDecision, lockOpenDrafts, rejectGroup } from './accept'
import { channelOfPath } from './discover'
import { queueMedia } from './fetch'
import { bindFrame, ordinalOfHandle, rawFrame } from './frames'
import { placementOf, titleFromFileName } from './grouping'
import { ITEM_TO_DB_TYPE } from './inbox-view'
import { suggestOrders } from './order-suggest'
import { planRow } from './row-upload'
import { acceptRowMontage } from './upload'
import { answerVideoCopy } from './video-copies'

/**
 * The other decisions of «Приехало» (DESIGN §4.8, schema §3.4): merge and split of groups
 * before acceptance, the answers to ◆, roles and order of the files, and «Повторить» after ▲.
 * A group is a proposal with evidence: it changes freely until something is accepted from it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A new manual group of the same source with the fields of `fromId`. */
/** A group of files taken out; the number of the old name stays with the folder's own group. */
async function newManualGroup(
  tx: Tx,
  model: ModelScope,
  fromId: string,
  overrides: { type?: values.ContentType | null; purpose?: values.RawPurpose | null } = {},
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO inbox_groups (
      model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
      proposed_title, proposed_title_en, proposed_description, proposed_tags, proposed_ppv_kind,
      proposed_purpose, has_second_person
    )
    SELECT model_id, source_id, 'split:' || uuidv7()::text, 'manual', folder_object_id,
           (coalesce(evidence, '{}'::jsonb) - 'number' - 'pack') || jsonb_build_object('split_from', id::text),
           ${overrides.type === undefined ? sql`proposed_type` : sql`${overrides.type}`},
           proposed_title, proposed_title_en, proposed_description, proposed_tags,
           proposed_ppv_kind,
           ${overrides.purpose === undefined ? sql`proposed_purpose` : sql`${overrides.purpose}`},
           has_second_person
      FROM inbox_groups WHERE model_id = ${model.id}::uuid AND id = ${fromId}::uuid
    RETURNING id`)
  const id = rows[0]?.id
  if (!id) throw new ApiProblem('not_found', 'Такой группы нет')
  return id
}

async function moveDrafts(tx: Tx, model: ModelScope, ids: readonly string[], groupId: string) {
  await tx.execute(sql`
    UPDATE inbox_drafts SET group_id = ${groupId}::uuid, updated_at = now(),
           row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param([...ids])}::uuid[])
       AND state <> 'resolved'`)
}

async function bump(tx: Tx, model: ModelScope, groupId: string) {
  await tx.execute(sql`
    UPDATE inbox_groups SET updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
}

/** «Разделить»: the chosen files become a group of their own; returns its id. */
export async function splitGroup(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  keys: readonly string[],
): Promise<string> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const chosen = drafts.filter((draft) => keys.includes(draft.id))
  if (chosen.length !== new Set(keys).size) {
    throw new ApiProblem('invalid_request', 'Таких файлов в группе нет', { file_keys: keys })
  }
  if (chosen.length === drafts.length) {
    throw new ApiProblem('invalid_request', 'Все файлы сразу не выделяются — группа опустеет')
  }
  const created = await newManualGroup(tx, model, groupId)
  await moveDrafts(
    tx,
    model,
    chosen.map((draft) => draft.id),
    created,
  )
  // Too many videos for the type is answered by this split: accepting checks the rule again.
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND group_id = ANY (${sql.param([groupId, created])}::uuid[])
       AND blocked_reason = 'video_in_set' AND state <> 'resolved'`)
  await bump(tx, model, groupId)
  return created
}

/**
 * «Разделить по роликам» (SPEC §6.1): every video becomes a group of its own, the group discovery
 * would have made for it, with the fields of this one and the name of its file. Photos stay
 * here; without photos the first video stays, so the answer to the command is still this group.
 */
async function splitVideos(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  drafts: Awaited<ReturnType<typeof lockOpenDrafts>>,
): Promise<number> {
  const group = await lockGroupForDecision(tx, model, groupId)
  const videos = drafts.filter((draft) => draft.media_kind === 'video')
  const hasPhotos = videos.length < drafts.length
  if (videos.length === 0 || (videos.length === 1 && !hasPhotos)) {
    throw new ApiProblem('invalid_request', 'Разделять нечего: в группе один ролик')
  }
  const titleOf = (draft: (typeof drafts)[number]) =>
    titleFromFileName((draft.path ?? '').split('/').at(-1) ?? '', group.proposed_type)
  const [first, ...rest] = videos
  for (const draft of hasPhotos ? videos : rest) {
    const key = draft.resource_id ? `single:${draft.resource_id}` : `split:${draft.id}`
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (
        model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
        proposed_title, proposed_title_en, proposed_description, proposed_tags, proposed_ppv_kind,
        proposed_purpose, has_second_person
      )
      SELECT model_id, source_id, ${key}, 'single', folder_object_id,
             (coalesce(evidence, '{}'::jsonb) - 'number' - 'pack')
               || jsonb_build_object('path', ${draft.path}::text, 'split_from', id::text),
             proposed_type, ${titleOf(draft)}, proposed_title_en, proposed_description,
             proposed_tags, proposed_ppv_kind, proposed_purpose, has_second_person
        FROM inbox_groups WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid
      ON CONFLICT (model_id, source_id, group_key) DO UPDATE SET updated_at = now()
      RETURNING id`)
    await moveDrafts(tx, model, [draft.id], (rows[0] as { id: string }).id)
  }
  if (!hasPhotos && first) {
    await tx.execute(sql`
      UPDATE inbox_groups
         SET grouping = 'single', proposed_title = ${titleOf(first)},
             evidence = coalesce(evidence, '{}'::jsonb) || jsonb_build_object('path', ${first.path}::text)
       WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
  }
  return hasPhotos ? videos.length : rest.length
}

/**
 * «Разложить по папкам» (SPEC §6.1): a group gathered before the rule of its root — every file
 * goes to the group of the folder right above it, as discovery groups it now: in `9. SMM` a
 * collection of the channel its path names, elsewhere a group of the same type. Files of the
 * group's own folder stay. Returns the number of groups the files went to.
 */
async function splitFolders(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  drafts: Awaited<ReturnType<typeof lockOpenDrafts>>,
): Promise<number> {
  const { rows } = await tx.execute<{
    source_id: string
    root_path: string | null
    folder_object_id: string | null
    root: string | null
    proposed_type: values.ContentType | null
    proposed_purpose: values.RawPurpose | null
  }>(sql`
    SELECT g.source_id, s.root_path, g.folder_object_id, g.evidence ->> 'root' AS root,
           g.proposed_type, g.proposed_purpose
      FROM inbox_groups g JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
     WHERE g.model_id = ${model.id}::uuid AND g.id = ${groupId}::uuid`)
  const group = rows[0]
  if (!group) throw new ApiProblem('not_found', 'Такой группы нет')
  const byFolder = new Map<string, string[]>()
  for (const draft of drafts) {
    const cut = draft.path?.lastIndexOf('/') ?? -1
    if (!draft.path || cut <= 0) continue
    const folder = draft.path.slice(0, cut)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), draft.id])
  }
  const depth = components(group.root_path ?? '').length
  let made = 0
  for (const [path, ids] of byFolder) {
    const { rows: found } = await tx.execute<{ id: string; resource_id: string; name: string }>(sql`
      SELECT id, resource_id, current_name AS name FROM source_objects
       WHERE model_id = ${model.id}::uuid AND source_id = ${group.source_id}::uuid AND is_dir
         AND current_path = ${path} AND resource_id IS NOT NULL AND gone_since IS NULL
       ORDER BY last_seen_at DESC LIMIT 1`)
    const folder = found[0]
    if (!folder || folder.id === group.folder_object_id) continue
    const relative = components(path).slice(depth)
    const placement = placementOf([...relative, ''], false)
    const kind = placement.kind === 'folder' ? placement.proposal : undefined
    const channel = kind?.channelFrom ? await channelOfPath(tx, model.id, kind.channelFrom) : null
    const type = kind?.channelFrom ? (channel ? 'PRM' : 'RAW') : (kind?.type ?? group.proposed_type)
    const purpose = kind?.channelFrom
      ? channel
        ? null
        : 'fyp'
      : (kind?.purpose ?? group.proposed_purpose)
    const evidence = {
      root: relative[0] ?? group.root,
      path,
      split_from: groupId,
      ...(channel ? { promo: { channel: channel.name, folder: path } } : {}),
    }
    const { rows: made_ } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (
        model_id, source_id, group_key, grouping, folder_object_id, evidence, proposed_type,
        proposed_title, proposed_purpose, proposed_channel_id
      ) VALUES (
        ${model.id}::uuid, ${group.source_id}::uuid, ${`folder:${folder.resource_id}`}, 'folder',
        ${folder.id}::uuid, ${JSON.stringify(evidence)}::jsonb, ${type}, ${folder.name},
        ${purpose}, ${channel?.id ?? null}::uuid
      )
      ON CONFLICT (model_id, source_id, group_key) DO UPDATE SET updated_at = now()
      RETURNING id`)
    await moveDrafts(tx, model, ids, (made_[0] as { id: string }).id)
    made += 1
  }
  if (made === 0) {
    throw new ApiProblem('invalid_request', 'Раскладывать нечего: все файлы в папке группы')
  }
  return made
}

/** «Слить»: the open files of the other groups join the first one. */
export async function mergeGroups(
  tx: Tx,
  model: ModelScope,
  groupIds: readonly string[],
): Promise<string> {
  const ids = [...new Set(groupIds)]
  if (ids.length < 2 || ids.some((id) => !UUID.test(id))) {
    throw new ApiProblem('invalid_request', 'Нужно две группы или больше')
  }
  // Locks in id order: two merges never deadlock.
  for (const id of [...ids].sort()) await lockGroupForDecision(tx, model, id)
  const [into, ...rest] = ids as [string, ...string[]]
  for (const id of rest) {
    const drafts = await lockOpenDrafts(tx, model, id)
    await moveDrafts(
      tx,
      model,
      drafts.map((draft) => draft.id),
      into,
    )
    await bump(tx, model, id)
  }
  await bump(tx, model, into)
  return into
}

const DB_ROLE: Record<FileRole, values.AssetRole | null> = {
  master: 'master',
  teaser: 'teaser',
  photo: 'pic',
  clip: 'clip',
  raw: 'raw',
  montage: 'master',
  source: 'raw',
  promo_link: null,
}

/** Roles and order of the files: the proposal the accept follows when it fits the type. */
export async function updateFiles(
  tx: Tx,
  model: ModelScope,
  groupId: string,
  body: UpdateDraftFilesCommand,
): Promise<void> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const known = new Set(drafts.map((draft) => draft.id))
  const unknown = [...(body.roles ?? []).map((row) => row.key), ...(body.order ?? [])].filter(
    (key) => !known.has(key),
  )
  if (unknown.length > 0)
    throw new ApiProblem('invalid_request', 'Таких файлов в группе нет', { keys: unknown })
  for (const { key, role } of body.roles ?? []) {
    await tx.execute(sql`
      UPDATE inbox_drafts SET proposed_role = ${DB_ROLE[role]}, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${key}::uuid`)
  }
  for (const [index, key] of (body.order ?? []).entries()) {
    await tx.execute(sql`
      UPDATE inbox_drafts SET proposed_ordinal = ${index + 1}, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${key}::uuid`)
  }
  await bump(tx, model, groupId)
}

/**
 * The order of a group: ◆ «Какой заказ?» or the field «Заказ» of a custom (DESIGN §4.8, §6.6).
 * The order is found by its address (`tg-…`, as the orders API gives it) or its stored id; an
 * unknown one is 404, never a failed cast. With an order the group becomes its CUS, the
 * chosen candidate is marked, and «Принять как сдачу» records the delivery (schema §9.2).
 * `null` — «Без заказа». The group and its open drafts are locked by the caller, who also
 * moves the group's version.
 */
export async function chooseOrder(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  address: string | null,
  draftIds: readonly string[],
): Promise<void> {
  const orderId = address === null ? null : (await lockOrder(tx, model, address)).id
  await tx.execute(sql`
    UPDATE inbox_groups SET custom_order_id = ${orderId}::uuid,
           proposed_type = CASE WHEN ${orderId}::uuid IS NULL THEN proposed_type ELSE 'CUS' END
     WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
  // A person's answer ends the order the system chose (SPEC §8.2): another order or «Без
  // заказа» takes back its mark and its «похоже на исправление»; the same order becomes theirs.
  await tx.execute(sql`
    UPDATE inbox_draft_candidates SET chosen = false, chosen_at = NULL, chosen_by = NULL
     WHERE model_id = ${model.id}::uuid AND draft_id = ANY (${sql.param([...draftIds])}::uuid[])
       AND kind = 'order' AND chosen AND order_id IS DISTINCT FROM ${orderId}::uuid`)
  await tx.execute(sql`
    UPDATE inbox_draft_candidates SET dismissed_at = now()
     WHERE model_id = ${model.id}::uuid AND draft_id = ANY (${sql.param([...draftIds])}::uuid[])
       AND kind = 'existing_item' AND dismissed_at IS NULL
       AND order_id IS DISTINCT FROM ${orderId}::uuid`)
  if (orderId) {
    await tx.execute(sql`
      UPDATE inbox_draft_candidates SET chosen = true, chosen_at = now(), chosen_by = ${actor.id}::uuid
       WHERE model_id = ${model.id}::uuid AND draft_id = ANY (${sql.param([...draftIds])}::uuid[])
         AND kind = 'order' AND order_id = ${orderId}::uuid
         AND (NOT chosen OR chosen_by IS NULL)`)
  }
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param([...draftIds])}::uuid[])
       AND blocked_reason = 'ambiguous_order'`)
}

/**
 * A type a person chose answers ◆ «Что это?» (`needs_type`) wherever it is chosen: the ◆ itself,
 * the field «Тип» of the panel or «Тип» of a batch. The import's question on a group of the old
 * corpus (`legacy/doubt.ts`) is settled by it too.
 */
export async function answerType(tx: Tx, modelId: string, groupIds: readonly string[]) {
  if (groupIds.length === 0) return
  await tx.execute(sql`
    UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND group_id = ANY (${sql.param([...groupIds])}::uuid[])
       AND blocked_reason = 'needs_type' AND state <> 'resolved'`)
}

/** Answers to ◆ «нужно решение». */
export async function decide(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  groupId: string,
  body: DecideCommand,
): Promise<void> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  const ids = drafts.map((draft) => draft.id)
  const clear = async (reason: values.DraftBlockedReason) => {
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = NULL, updated_at = now(), row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ANY (${sql.param(ids)}::uuid[])
         AND blocked_reason = ${reason}`)
  }
  switch (body.decision) {
    case 'what_is_it':
      await tx.execute(sql`
        UPDATE inbox_groups SET proposed_type = ${ITEM_TO_DB_TYPE[body.type]}
         WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
      await answerType(tx, model.id, [groupId])
      if (body.type === 'custom') await suggestOrders(tx, model.id, [groupId])
      break
    case 'which_order':
      await chooseOrder(tx, model, actor, groupId, body.order_id, ids)
      break
    case 'split_videos':
      await splitVideos(tx, model, groupId, drafts)
      await clear('video_in_set')
      break
    case 'split_folders':
      await splitFolders(tx, model, groupId, drafts)
      break
    case 'video_in_set': {
      const videos = drafts.filter((draft) => draft.media_kind === 'video').map((draft) => draft.id)
      if (videos.length === 0) throw new ApiProblem('invalid_request', 'Видео в группе нет')
      if (body.destination === 'reject') {
        const split = await newManualGroup(tx, model, groupId)
        await moveDrafts(tx, model, videos, split)
        await rejectGroup(tx, model, actor, split, 'видео среди фото')
      } else {
        const type = { raw: 'RAW', life: 'LIFE', fyp_source: 'RAW', separate: null } as const
        await moveDrafts(
          tx,
          model,
          videos,
          await newManualGroup(tx, model, groupId, {
            type: type[body.destination],
            purpose:
              body.destination === 'fyp_source'
                ? 'fyp'
                : body.destination === 'raw'
                  ? 'unknown'
                  : null,
          }),
        )
      }
      await clear('video_in_set')
      break
    }
    case 'cross_model':
      if (!body.keep) {
        await rejectGroup(tx, model, actor, groupId, 'такой файл есть у другой модели')
      } else {
        await clear('cross_model_dup')
      }
      await tx.execute(sql`
        UPDATE review_cases
           SET state = ${body.keep ? 'resolved' : 'dismissed'}, resolved_at = now(),
               resolved_by = ${actor.id}::uuid, resolution = ${JSON.stringify({ keep: body.keep })}::jsonb,
               row_version = row_version + 1
         WHERE model_id = ${model.id}::uuid AND kind = 'cross_model_duplicate' AND state = 'open'
           AND draft_id = ANY (${sql.param(ids)}::uuid[])`)
      break
    case 'number_taken': {
      // «Номер занят» (SPEC §6.4): an old number another folder holds. Keep — the block lifts
      // and the object takes the next number of the counter; no — the group is refused.
      const disputed = drafts.filter((draft) => draft.blocked_reason === 'id_collision')
      if (disputed.length === 0) {
        throw new ApiProblem('accept_blocked', 'В этой группе нет спора о номере', {
          reason: 'no_dispute',
        })
      }
      if (body.keep) {
        await clear('id_collision')
        // The old name's number is not claimed again: the next acceptance would hit it anew.
        await tx.execute(sql`
          UPDATE inbox_groups SET evidence = evidence - 'number'
           WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid AND evidence ? 'number'`)
      } else await rejectGroup(tx, model, actor, groupId, 'номер занят другой папкой')
      break
    }
    case 'which_frame': {
      const draft = drafts.find(
        (candidate) => candidate.id === body.file_key && candidate.blocked_reason === 'which_frame',
      )
      if (!draft?.target_item_id) {
        throw new ApiProblem('accept_blocked', 'У этого файла нет вопроса «К какому кадру?»', {
          reason: 'no_frame_question',
        })
      }
      const ordinal = ordinalOfHandle(body.frame)
      if (!(await rawFrame(tx, model.id, draft.target_item_id, ordinal))) {
        throw new ApiProblem('invalid_request', 'Такого кадра в сете нет', { frame: body.frame })
      }
      await bindFrame(tx, model.id, draft.id, ordinal)
      // The last answer accepts the files into the set, as the upload itself would have.
      const open = drafts.filter((other) => other.id !== draft.id && other.blocked_reason)
      if (open.length === 0) {
        const { rows } = await tx.execute<{ public_id: string }>(sql`
          SELECT public_item_id(type, number) AS public_id FROM content_items
           WHERE model_id = ${model.id}::uuid AND id = ${draft.target_item_id}::uuid`)
        await acceptGroup(tx, model, actor, groupId, {
          as: 'default',
          how: 'upload',
          role: 'ed',
          extend: { item_id: rows[0]?.public_id as string, role: 'photos' },
        })
      }
      break
    }
    case 'substitute_montage': {
      // ◆ «Подставить монтаж в строку?» (SPEC §7): the montage was uploaded for a row that no
      // longer waits; the answer accepts it and puts it into the row, or keeps it in the catalog.
      const waiting = drafts.filter((draft) => draft.blocked_reason === 'row_changed')
      const { rows: evidence } = await tx.execute<{ row_id: string | null }>(sql`
        SELECT evidence ->> 'plan_row_id' AS row_id FROM inbox_groups
         WHERE model_id = ${model.id}::uuid AND id = ${groupId}::uuid`)
      const rowId = evidence[0]?.row_id
      if (waiting.length === 0 || !rowId) {
        throw new ApiProblem('accept_blocked', 'В этой группе нет монтажа для строки плана', {
          reason: 'no_plan_row',
        })
      }
      await clear('row_changed')
      const row = await planRow(tx, model, rowId, true)
      await acceptRowMontage(tx, model, actor, groupId, row, body.substitute)
      break
    }
    case 'video_copy': {
      // ◆ «Похоже на ролик» (SPEC §6.2): a copy is an alias of the video it is close to; a
      // file of its own goes on with its group.
      const draft = drafts.find((candidate) => candidate.id === body.file_key)
      if (!draft) {
        throw new ApiProblem('invalid_request', 'Такого файла в группе нет', {
          file_key: body.file_key,
        })
      }
      await answerVideoCopy(tx, model, actor, groupId, draft, body.copy)
      break
    }
    case 'split_archive': {
      // The import unpacks an archive once (SPEC §6.3): its parts become groups, or stay one.
      if (!drafts.some((draft) => draft.blocked_reason === 'archive_split')) {
        throw new ApiProblem('accept_blocked', 'В этой группе нет архива с несколькими папками', {
          reason: 'no_archive',
        })
      }
      await splitArchive(tx, model, groupId, body.split)
      break
    }
  }
  await bump(tx, model, groupId)
}

/** «Повторить» after ▲: the fetch (vanished or given up) or the master of the failed drafts again. */
export async function retryGroup(tx: Tx, model: ModelScope, groupId: string): Promise<number> {
  await lockGroupForDecision(tx, model, groupId)
  const drafts = await lockOpenDrafts(tx, model, groupId)
  // Drafts whose last fetch gave up: no bytes yet, the work failed after its attempts.
  const { rows: gaveUp } = await tx.execute<{ id: string }>(sql`
    SELECT d.id FROM inbox_drafts d
     WHERE d.model_id = ${model.id}::uuid AND d.group_id = ${groupId}::uuid
       AND d.state <> 'resolved' AND d.source_sha256 IS NULL AND d.source_revision_id IS NOT NULL
       AND (SELECT w.state FROM work_operations w
             WHERE w.model_id = d.model_id AND w.kind = 'fetch'
               AND w.source_revision_id = d.source_revision_id
             ORDER BY w.created_at DESC LIMIT 1) = 'failed'`)
  const fetchFailed = new Set(gaveUp.map((row) => row.id))
  let queued = 0
  for (const draft of drafts) {
    const failedMaster = draft.blocked_reason === 'master_failed'
    const vanished = draft.blocked_reason === 'source_unavailable'
    if (!failedMaster && !vanished && !fetchFailed.has(draft.id)) continue
    const attempt = `retry-${Date.now()}`
    await tx.execute(sql`
      UPDATE inbox_drafts SET blocked_reason = NULL, error = NULL, updated_at = now(),
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${draft.id}::uuid`)
    if (failedMaster && draft.source_hex) {
      await queueMedia(
        tx,
        model.id,
        draft.id,
        draft.source_hex,
        draft.media_kind ?? 'video',
        null,
        attempt,
      )
    } else if (draft.source_revision_id) {
      await enqueueWork(tx, {
        modelId: model.id,
        kind: 'fetch',
        workKey: `fetch:${draft.source_revision_id}:${attempt}`,
        sourceRevisionId: draft.source_revision_id,
        draftId: draft.id,
        priority: 50,
      })
    }
    queued += 1
  }
  if (queued === 0) throw new ApiProblem('invalid_request', 'Повторять нечего')
  await bump(tx, model, groupId)
  return queued
}
