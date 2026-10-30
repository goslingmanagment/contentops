import type { UpdateDraftCommand } from '@contentops/contracts/commands/inbox'
import type { LegacyReview } from '@contentops/contracts/domain/legacy'
import { logAction, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { checkVersion, isUuid } from '../commands'
import type { ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { acceptGroup, rejectGroup, reopenGroup } from '../intake/accept'
import { decide, mergeGroups, retryGroup, splitGroup, updateFiles } from '../intake/decisions'
import { ITEM_TO_DB_TYPE, inboxGroup, inboxList } from '../intake/inbox-view'
import { dropStagedOfGroup } from '../intake/staging'
import { createUpload } from '../intake/upload'
import type { Services } from '../services'

/** «Приехало» (DESIGN §4.8–4.10): reading groups and editing the fields of a future object. */

function modelOf(ctx: RequestContext): ModelScope {
  if (!ctx.model) throw new ApiProblem('not_found', 'Такой модели нет')
  return ctx.model
}

function groupId(value: string): string {
  if (!isUuid(value)) throw new ApiProblem('not_found', 'Такой группы нет')
  return value
}

interface LockedGroup {
  id: string
  row_version: string
  title: string | null
}

export async function lockGroup(tx: Tx, modelId: string, id: string): Promise<LockedGroup> {
  const { rows } = await tx.execute<LockedGroup & Record<string, unknown>>(sql`
    SELECT id, row_version, coalesce(proposed_title, group_key) AS title FROM inbox_groups
     WHERE model_id = ${modelId}::uuid AND id = ${id}::uuid FOR UPDATE`)
  const [row] = rows
  if (!row) throw new ApiProblem('not_found', 'Такой группы нет')
  return row
}

/** The fields of the decision panel into the columns of the group (schema §3.4). */
async function writeFields(tx: Tx, modelId: string, id: string, body: UpdateDraftCommand) {
  const sets = []
  if (body.type !== undefined) {
    sets.push(sql`proposed_type = ${body.type ? ITEM_TO_DB_TYPE[body.type] : null}`)
  }
  if (body.title !== undefined) sets.push(sql`proposed_title = ${body.title.trim() || null}`)
  if (body.description !== undefined) {
    sets.push(sql`proposed_description = ${body.description.trim() || null}`)
  }
  if (body.tags !== undefined) sets.push(sql`proposed_tags = ${JSON.stringify(body.tags)}::jsonb`)
  if (body.ppv_kind !== undefined) sets.push(sql`proposed_ppv_kind = ${body.ppv_kind}`)
  if (body.raw_purpose !== undefined) {
    const purpose = body.raw_purpose === 'mailing' ? 'mass_dm' : body.raw_purpose
    sets.push(sql`proposed_purpose = ${purpose}`)
  }
  if (body.second_person !== undefined) sets.push(sql`has_second_person = ${body.second_person}`)
  if (sets.length === 0) return
  await tx.execute(sql`
    UPDATE inbox_groups
       SET ${sql.join(sets, sql`, `)}, updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${id}::uuid`)
}

/** «Разбор старого»: the legacy pass of stage 3 fills it; before that it lists open cases. */
async function legacyReview(services: Services, modelId: string): Promise<LegacyReview> {
  const { rows } = await services.db.execute<{
    id: string
    kind: string
    details: { root?: string; title?: string; fragment?: string } | null
  }>(sql`
    SELECT id, kind, details FROM review_cases
     WHERE model_id = ${modelId}::uuid AND state = 'open'
       AND kind IN ('cross_model_duplicate', 'unreadable_input')
     ORDER BY created_at`)
  return {
    progress: {
      processed_folders: 0,
      total_folders: 0,
      old_names: 0,
      unresolved: rows.length,
      roots: [],
      stalled: null,
    },
    labels: [],
    disputes: rows.map((row) => ({
      id: row.id,
      kind: row.kind === 'cross_model_duplicate' ? 'cross_model' : 'archive_broken',
      root: row.details?.root ?? '',
      title:
        row.details?.title ??
        (row.kind === 'cross_model_duplicate'
          ? 'Такой файл есть у другой модели'
          : 'Архив не читается'),
      fragment: row.details?.fragment ?? null,
      thumbs: [],
      label: null,
      folders: [],
      proposal: null,
      options: [],
      postponed: null,
      resolved: null,
    })),
  }
}

export function inboxHandlers(services: Services): HandlerRegistry {
  const { db, command } = services
  return {
    inbox: {
      list: ({ query, ctx }) => inboxList(db, modelOf(ctx), query.state ?? 'active'),

      get: ({ params, ctx }) => inboxGroup(db, modelOf(ctx), groupId(params.group)),

      update: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          const group = await lockGroup(tx, model.id, id)
          await checkVersion(
            tx,
            ctx,
            {
              version: Number(group.row_version),
              subjectKind: 'inbox_groups',
              subjectId: id,
              field: 'fields',
            },
            () => null,
          )
          await writeFields(tx, model.id, id, body)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: id,
            subjectLabel: group.title ?? id,
            after: body,
          })
          return inboxGroup(tx, model, id)
        }),

      files: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          const group = await lockGroup(tx, model.id, id)
          await checkVersion(
            tx,
            ctx,
            {
              version: Number(group.row_version),
              subjectKind: 'inbox_groups',
              subjectId: id,
              field: 'files',
            },
            () => null,
          )
          await updateFiles(tx, model, id, body)
          return inboxGroup(tx, model, id)
        }),

      accept: async ({ params, body, ctx }) => {
        const model = modelOf(ctx)
        const id = groupId(params.group)
        const result = await command({ ctx, body }, (tx, actor) =>
          acceptGroup(tx, model, actor, id, body),
        )
        await dropStagedOfGroup(services, model.id, id)
        return result
      },

      acceptMany: async ({ body, ctx }) => {
        const model = modelOf(ctx)
        const results = await command({ ctx, body }, async (tx, actor) => {
          const out = []
          for (const raw of body.group_ids) {
            if (!isUuid(raw)) {
              out.push({ id: raw, ok: false, code: 'not_found', accepted: null })
              continue
            }
            try {
              // Each group in its own savepoint: one refusal does not undo the others.
              const accepted = await tx.transaction((inner) =>
                acceptGroup(inner, model, actor, raw, { as: 'default' }),
              )
              out.push({ id: raw, ok: true, code: null, accepted })
            } catch (error) {
              if (!(error instanceof ApiProblem)) throw error
              const reason = (error.details?.reason as string | undefined) ?? error.code
              out.push({ id: raw, ok: false, code: reason, accepted: null })
            }
          }
          return { results: out }
        })
        for (const row of results.results) {
          if (row.ok) await dropStagedOfGroup(services, model.id, row.id)
        }
        return results
      },

      reject: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          const count = await rejectGroup(tx, model, actor, id, body.reason)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: id,
            subjectLabel: 'Отклонено',
            after: { Файлов: String(count), Причина: body.reason ?? '—' },
          })
          return inboxGroup(tx, model, id)
        }),

      restore: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          const count = await reopenGroup(tx, model, id)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: id,
            subjectLabel: 'Возвращено в работу',
            after: { Файлов: String(count) },
          })
          return inboxGroup(tx, model, id)
        }),

      merge: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx)
          const into = await mergeGroups(tx, model, body.group_ids)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: into,
            subjectLabel: 'Слито',
            after: { Групп: String(body.group_ids.length) },
          })
          return inboxGroup(tx, model, into)
        }),

      split: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx)
          const created = await splitGroup(tx, model, groupId(params.group), body.file_keys)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: created,
            subjectLabel: 'Разделено',
            after: { Файлов: String(body.file_keys.length) },
          })
          return inboxGroup(tx, model, created)
        }),

      decide: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          await decide(tx, model, actor, id, body)
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectId: id,
            subjectLabel: 'Решение',
            after: body,
          })
          return inboxGroup(tx, model, id)
        }),

      retry: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx) => {
          const model = modelOf(ctx)
          const id = groupId(params.group)
          await retryGroup(tx, model, id)
          return inboxGroup(tx, model, id)
        }),

      setType: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx)
          const results = []
          for (const raw of body.group_ids) {
            if (!isUuid(raw)) {
              results.push({ id: raw, ok: false, code: 'not_found' })
              continue
            }
            const { rowCount } = await tx.execute(sql`
              UPDATE inbox_groups
                 SET proposed_type = ${ITEM_TO_DB_TYPE[body.type]}, updated_at = now(),
                     row_version = row_version + 1
               WHERE model_id = ${model.id}::uuid AND id = ${raw}::uuid`)
            results.push({ id: raw, ok: (rowCount ?? 0) > 0, code: rowCount ? null : 'not_found' })
          }
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'inbox_groups',
            subjectLabel: `${results.filter((result) => result.ok).length} групп`,
            after: { type: body.type },
          })
          return { results }
        }),

      upload: ({ body, ctx }) => createUpload(services, ctx, body),
    },
    legacy: {
      get: ({ ctx }) => legacyReview(services, modelOf(ctx).id),
    },
  }
}
