import type { Account, Model } from '@contentops/contracts/domain/model'
import { DEFAULT_SURFACES, logAction, type Queryable, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { requireActor } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { withFieldErrors } from './shared'

/** «Модели и страницы» (DESIGN §4.19): модель, её страницы, «Добавить модель», «Добавить страницу». */

interface ModelRow extends Record<string, unknown> {
  id: string
  code: string
  title: string
  title_genitive: string
}

interface AccountRow extends Record<string, unknown> {
  model_id: string
  code: string
  platform: Account['platform']
  title: string
  handle: string
  hub_page_ref: string | null
  default_assignee_id: string | null
  default_uniq_level: Account['uniq_level'] | null
  position: number
}

export async function modelViews(q: Queryable, codes: readonly string[]): Promise<Model[]> {
  if (codes.length === 0) return []
  const { rows } = await q.execute<ModelRow>(sql`
    SELECT id, code, title, title_genitive FROM models
     WHERE code = ANY(${sql.param([...codes])}::text[]) AND archived_at IS NULL ORDER BY id`)
  const { rows: accounts } = await q.execute<AccountRow>(sql`
    SELECT model_id, code, platform, title, handle, hub_page_ref, default_assignee_id,
           default_uniq_level, position
      FROM accounts
     WHERE model_id = ANY(${sql.param(rows.map((row) => row.id))}::uuid[]) AND archived_at IS NULL
     ORDER BY position, id`)
  return rows.map((row) => ({
    code: row.code,
    name: row.title,
    name_genitive: row.title_genitive,
    timezone: 'Europe/Moscow' as const,
    accounts: accounts
      .filter((account) => account.model_id === row.id)
      .map((account) => ({
        code: account.code,
        model: row.code,
        platform: account.platform,
        label: account.title,
        handle: account.handle,
        hub_page: account.hub_page_ref,
        usual_assignee: account.default_assignee_id,
        uniq_level: account.default_uniq_level ?? 'soft',
        position: account.position,
      })),
  }))
}

async function modelView(q: Queryable, code: string): Promise<Model> {
  const [model] = await modelViews(q, [code])
  if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
  return model
}

export function modelHandlers({ db, command }: Services): HandlerRegistry {
  return {
    admin: {
      models: async ({ ctx }) => ({
        items: await modelViews(db, requireActor(ctx).models),
        next_cursor: null,
      }),
    },
    settings: {
      addModel: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const id = await withFieldErrors(
            async () => {
              const { rows } = await tx.execute<{ id: string }>(sql`
                INSERT INTO models (code, title, title_genitive)
                VALUES (${body.code}, ${body.name}, ${body.name}) RETURNING id`)
              return rows[0]?.id
            },
            {
              models_code_key: { field: 'code', message: 'Такой код модели уже есть' },
              models_code_format: { field: 'code', message: 'Неверный код модели' },
              models_code_reserved: { field: 'code', message: 'Этот код занят системой' },
            },
          )
          if (!id) throw new Error('model insert returned nothing')
          // A model added here has no legacy: its counters issue numbers from 1 at once.
          // A model with legacy comes through `bootstrap` with its `legacy` flags.
          for (const type of values.contentTypes) {
            await tx.execute(sql`
              INSERT INTO id_counters (model_id, type, next_number, legacy_reserved_at)
              VALUES (${id}::uuid, ${type}, 1, now())`)
          }
          await logAction(tx, {
            modelId: id,
            subjectKind: 'models',
            subjectId: id,
            subjectLabel: `${body.name} · ${body.code}`,
            after: { Код: body.code, Название: body.name },
          })
          return modelView(tx, body.code)
        }),

      addAccount: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = ctx.model
          if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
          const id = await withFieldErrors(
            async () => {
              const { rows } = await tx.execute<{ id: string }>(sql`
                INSERT INTO accounts (model_id, code, platform, title, handle, position, hub_page_ref)
                SELECT ${model.id}::uuid, ${body.code}, ${body.platform}, ${body.label},
                       ${body.handle}, coalesce(max(position), 0) + 1, ${body.hub_page}
                  FROM accounts WHERE model_id = ${model.id}::uuid
                RETURNING id`)
              return rows[0]?.id
            },
            {
              accounts_code_key: { field: 'code', message: 'Такой код страницы уже есть' },
              accounts_model_id_code_key: {
                field: 'code',
                message: 'Такой код страницы уже есть',
              },
              accounts_code_format: { field: 'code', message: 'Неверный код страницы' },
              accounts_hub_page_ref_key: {
                field: 'hub_page',
                message: 'Эта страница Hub уже привязана',
              },
            },
          )
          if (!id) throw new Error('account insert returned nothing')
          for (const surface of DEFAULT_SURFACES[body.platform]) {
            await tx.execute(sql`
              INSERT INTO surfaces (model_id, account_id, kind, auto_match)
              VALUES (${model.id}::uuid, ${id}::uuid, ${surface.kind}, ${surface.auto_match})`)
          }
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'accounts',
            subjectId: id,
            subjectLabel: `${body.label} · ${body.code}`,
            after: {
              Площадка: body.platform === 'fansly' ? 'Fansly' : 'OnlyFans',
              Ник: body.handle,
              Hub: body.hub_page ?? 'не настроен',
            },
          })
          return modelView(tx, model.code)
        }),
    },
  }
}
