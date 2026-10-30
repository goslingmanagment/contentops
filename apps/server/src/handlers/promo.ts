import { CONTRACTOR_FORMAT_LABEL } from '@contentops/contracts/domain/promo'
import { logAction } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { checkVersion } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { currentDigests } from '../media/pipeline'
import {
  channelContents,
  channelList,
  collectionView,
  contractorOf,
  contractorRows,
  findChannel,
  findContractor,
  handoffOf,
  handoffsOf,
  overlapOf,
} from '../promo/views'
import { addToCollection, markSent, prepareHandoff, removeFromCollection } from '../promo/writes'
import type { Services } from '../services'
import { withFieldErrors } from './shared'

/**
 * «Промо» (SPEC §7.1, DESIGN §4.17): channel folders, collections of links, handoffs to
 * contractors; contractors with their format in «Настройки › Модели и страницы» (§4.19).
 */

const NAME_TAKEN = {
  contractors_name: { field: 'name', message: 'Такой подрядчик у модели уже есть' },
}

function statusUrl(model: string, id: string): string {
  return `/api/v1/${model}/operations/${id}`
}

export function promoHandlers({ db, command }: Services): HandlerRegistry {
  return {
    promo: {
      channels: async ({ ctx }) => ({
        items: await channelList(db, modelOf(ctx.model)),
        next_cursor: null,
      }),
      channel: ({ params, ctx }) => channelContents(db, modelOf(ctx.model), params.channel),
      collection: ({ params, ctx }) => collectionView(db, modelOf(ctx.model), params.collection),
      add: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const id = await addToCollection(tx, model, body, actor)
          return collectionView(tx, model, id)
        }),
      remove: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          await removeFromCollection(tx, model, params.collection, body.members)
          return collectionView(tx, model, params.collection)
        }),
      handoffCheck: ({ params, query, ctx }) =>
        overlapOf(db, modelOf(ctx.model), params.collection, query.contractor),
      prepareHandoff: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const digests = (await currentDigests(tx)) ?? {
            version: '',
            platform: '',
            platformStripped: '',
          }
          const started = await prepareHandoff(tx, model, params.collection, body, actor, digests)
          return {
            kind: 'operation' as const,
            operation_id: started.workId,
            status_url: statusUrl(model.code, started.workId),
            handoff_id: started.handoffId,
          }
        }),
      markSent: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const id = await markSent(tx, model, params.collection, params.handoff, actor)
          const handoff = await handoffOf(tx, model, id)
          if (!handoff) throw new ApiProblem('not_found', 'Такой передачи нет')
          return handoff
        }),
      handoffs: async ({ ctx }) => ({
        items: (await handoffsOf(db, modelOf(ctx.model))).reverse(),
        next_cursor: null,
      }),
      contractors: async ({ ctx }) => ({
        items: (await contractorRows(db, modelOf(ctx.model))).map(contractorOf),
        next_cursor: null,
      }),
    },

    settings: {
      addContractor: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const channel = body.channel ? await findChannel(tx, model, body.channel) : null
          const { rows } = await withFieldErrors(
            () =>
              tx.execute<{ id: string }>(sql`
                INSERT INTO contractors (model_id, name, contact, channel_id, format, created_by)
                VALUES (${model.id}::uuid, ${body.name}, ${body.contact || null},
                        ${channel?.id ?? null}::uuid, ${body.format}, ${actor.id}::uuid)
                RETURNING id`),
            NAME_TAKEN,
          )
          const id = rows[0]?.id as string
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'contractors',
            subjectId: id,
            subjectLabel: body.name,
            after: [
              ['Подрядчик', body.name],
              ['Канал', channel?.title ?? 'любой'],
              ['Формат', CONTRACTOR_FORMAT_LABEL[body.format]],
            ],
          })
          return contractorOf(await findContractor(tx, model, id))
        }),
      updateContractor: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const current = await findContractor(tx, model, params.contractor)
          await checkVersion(
            tx,
            ctx,
            {
              version: current.row_version,
              subjectKind: 'contractors',
              subjectId: current.id,
              field: 'format',
            },
            () => current.format,
          )
          if (current.format !== body.format) {
            await tx.execute(sql`
              UPDATE contractors
                 SET format = ${body.format}, updated_at = now(), row_version = row_version + 1
               WHERE model_id = ${model.id}::uuid AND id = ${current.id}::uuid`)
            await logAction(tx, {
              modelId: model.id,
              subjectKind: 'contractors',
              subjectId: current.id,
              subjectLabel: current.name,
              before: [['Формат', CONTRACTOR_FORMAT_LABEL[current.format]]],
              after: [['Формат', CONTRACTOR_FORMAT_LABEL[body.format]]],
            })
          }
          return contractorOf(await findContractor(tx, model, current.id))
        }),
    },
  }
}
